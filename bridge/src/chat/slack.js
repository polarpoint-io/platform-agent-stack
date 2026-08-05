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

export function createSlackAdapter({ config, deps }) {
  const { jobs, executor } = deps;
  let app = null;

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

      app.event("app_mention", async ({ event, client }) => {
        // Ignore ourselves and other bots, or a reply can trigger a reply.
        if (event.bot_id || event.subtype === "bot_message") return;

        const text = String(event.text || "").replace(/<@[^>]+>\s*/g, "").trim();
        if (!text) return;

        const id = await jobs.enqueue({
          text,
          source: {
            type: "slack",
            channel: event.channel,
            // Reply in-thread. Answering in-channel turns a busy incident
            // channel into a wall of agent output.
            threadTs: event.thread_ts || event.ts,
            user: event.user,
          },
        });

        // The visible ack. Bolt has already acknowledged the socket envelope
        // within Slack's 3s window; this tells the human, honestly, that the
        // work is queued rather than done.
        await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" })
          .catch((e) => console.warn(`[chat/slack] could not react: ${e.message}`));
        console.log(`[chat/slack] queued ${id} from ${event.user}`);
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
          await executor.approve(approvalId);
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
      console.log("[chat/slack] Socket Mode connected");
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
