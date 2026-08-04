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

// Some servers don't set isError at all - they catch their own failure
// and hand it back as an ordinary successful result whose text happens
// to be an error message. freshservice-mcp does exactly this:
//   {content:[{type:"text",text:"Error: Either email or requester_id
//    must be provided"}], isError:false}
// Nothing generic can spot that reliably, so the pattern is DECLARED per
// provider as resultIsErrorWhen in itsm-providers/providers/*.mcp.json
// rather than guessed globally - a server without the quirk is untouched.
//
// Deliberately narrow: it only applies when the whole result is a bare
// string. A false positive here is worse than the bug, because it would
// report a SUCCEEDED action as failed and leave it in the approval queue,
// inviting a retry that executes it twice.
function resultIsDeclaredError(result, pattern) {
  if (!pattern) return false;
  const structured = result?.structuredContent?.result;
  const text = typeof structured === "string"
    ? structured
    : (result?.content?.length === 1 && result.content[0]?.type === "text"
        ? result.content[0].text
        : null);
  return typeof text === "string" && pattern.test(text);
}

function assertToolOk(backend, tool, result, pattern) {
  if (result?.isError || resultIsDeclaredError(result, pattern)) {
    throw new ToolCallError(backend, tool, result);
  }
  return result;
}

// resultChecks: { [backendName]: RegExp } - see config.js, which reads
// resultIsErrorWhen out of the merged .mcp.json.
export function createExecutor({ policy, backends, slackWebhookUrl, notifySlack, approvalsStore, resultChecks = {} }) {
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
      await backends.callTool(decision.backend, decision.tool, args),
      resultChecks[decision.backend]
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
        await backends.callTool(pending.decision.backend, pending.decision.tool, pending.args),
        resultChecks[pending.decision.backend]
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
