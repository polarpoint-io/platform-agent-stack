// Slack front door, over Socket Mode.
//
// Socket Mode rather than the Events API because this estate is entirely
// tailnet-private - every vanity hostname resolves to 100.64/10 and nothing is
// publicly reachable. The Events API needs somewhere public for Slack to POST
// to; Socket Mode dials OUT over a WebSocket, so it needs no ingress, no
// public DNS and no inbound request-signature verification. The bridge already
// has egress (it reaches Anthropic and PyPI), so this works as-is.
//
// Two tokens, and they are different things:
//   SLACK_APP_TOKEN  xapp-..., scope connections:write - opens the socket
//   SLACK_BOT_TOKEN  xoxb-..., scopes app_mentions:read, chat:write,
//                    reactions:write, and channels|groups:history
//
// Requires @slack/bolt. Loaded lazily so the bridge runs without it installed
// when chatProvider is none - which is the default.

import { canApprove } from "./index.js";
import { summariseJob, pendingApprovalsIn } from "./format.js";

// Slack user id -> email. users.info is rate limited (tier 4) and a person's
// address does not change mid-incident, so resolving it once per process is
// enough. A miss is cached as null too, otherwise a user whose email is hidden
// costs an API call on every single message.
const emailCache = new Map();

async function resolveEmail(client, userId) {
  if (!userId) return null;
  if (emailCache.has(userId)) return emailCache.get(userId);
  let email = null;
  try {
    const r = await client.users.info({ user: userId });
    email = r?.user?.profile?.email || null;
  } catch (e) {
    // Almost always missing_scope (users:read.email) or a guest whose profile
    // is restricted. Not fatal - the agent falls back to asking, which is what
    // it did before this existed.
    console.warn(`[chat/slack] could not resolve email for ${userId}: ${e.message}`);
  }
  emailCache.set(userId, email);
  return email;
}

/**
 * Prior turns in this thread, oldest first, as "Name: text" lines.
 *
 * Without this every mention is a standalone job: the agent asks a clarifying
 * question, the human answers, and the answer arrives with no idea what it is
 * answering. That made follow-up questions actively misleading - the bot would
 * invite a reply it could not act on.
 */
async function threadTranscript(client, channel, threadTs, botUserId, excludeTs) {
  if (!threadTs) return [];
  try {
    const r = await client.conversations.replies({ channel, ts: threadTs, limit: 30 });
    return (r.messages || [])
      .filter((m) => m.ts !== excludeTs && (m.text || "").trim())
      .map((m) => {
        const who = m.user === botUserId || m.bot_id ? "assistant" : "user";
        return `${who}: ${String(m.text).replace(/<@[^>]+>\s*/g, "").trim()}`;
      });
  } catch (e) {
    // conversations.replies needs channels:history / groups:history. Losing
    // history degrades to the old single-shot behaviour rather than failing.
    console.warn(`[chat/slack] no thread history for ${threadTs}: ${e.message}`);
    return [];
  }
}

/** The text the agent actually sees: prior turns, the requester, then the ask. */
export function composePrompt({ transcript, email, text }) {
  const parts = [];
  if (transcript.length) {
    parts.push("Earlier in this thread:", ...transcript, "");
  }
  if (email) {
    // Named explicitly because Freshservice rejects create_ticket without a
    // requester, and the person asking in Slack is the requester. Before this
    // the agent had to stop and ask, every time.
    parts.push(`The person making this request is ${email}. Use that as the requester email for any ticket.`, "");
  }
  parts.push(text);
  return parts.join("\n");
}

export function createSlackAdapter({ config, deps }) {
  const { jobs, executor } = deps;
  let app = null;
  let botUserId = null;

  return {
    name: "slack",

    async start() {
      const { App } = await import("@slack/bolt").catch(() => {
        throw new Error(
          "chatProvider=slack needs @slack/bolt - add it to bridge/package.json"
        );
      });

      app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
      });

      // One path for both entry points: an @mention, and a plain reply in a
      // thread the bot is already part of.
      const accept = async ({ event, client }) => {
        const text = String(event.text || "").replace(/<@[^>]+>\s*/g, "").trim();
        if (!text) return null;

        const threadTs = event.thread_ts || event.ts;
        const [transcript, email] = await Promise.all([
          threadTranscript(client, event.channel, event.thread_ts, botUserId, event.ts),
          resolveEmail(client, event.user),
        ]);

        const id = await jobs.enqueue({
          text: composePrompt({ transcript, email, text }),
          source: {
            type: "slack",
            channel: event.channel,
            // Reply in-thread. Answering in-channel turns a busy incident
            // channel into a wall of agent output.
            threadTs,
            user: event.user,
            userEmail: email,
          },
        });
        return id;
      };

      app.event("app_mention", async ({ event, client }) => {
        // Ignore ourselves and other bots, or a reply can trigger a reply.
        if (event.bot_id || event.subtype === "bot_message") return;

        const id = await accept({ event, client });
        if (!id) return;

        // The visible ack. Bolt has already acknowledged the socket envelope
        // within Slack's 3s window; this tells the human, honestly, that the
        // work is queued rather than done.
        await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" })
          .catch((e) => console.warn(`[chat/slack] could not react: ${e.message}`));
        console.log(`[chat/slack] queued ${id} from ${event.user}`);
      });

      // Plain replies in a thread the bot is already in.
      //
      // Without this the bot could ask a clarifying question but never receive
      // the answer: a reply that does not @mention it raises no app_mention
      // event, so the reply was invisible and the conversation dead-ended. The
      // human sees a question and a bot that then ignores them.
      app.event("message", async ({ event, client }) => {
        // Never react to ourselves or any other bot - that is an easy loop.
        if (event.bot_id || event.subtype || event.user === botUserId) return;
        // Only threads. A channel-level message is not aimed at us.
        if (!event.thread_ts || event.thread_ts === event.ts) return;
        // A mention is handled by app_mention; taking it here as well would
        // queue the same request twice.
        if (botUserId && String(event.text || "").includes(`<@${botUserId}>`)) return;

        // Only join threads we are already part of. Without this check the bot
        // would answer every threaded reply in every channel it sits in.
        const history = await threadTranscript(client, event.channel, event.thread_ts, botUserId, event.ts);
        if (!history.some((l) => l.startsWith("assistant:"))) return;

        const id = await accept({ event, client });
        if (!id) return;
        await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" })
          .catch((e) => console.warn(`[chat/slack] could not react: ${e.message}`));
        console.log(`[chat/slack] queued ${id} from ${event.user} (thread reply)`);
      });

      // Declining is gated by the SAME allowlist as approving. Rejection is a
      // decision too - letting anyone clear another team's parked action would
      // be a denial-of-service on the approval queue, and would put a name on
      // the audit record that had no authority to be there.
      app.action(/^reject:/, async ({ ack, action, body, client }) => {
        await ack();
        const approvalId = action.action_id.slice("reject:".length);
        const user = body.user?.id;
        if (!canApprove(user, config.approvers)) {
          await client.chat.postEphemeral({
            channel: body.channel.id, user,
            text: `You are not on the approver list, so I have not rejected that. Approval id \`${approvalId}\` is still pending.`,
          });
          console.warn(`[chat/slack] refused rejection ${approvalId} from ${user}`);
          return;
        }
        try {
          await executor.reject(approvalId, { actor: user, channel: "slack", reason: "rejected from Slack" });
          await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message?.thread_ts || body.message?.ts,
            text: `Rejected by <@${user}>. Nothing was executed. (\`${approvalId}\`)`,
          });
          console.log(`[chat/slack] ${approvalId} rejected by ${user}`);
        } catch (err) {
          await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message?.thread_ts || body.message?.ts,
            text: `Could not reject \`${approvalId}\`: ${err.message}`,
          });
        }
      });

      app.action(/^approve:/, async ({ ack, action, body, client }) => {
        await ack();
        const approvalId = action.action_id.slice("approve:".length);
        const user = body.user?.id;

        // The identity check the HTTP endpoint never had. An empty allowlist
        // means nobody.
        if (!canApprove(user, config.approvers)) {
          await client.chat.postEphemeral({
            channel: body.channel.id, user,
            text: `You are not on the approver list, so I have not run that. Approval id \`${approvalId}\` is still pending.`,
          });
          console.warn(`[chat/slack] refused approval ${approvalId} from ${user}`);
          return;
        }

        try {
          await executor.approve(approvalId, { actor: user, channel: "slack" });
          await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message?.thread_ts || body.message?.ts,
            text: `Approved by <@${user}> and executed. (\`${approvalId}\`)`,
          });
          console.log(`[chat/slack] ${approvalId} approved by ${user}`);
        } catch (err) {
          // Deliberately says whether it is still pending. A failed approval
          // stays in the queue and can be retried - the approver needs to know
          // that rather than assuming it was consumed.
          await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message?.thread_ts || body.message?.ts,
            text: `Approval \`${approvalId}\` failed: ${err.message}` +
                  (err.stillPending ? " It is still pending, so you can try again." : ""),
          });
        }
      });

      await app.start();

      // Needed before the message handler can tell our own messages apart from
      // a human's, and to spot a mention that app_mention will already handle.
      // If it fails the handler still works, just less precisely: it falls back
      // to bot_id checks, which cover the loop risk.
      try {
        const auth = await app.client.auth.test({ token: config.botToken });
        botUserId = auth?.user_id || null;
        console.log(`[chat/slack] Socket Mode connected as ${auth?.user} (${botUserId})`);
      } catch (e) {
        console.warn(`[chat/slack] auth.test failed, thread replies may be less precise: ${e.message}`);
        console.log("[chat/slack] Socket Mode connected");
      }
    },

    /** Called by the worker when a job finishes, success or failure. */
    async deliver(job) {
      if (job.source?.type !== "slack" || !app) return;
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: summariseJob(job) } },
      ];

      for (const approval of pendingApprovalsIn(job)) {
        blocks.push({
          type: "actions",
          // Reject sits beside Approve deliberately. "Cancel" on the confirm
          // dialog only dismisses the prompt and leaves the action parked, so
          // without this the only way to say NO was to walk away - and the
          // queue filled with decisions nobody had actually made.
          elements: [{
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: `Approve ${approval.verb}` },
            action_id: `approve:${approval.approvalId}`,
            value: approval.approvalId,
            confirm: {
              title: { type: "plain_text", text: `Run ${approval.verb}?` },
              text: { type: "mrkdwn", text: `This is ${approval.tier}. It has not been executed yet.` },
              confirm: { type: "plain_text", text: "Approve" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          }, {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            action_id: `reject:${approval.approvalId}`,
            value: approval.approvalId,
            confirm: {
              title: { type: "plain_text", text: `Reject ${approval.verb}?` },
              text: { type: "mrkdwn", text: "Nothing will be executed. The decision is recorded against your name." },
              confirm: { type: "plain_text", text: "Reject" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          }],
        });
      }

      await app.client.chat.postMessage({
        channel: job.source.channel,
        thread_ts: job.source.threadTs,
        text: summariseJob(job),   // fallback for notifications
        blocks,
      }).catch((e) => console.error(`[chat/slack] could not deliver ${job.id}: ${e.message}`));
    },

    async stop() {
      await app?.stop?.().catch(() => {});
    },
  };
}
