// An MCP tool reports failure IN its result, as isError - it does not
// throw. The executor used to pass that straight back, so a rejected
// call was indistinguishable from a successful one, and approve() had
// already deleted the approval before finding out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor, ToolCallError } from "../src/executor.js";
import { Policy } from "../src/policy.js";

const riskTiers = {
  default_policy: { unlisted_action: "tier_4_draft_only", on_unlisted: "warn" },
  risk_tiers: {
    tier_1_auto: { actions: ["search_tickets"] },
    tier_3_approval: { actions: ["create_ticket"] },
  },
};
const actionMappings = {
  provider: "stub",
  actions: { search_tickets: "filter_tickets", create_ticket: "create_ticket" },
};

const ok = { content: [{ type: "text", text: "done" }], isError: false };
const rejected = {
  content: [{ type: "text", text: "5 validation errors for create_ticketArguments\nsubject\n  Field required" }],
  isError: true,
};

function harness(toolResult) {
  const store = new Map();
  const notes = [];
  const executor = createExecutor({
    policy: new Policy({ riskTiers, actionMappings }),
    backends: { callTool: async () => toolResult },
    slackWebhookUrl: "",
    notifySlack: async (_url, note) => notes.push(note),
    approvalsStore: {
      set: async (id, v) => void store.set(id, v),
      get: async (id) => store.get(id),
      delete: async (id) => void store.delete(id),
      list: async () => [...store.values()],
    },
  });
  return { executor, store, notes };
}

test("a tool that rejects the call throws instead of returning success", async () => {
  const { executor } = harness(rejected);
  await assert.rejects(
    () => executor.execute("search_tickets", {}),
    (e) => e instanceof ToolCallError && /Field required/.test(e.message)
  );
});

test("a successful tool call still returns its result", async () => {
  const { executor } = harness(ok);
  const r = await executor.execute("search_tickets", {});
  assert.equal(r.action, "execute");
  assert.equal(r.result.isError, false);
});

test("a failed approval stays pending and is retryable", async () => {
  const { executor, store } = harness(rejected);
  const parked = await executor.execute("create_ticket", { subject: "x" }, { summary: "t" });
  assert.equal(parked.action, "park");
  assert.equal(store.size, 1);

  await assert.rejects(
    () => executor.approve(parked.approvalId),
    (e) => e instanceof ToolCallError && e.stillPending === true
  );

  // The whole point: the human's approval was not consumed by a failure.
  assert.equal(store.size, 1, "a rejected approval must remain in the queue");
  assert.equal((await executor.listPending()).length, 1);
});

test("a successful approval is consumed exactly once", async () => {
  const { executor, store, notes } = harness(ok);
  const parked = await executor.execute("create_ticket", { subject: "x" }, { summary: "t" });
  const result = await executor.approve(parked.approvalId);
  assert.equal(result.isError, false);
  assert.equal(store.size, 0);
  assert.ok(notes.some((n) => n.includes("[approved & executed]")));

  await assert.rejects(
    () => executor.approve(parked.approvalId),
    (e) => e.code === "NO_SUCH_APPROVAL"
  );
});

test("an unknown approval id is distinguishable from a failed execution", async () => {
  const { executor } = harness(ok);
  await assert.rejects(
    () => executor.approve("nope"),
    (e) => e.code === "NO_SUCH_APPROVAL" && !e.stillPending
  );
});

test("parking never calls the backend", async () => {
  let called = false;
  const store = new Map();
  const executor = createExecutor({
    policy: new Policy({ riskTiers, actionMappings }),
    backends: { callTool: async () => { called = true; return ok; } },
    slackWebhookUrl: "",
    notifySlack: async () => {},
    approvalsStore: {
      set: async (id, v) => void store.set(id, v),
      get: async (id) => store.get(id),
      delete: async (id) => void store.delete(id),
      list: async () => [...store.values()],
    },
  });
  await executor.execute("create_ticket", { subject: "x" });
  assert.equal(called, false, "tier_3 must not reach the backend before approval");
});
