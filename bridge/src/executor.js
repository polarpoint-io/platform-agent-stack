// The one place every tool call passes through: policy.decide() first,
// then act on the decision. Tier 3 never calls the backend here - it's
// parked and must be explicitly approved via POST /approvals/:id/approve.

import { randomUUID } from "node:crypto";

export function createExecutor({ policy, backends, slackWebhookUrl, notifySlack }) {
  const pendingApprovals = new Map();

  async function execute(verb, args, context = {}) {
    const decision = policy.decide(verb);

    if (decision.action === "blocked") {
      return { ...decision, result: null };
    }

    if (decision.action === "draft") {
      const note = `[draft-only] "${verb}" was requested${context.summary ? ` (${context.summary})` : ""} but tier_4 verbs are never auto-executed. A human needs to perform this action directly.`;
      await notifySlack(slackWebhookUrl, note);
      return { ...decision, result: null, note };
    }

    if (decision.action === "park") {
      const id = randomUUID();
      pendingApprovals.set(id, { verb, args, decision, context, createdAt: new Date().toISOString() });
      const note = `[approval needed] "${verb}"${context.summary ? ` - ${context.summary}` : ""} is waiting for approval. Approve: POST /approvals/${id}/approve`;
      await notifySlack(slackWebhookUrl, note);
      return { ...decision, result: null, approvalId: id, note };
    }

    // tier_1 (silent) or tier_2 (notify) - both execute now.
    const result = await backends.callTool(decision.backend, decision.tool, args);
    if (decision.notify) {
      const note = `[executed] "${verb}" -> ${decision.backend}.${decision.tool}${context.summary ? ` - ${context.summary}` : ""}`;
      await notifySlack(slackWebhookUrl, note);
    }
    return { ...decision, result };
  }

  async function approve(id) {
    const pending = pendingApprovals.get(id);
    if (!pending) {
      throw new Error(`no pending approval with id ${id}`);
    }
    pendingApprovals.delete(id);
    const result = await backends.callTool(pending.decision.backend, pending.decision.tool, pending.args);
    await notifySlack(slackWebhookUrl, `[approved & executed] "${pending.verb}"${pending.context.summary ? ` - ${pending.context.summary}` : ""}`);
    return result;
  }

  function listPending() {
    return [...pendingApprovals.entries()].map(([id, p]) => ({ id, verb: p.verb, args: p.args, createdAt: p.createdAt }));
  }

  return { execute, approve, listPending };
}
