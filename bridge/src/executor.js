// The one place every tool call passes through: policy.decide() first,
// then act on the decision. Tier 3 never calls the backend here - it's
// parked and must be explicitly approved via POST /approvals/:id/approve.

import { randomUUID } from "node:crypto";
import { actions as actionsMetric, approvalDecisions, toolCalls, toolDuration } from "./metrics.js";

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
export function createExecutor({ policy, backends, slackWebhookUrl, notifySlack, approvalsStore, decisionsStore = null, resultChecks = {} }) {
  /**
   * Durable record of every tier-3 decision a human made - approved AND
   * rejected - kept after the pending record is deleted.
   *
   * Before this, approving deleted the approval and left a counter and a Slack
   * message, so "who approved this, when, and why" could not be answered from
   * the system itself. A rejection left nothing at all, because there was no
   * way to reject.
   *
   * `actor` is self-asserted over HTTP: a shared bearer token authorises the
   * call but cannot say who sent it. It is recorded as claimed, with the
   * channel alongside, so a reader can tell an authenticated chat identity
   * (Slack validates it) from a name typed into a curl. Better to record a
   * weak name honestly labelled than to record nothing.
   */
  async function auditDecision(id, pending, outcome, { actor, reason, channel, error } = {}) {
    if (!decisionsStore) return;
    try {
      await decisionsStore.set(id, {
        verb: pending.verb,
        tier: pending.decision?.tier,
        backend: pending.decision?.backend,
        tool: pending.decision?.tool,
        args: pending.args,
        summary: pending.context?.summary,
        outcome,
        actor: actor || "unknown",
        actorChannel: channel || "http",
        actorVerified: channel === "slack" || channel === "teams",
        reason: reason || null,
        error: error || null,
        parkedAt: pending.createdAt,
        decidedAt: new Date().toISOString(),
      });
    } catch (err) {
      // An audit write must not swallow the action itself, but silence here
      // would be worse than noise - say so loudly.
      console.error(`[audit] could not record ${outcome} of ${id}: ${err.message}`);
    }
  }

  // Record the decision, not just the call. A tier_3 that parked and a tier_1
  // that ran are both things an operator needs to count, and only one of them
  // ever reaches a backend - so counting backend calls alone would make the
  // gated actions invisible.
  function recordDecision(verb, decision, outcome) {
    actionsMetric.inc({
      verb,
      tier: decision.tier || "unknown",
      action: decision.action || "unknown",
      outcome,
    });
  }

  /** Every backend call, timed and counted, in one place. */
  async function callTimed(backend, tool, args) {
    const started = process.hrtime.bigint();
    let outcome = "success";
    try {
      return await backends.callTool(backend, tool, args);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      toolDuration.observe({ backend, tool }, Number(process.hrtime.bigint() - started) / 1e9);
      toolCalls.inc({ backend, tool, outcome });
    }
  }

  async function execute(verb, args, context = {}) {
    const decision = policy.decide(verb);

    if (decision.action === "blocked") {
      recordDecision(verb, decision, "blocked");
      return { ...decision, result: null };
    }

    if (decision.action === "draft") {
      const note = `[draft-only] "${verb}" was requested${context.summary ? ` (${context.summary})` : ""} but tier_4 verbs are never auto-executed. A human needs to perform this action directly.`;
      await notifySlack(slackWebhookUrl, note);
      recordDecision(verb, decision, "drafted");
      return { ...decision, result: null, note };
    }

    if (decision.action === "park") {
      const id = randomUUID();
      // Store the args an approver will actually see EXECUTED, not the ones the
      // model produced. Injected deployment facts - cloudId, projectKey - are
      // added by mcpBackends at call time, so a parked record showed them as
      // undefined: a human was asked to approve "create a ticket" without being
      // told which project or which Atlassian site it lands in.
      //
      // They are re-applied at call time regardless, so this is for VISIBILITY
      // and cannot stage a stale value: if the deployment config changes
      // between park and approve, the live one still wins.
      const shown = backends.injectedArgsFor
        ? backends.injectedArgsFor(decision.backend, args)
        : args;
      await approvalsStore.set(id, { verb, args: shown, decision, context, createdAt: new Date().toISOString() });
      const note = `[approval needed] "${verb}"${context.summary ? ` - ${context.summary}` : ""} is waiting for approval. Approve: POST /approvals/${id}/approve`;
      await notifySlack(slackWebhookUrl, note);
      recordDecision(verb, decision, "parked");
      return { ...decision, result: null, approvalId: id, note };
    }

    // tier_1 (silent) or tier_2 (notify) - both execute now.
    let result;
    try {
      result = assertToolOk(
        decision.backend,
        decision.tool,
        await callTimed(decision.backend, decision.tool, args),
        resultChecks[decision.backend]
      );
    } catch (err) {
      // A backend that rejected the call is a failed action, and it has to
      // count as one - assertToolOk turns a 200-shaped isError into a throw
      // precisely so this is not silently a success.
      recordDecision(verb, decision, "error");
      throw err;
    }
    recordDecision(verb, decision, "success");
    if (decision.notify) {
      const note = `[executed] "${verb}" -> ${decision.backend}.${decision.tool}${context.summary ? ` - ${context.summary}` : ""}`;
      await notifySlack(slackWebhookUrl, note);
    }
    return { ...decision, result };
  }

  /**
   * Decline a parked action.
   *
   * "No" is a decision and needs to be as first-class as "yes". Until this
   * existed the only way to clear an approval nobody wanted was to delete it
   * out of MongoDB by hand - which left no record that a human had considered
   * it and said no, and no way to tell that apart from a lost record.
   */
  async function reject(id, { actor, reason, channel } = {}) {
    const pending = await approvalsStore.get(id);
    if (!pending) {
      const err = new Error(`no pending approval with id ${id}`);
      err.code = "NO_SUCH_APPROVAL";
      throw err;
    }
    // Recorded BEFORE deleting, so a crash between the two loses the pending
    // record rather than the audit entry. A duplicate audit row is harmless;
    // a missing one is not.
    await auditDecision(id, pending, "rejected", { actor, reason, channel });
    await approvalsStore.delete(id);
    approvalDecisions.inc({ outcome: "rejected" });
    await notifySlack(
      slackWebhookUrl,
      `[REJECTED] "${pending.verb}"${pending.context?.summary ? ` - ${pending.context.summary}` : ""} declined by ${actor || "unknown"}${reason ? `: ${reason}` : ""}. Nothing was executed.`
    );
    return { id, verb: pending.verb, outcome: "rejected", actor: actor || "unknown", reason: reason || null };
  }

  async function approve(id, { actor, reason, channel } = {}) {
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
        await callTimed(pending.decision.backend, pending.decision.tool, pending.args),
        resultChecks[pending.decision.backend]
      );
    } catch (err) {
      await notifySlack(
        slackWebhookUrl,
        `[approval FAILED] "${pending.verb}"${pending.context.summary ? ` - ${pending.context.summary}` : ""}: ${err.message}. Still pending as ${id}.`
      );
      // "released but the backend refused" is its own outcome. It is the shape
      // of a suspended ITSM account, and it stays pending - so counting it as a
      // plain failure would hide that a human decision is still outstanding.
      approvalDecisions.inc({ outcome: "backend_rejected" });
      // Audited even though it stays pending: a human DID decide, and that the
      // backend then refused is part of the record, not a reason to lose it.
      await auditDecision(id, pending, "backend_rejected", { actor, reason, channel, error: err.message });
      err.approvalId = id;
      err.stillPending = true;
      throw err;
    }

    approvalDecisions.inc({ outcome: "executed" });
    await auditDecision(id, pending, "executed", { actor, reason, channel });
    await approvalsStore.delete(id);
    await notifySlack(slackWebhookUrl, `[approved & executed] "${pending.verb}"${pending.context.summary ? ` - ${pending.context.summary}` : ""} by ${actor || "unknown"}`);
    return result;
  }

  /** The audit trail: decisions humans made, newest first. */
  async function listDecisions() {
    if (!decisionsStore) return [];
    const all = await decisionsStore.list();
    return all.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  }

  async function listPending() {
    return approvalsStore.list();
  }

  return { execute, approve, reject, listPending, listDecisions };
}
