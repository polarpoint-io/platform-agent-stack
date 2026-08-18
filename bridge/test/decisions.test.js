// Tier-3 decisions: rejecting, auditing, and showing an approver the real target.
//
// Three gaps these cover, all found by running the thing:
//   1. There was no way to say NO. Clearing an unwanted approval meant deleting
//      it out of MongoDB by hand, leaving no trace a human had considered it.
//   2. Approving deleted the record, so "who approved this, when" was
//      unanswerable from the system itself.
//   3. A parked approval showed cloudId/projectKey as undefined, because
//      injection happens at call time - a human approved without being told
//      which project or Atlassian site the ticket lands in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor } from "../src/executor.js";
import { resetMetrics, render } from "../src/metrics.js";

function memCollection() {
  const m = new Map();
  return {
    async set(id, v) { m.set(id, v); },
    async get(id) { return m.get(id); },
    async delete(id) { m.delete(id); },
    async list() { return [...m.entries()].map(([id, v]) => ({ id, ...v })); },
  };
}

const policy = {
  decide: (verb) =>
    verb === "create_ticket"
      ? { tier: "tier_3_approval", action: "park", notify: true, backend: "itsm", tool: "createJiraIssue" }
      : { tier: "tier_1_auto", action: "execute", notify: false, backend: "itsm", tool: "getJiraIssue" },
};

function harness({ callTool, injectArgs = { cloudId: "cloud-1", projectKey: "DO" } } = {}) {
  const approvals = memCollection();
  const decisions = memCollection();
  const backends = {
    injectedArgsFor: (_b, args) => ({ ...args, ...injectArgs }),
    callTool: callTool || (async () => ({ content: [{ type: "text", text: '{"key":"DO-9"}' }] })),
  };
  const executor = createExecutor({
    policy, backends, slackWebhookUrl: "", notifySlack: async () => {},
    approvalsStore: approvals, decisionsStore: decisions,
  });
  return { executor, approvals, decisions };
}

test("a parked approval shows the INJECTED target, not just what the model sent", async () => {
  const { executor, approvals } = harness();
  await executor.execute("create_ticket", { summary: "printer broken" }, { summary: "printer" });
  const [parked] = await approvals.list();
  assert.equal(parked.args.projectKey, "DO", "an approver must see which project");
  assert.equal(parked.args.cloudId, "cloud-1", "and which Atlassian site");
  assert.equal(parked.args.summary, "printer broken", "model args are preserved");
});

test("reject removes the approval and records WHY, without calling the backend", async () => {
  let called = false;
  const { executor, approvals, decisions } = harness({ callTool: async () => { called = true; return {}; } });
  await executor.execute("create_ticket", { summary: "nope" }, {});
  const [parked] = await approvals.list();

  const out = await executor.reject(parked.id, { actor: "surj@polarpoint.io", reason: "duplicate of DO-1", channel: "http" });
  assert.equal(out.outcome, "rejected");
  assert.equal(called, false, "rejecting must never reach the backend");
  assert.equal((await approvals.list()).length, 0, "no longer pending");

  const [d] = await decisions.list();
  assert.equal(d.outcome, "rejected");
  assert.equal(d.actor, "surj@polarpoint.io");
  assert.equal(d.reason, "duplicate of DO-1");
  assert.equal(d.verb, "create_ticket");
});

test("rejecting something that is not pending is a 404-shaped error, not a silent success", async () => {
  const { executor } = harness();
  await assert.rejects(() => executor.reject("nope", { actor: "a" }), (e) => e.code === "NO_SUCH_APPROVAL");
});

test("approve records who decided, and survives the pending record being deleted", async () => {
  const { executor, approvals, decisions } = harness();
  await executor.execute("create_ticket", { summary: "laptop" }, { summary: "laptop" });
  const [parked] = await approvals.list();

  await executor.approve(parked.id, { actor: "U123", channel: "slack" });
  assert.equal((await approvals.list()).length, 0, "pending record is consumed");

  const [d] = await decisions.list();
  assert.equal(d.outcome, "executed");
  assert.equal(d.actor, "U123");
  assert.equal(d.actorVerified, true, "slack identities are platform-verified");
  assert.equal(d.tool, "createJiraIssue");
  assert.ok(d.decidedAt && d.parkedAt, "both timestamps recorded");
});

test("an HTTP actor is recorded as UNVERIFIED - a shared token cannot prove identity", async () => {
  const { executor, approvals, decisions } = harness();
  await executor.execute("create_ticket", {}, {});
  const [parked] = await approvals.list();
  await executor.approve(parked.id, { actor: "someone@example.com", channel: "http" });
  const [d] = await decisions.list();
  assert.equal(d.actorVerified, false, "self-asserted names must not look verified");
  assert.equal(d.actorChannel, "http");
});

test("a backend refusal is audited AND stays pending - the human decision is not lost", async () => {
  const { executor, approvals, decisions } = harness({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "Forbidden" }] }),
  });
  await executor.execute("create_ticket", {}, {});
  const [parked] = await approvals.list();

  await assert.rejects(() => executor.approve(parked.id, { actor: "surj", channel: "http" }), (e) => e.stillPending === true);
  assert.equal((await approvals.list()).length, 1, "still pending, still re-approvable");

  const [d] = await decisions.list();
  assert.equal(d.outcome, "backend_rejected");
  assert.equal(d.actor, "surj");
  assert.match(d.error, /Forbidden/);
});

test("decisions come back newest first", async () => {
  const { executor, approvals, decisions } = harness();
  for (const s of ["one", "two"]) {
    await executor.execute("create_ticket", { summary: s }, {});
  }
  const parked = await approvals.list();
  await executor.reject(parked[0].id, { actor: "a", reason: "first" });
  await new Promise((r) => setTimeout(r, 5));
  await executor.reject(parked[1].id, { actor: "b", reason: "second" });
  const list = await executor.listDecisions();
  assert.equal(list.length, 2);
  assert.equal(list[0].reason, "second", "newest first");
});

test("rejections are counted separately from executions", async () => {
  resetMetrics();
  const { executor, approvals } = harness();
  await executor.execute("create_ticket", {}, {});
  const [p1] = await approvals.list();
  await executor.reject(p1.id, { actor: "a" });
  await executor.execute("create_ticket", {}, {});
  const [p2] = await approvals.list();
  await executor.approve(p2.id, { actor: "b" });
  const out = render();
  assert.match(out, /platform_agent_approval_decisions_total\{outcome="rejected"\} 1/);
  assert.match(out, /platform_agent_approval_decisions_total\{outcome="executed"\} 1/);
});

test("an audit-store failure must not break the action it is recording", async () => {
  const { executor, approvals } = harness();
  // Swap in a store that throws on write.
  const broken = createExecutor({
    policy,
    backends: { injectedArgsFor: (_b, a) => a, callTool: async () => ({ content: [{ type: "text", text: "{}" }] }) },
    slackWebhookUrl: "", notifySlack: async () => {},
    approvalsStore: approvals,
    decisionsStore: { set: async () => { throw new Error("mongo gone"); }, list: async () => [] },
  });
  await broken.execute("create_ticket", {}, {});
  const [p] = await approvals.list();
  await broken.approve(p.id, { actor: "a" });   // must not throw
  assert.equal((await approvals.list()).length, 0, "the approval still executed and was consumed");
});
