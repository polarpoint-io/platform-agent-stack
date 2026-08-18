// Microsoft Teams front door, over the Bot Framework.
//
// READ THIS BEFORE CHOOSING TEAMS ON A PRIVATE CLUSTER. Teams has no Socket
// Mode equivalent: the Bot Framework delivers activities by POSTing to a
// public HTTPS messaging endpoint that you host. Slack can dial out; Teams
// cannot. On an estate where every hostname resolves to 100.64/10 and nothing
// is publicly reachable, that means one of:
//
//   * a genuinely public ingress for /api/messages, with the Azure Bot
//     registration pointing at it, or
//   * Tailscale Funnel - which does not work with the L4 tailscale.com/expose
//     pattern this estate uses; it needs an Ingress-class-tailscale resource,
//     which means giving up the cert-manager certificate, or
//   * Azure Relay / a tunnel, which is another moving part to run.
//
// None of that is the bridge's problem to solve, but none of it is free
// either, and it is the reason Slack was the recommended default here.
//
// The adapter itself is deliberately the same shape as the Slack one: ack,
// enqueue, reply from deliver(). The difference is that it registers an
// Express route instead of opening a socket - which is why start() takes the
// app.
//
// Requires botbuilder. Loaded lazily so the bridge runs without it.

import { canApprove } from "./index.js";
import { summariseJob, pendingApprovalsIn } from "./format.js";

export function createTeamsAdapter({ config, deps }) {
  const { jobs, executor } = deps;
  let adapter = null;

  return {
    name: "teams",
    /** Teams is inbound-only, so it needs a route. Slack returns nothing here. */
    needsPublicEndpoint: true,

    async start({ app }) {
      const { CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext } =
        await import("botbuilder").catch(() => {
          throw new Error("chatProvider=teams needs botbuilder - add it to bridge/package.json");
        });

      adapter = new CloudAdapter(
        new ConfigurationBotFrameworkAuthentication({
          MicrosoftAppId: config.appId,
          MicrosoftAppPassword: config.appPassword,
          MicrosoftAppTenantId: config.tenantId,
          MicrosoftAppType: config.appType || "SingleTenant",
        })
      );

      if (!app) {
        throw new Error("the teams adapter needs the express app to register /api/messages");
      }

      app.post("/api/messages", async (req, res) => {
        await adapter.process(req, res, async (context) => {
          if (context.activity.type === "invoke" || context.activity.value?.approvalId) {
            return handleApproval(context, TurnContext);
          }
          if (context.activity.type !== "message") return;

          const text = String(context.activity.text || "")
            .replace(/<at>.*?<\/at>/g, "")
            .trim();
          if (!text) return;

          // The conversation reference goes ON THE JOB, not in a local Map.
          // Teams replies are impossible without it and it cannot be
          // reconstructed from ids, so holding it in memory meant a pod
          // restart silently stranded every in-flight Teams request. It is
          // plain JSON, so it rides along with the job and survives whatever
          // the job store survives.
          const id = await jobs.enqueue({
            text,
            source: {
              type: "teams",
              ref: TurnContext.getConversationReference(context.activity),
              user: context.activity.from?.id,
            },
          });

          // Same honest ack as Slack: queued, not done. The Bot Framework's
          // own 200 has already gone back inside its timeout.
          await context.sendActivity("Queued - I'll reply here when it's done.");
          console.log(`[chat/teams] queued ${id} from ${context.activity.from?.id}`);
        });
      });

      console.log("[chat/teams] listening on POST /api/messages (needs a public endpoint)");
    },

    async deliver(job) {
      if (job.source?.type !== "teams" || !adapter) return;
      const ref = job.source.ref;
      if (!ref) {
        // Only reachable for a job queued by an older build, before the
        // reference was carried on the job.
        console.warn(`[chat/teams] job ${job.id} has no conversation reference - cannot deliver`);
        return;
      }

      const approvals = pendingApprovalsIn(job);
      await adapter.continueConversationAsync(config.appId, ref, async (context) => {
        await context.sendActivity({
          text: summariseJob(job),
          attachments: approvals.length ? [adaptiveCard(job, approvals)] : undefined,
        });
      }).catch((e) => console.error(`[chat/teams] could not deliver ${job.id}: ${e.message}`));
    },

    async stop() {},
  };

  async function handleApproval(context, TurnContext) {
    const approvalId = context.activity.value?.approvalId;
    const user = context.activity.from?.id;
    if (!approvalId) return;

    if (!canApprove(user, config.approvers)) {
      await context.sendActivity(
        `You are not on the approver list, so I have not run that. Approval id ${approvalId} is still pending.`
      );
      console.warn(`[chat/teams] refused approval ${approvalId} from ${user}`);
      return;
    }

    try {
      await executor.approve(approvalId, { actor: user, channel: "teams" });
      await context.sendActivity(`Approved by ${context.activity.from?.name || user} and executed. (${approvalId})`);
    } catch (err) {
      await context.sendActivity(
        `Approval ${approvalId} failed: ${err.message}` +
        (err.stillPending ? " It is still pending, so you can try again." : "")
      );
    }
  }
}

/** Adaptive Card with an Approve button per parked action. */
function adaptiveCard(job, approvals) {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "TextBlock", wrap: true, text: summariseJob(job) },
        ...approvals.map((a) => ({
          type: "TextBlock", wrap: true, isSubtle: true,
          text: `${a.verb} is ${a.tier} and has not been executed.`,
        })),
      ],
      actions: approvals.map((a) => ({
        type: "Action.Submit",
        title: `Approve ${a.verb}`,
        data: { approvalId: a.approvalId },
      })),
    },
  };
}
