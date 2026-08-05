// Turning a finished triage job into something readable, shared by every
// adapter so Slack and Teams say the same thing.
//
// Kept free of any platform's markup: adapters render these into Block Kit or
// an Adaptive Card. The strings here are the content, not the presentation.

/** One line summarising what the agents did, for a thread reply. */
export function summariseJob(job) {
  if (job.status === "failed") {
    return `Triage failed: ${job.error || "no reason given"}`;
  }

  const result = job.result || {};
  if (result.lane === "infra_incident") {
    return result.analysis
      ? `Infra incident. ${firstParagraph(result.analysis)}`
      : "Infra incident - Holmes returned no analysis.";
  }

  if (result.lane === "itsm_ticket") {
    const actions = result.actions || [];
    if (!actions.length) {
      return result.reply || "ITSM request - no action was needed.";
    }
    return actions.map(describeAction).join("\n");
  }

  return result.reply || "Could not classify this request.";
}

/**
 * What happened to one action, in the language of the policy.
 *
 * The tier is always named. An approver reading this in a chat client needs to
 * know why they're being asked, and a reader of a tier_1 line needs to know
 * nobody was asked at all.
 */
export function describeAction(action) {
  const verb = action.verb;
  switch (action.action) {
    case "execute":
      return action.notify
        ? `Ran \`${verb}\` (${action.tier}) - executed and notified.`
        : `Ran \`${verb}\` (${action.tier}).`;
    case "park":
      return `\`${verb}\` needs approval (${action.tier}). Nothing has been executed.`;
    case "draft":
      return `\`${verb}\` is draft-only (${action.tier}). A human has to perform it.`;
    case "blocked":
      return `\`${verb}\` is blocked: ${action.reason || "no mapping"}`;
    default:
      return `\`${verb}\`: ${action.action}`;
  }
}

/** Any approvals this job parked, so an adapter can offer buttons for them. */
export function pendingApprovalsIn(job) {
  return (job.result?.actions || []).filter((a) => a.action === "park" && a.approvalId);
}

function firstParagraph(text) {
  const trimmed = String(text || "").trim();
  const [first] = trimmed.split(/\n\s*\n/);
  return (first || trimmed).slice(0, 600);
}
