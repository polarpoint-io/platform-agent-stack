// The one place every tool call passes through: policy.decide() first,
// then act on the decision. Tier 3 never calls the backend here - it's
// parked and must be explicitly approved via POST /approvals/:id/approve.

import { randomUUID } from "node:crypto";

// An MCP tool that fails reports it IN the result, as isError, with a
// 200-shaped response - it does not throw. Returning that verbatim made
// a rejected call look like a successful one to every caller: a human
// could approve a tier_3, get HTTP 200 back, and nothing had happened.
// Convert it into a thrown error so the HTTP layer can say so.
export class ToolCallError extends Error {
  constructor(backend, tool, result) {
    const detail = (result?.content || [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    super(`${backend}.${tool} rejected the call: ${detail || "no detail returned"}`);
    this.name = "ToolCallError";
    this.backend = backend;
    this.tool = tool;
    this.result = result;
  }
}

function assertToolOk(backend, tool, result) {
  if (result?.isError) throw new ToolCallError(backend, tool, result);
  return result;
}

export function createExecutor({ policy, backends, slackWebhookUrl, notifySlack, approvalsStore }) {
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
      await approvalsStore.set(id, { verb, args, decision, context, createdAt: new Date().toISOString() });
      const note = `[approval needed] "${verb}"${context.summary ? ` - ${context.summary}` : ""} is waiting for approval. Approve: POST /approvals/${id}/approve`;
      await notifySlack(slackWebhookUrl, note);
      return { ...decision, result: null, approvalId: id, note };
    }

    // tier_1 (silent) or tier_2 (notify) - both execute now.
    const result = assertToolOk(
      decision.backend,
      decision.tool,
      await backends.callTool(decision.backend, decision.tool, args)
    );
    if (decision.notify) {
      const note = `[executed] "${verb}" -> ${decision.backend}.${decision.tool}${context.summary ? ` - ${context.summary}` : ""}`;
      await notifySlack(slackWebhookUrl, note);
    }
    return { ...decision, result };
  }

  async function approve(id) {
    const pending = await approvalsStore.get(id);
    if (!pending) {
      const err = new Error(`no pending approval with id ${id}`);
      err.code = "NO_SUCH_APPROVAL";
      throw err;
    }

    // Execute FIRST, delete only once it worked. Deleting up front threw
    // away the approval whenever the backend rejected the call, so a
    // human's approval was consumed by an attempt that did nothing and
    // there was no way to retry it - the request had to be re-made from
    // scratch, and re-approved.
    let result;
    try {
      result = assertToolOk(
        pending.decision.backend,
        pending.decision.tool,
        await backends.callTool(pending.decision.backend, pending.decision.tool, pending.args)
      );
    } catch (err) {
      await notifySlack(
        slackWebhookUrl,
        `[approval FAILED] "${pending.verb}"${pending.context.summary ? ` - ${pending.context.summary}` : ""}: ${err.message}. Still pending as ${id}.`
      );
      err.approvalId = id;
      err.stillPending = true;
      throw err;
    }

    await approvalsStore.delete(id);
    await notifySlack(slackWebhookUrl, `[approved & executed] "${pending.verb}"${pending.context.summary ? ` - ${pending.context.summary}` : ""}`);
    return result;
  }

  async function listPending() {
    return approvalsStore.list();
  }

  return { execute, approve, listPending };
}
