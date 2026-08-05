// When a backend pod restarts, the bridge is left holding a transport the
// server has forgotten. Before this, every call returned -32600 forever while
// /status still reported ready:true, and only a manual bridge restart fixed it.
//
// The retry has to be narrow. A call that failed PARTWAY THROUGH may already
// have executed, and retrying it would run a tier_2 write twice - the exact
// double-execution the policy exists to prevent. Only errors meaning "the
// server rejected this before running anything" are retryable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Backend, BackendRegistry, isRetryable } from "../src/mcpBackends.js";

/**
 * A real Backend with its transport layer swapped out. _connect is the only
 * seam - overriding it installs a fake client without needing a live server,
 * so callTool()'s retry logic is the actual code under test.
 */
function stubBackend(failures) {
  const b = new Backend("stub");
  const state = { calls: 0, connects: 0 };
  b._open = () => ({});
  b._connect = async () => {
    state.connects += 1;
    b.client = {
      async callTool() {
        state.calls += 1;
        const f = failures.shift();
        if (f) throw new Error(f);
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
      async close() {},
    };
    b.tools = [{ name: "t" }];
    b.ready = true;
  };
  return { backend: b, state };
}

async function connected(failures) {
  const { backend, state } = stubBackend(failures);
  await backend._connect();
  state.connects = 0; // ignore the initial connect
  return { backend, state };
}

// --- what counts as retryable --------------------------------------------

test("stale-session and transport errors are retryable", () => {
  for (const m of [
    '{"code":-32600,"message":"Invalid Request"}',
    "No valid session ID provided",
    "Session not found",
    "MCP error: Connection closed",
    "fetch failed",
    "socket hang up",
    "connect ECONNREFUSED 10.42.2.9:8080",
  ]) {
    assert.ok(isRetryable(new Error(m)), `should retry: ${m}`);
  }
});

test("errors meaning the server ran it are NOT retryable", () => {
  for (const m of [
    "1 validation error for create_ticketArguments",
    "Error executing tool get_ticket_by_id: Expecting value",
    "Either email or requester_id must be provided",
    "403 Forbidden",
  ]) {
    assert.ok(!isRetryable(new Error(m)), `must not retry: ${m}`);
  }
});

// --- the retry itself -----------------------------------------------------

test("a stale session reconnects and retries once, and succeeds", async () => {
  // Verbatim what holmesgpt-runbook-mcp returned after its pod rolled.
  const { backend, state } = await connected(['{"code":-32600,"message":"Invalid Request"}']);
  const out = await backend.callTool("t", {});
  assert.equal(out.isError, false);
  assert.equal(state.calls, 2, "one failure, one retry");
  assert.equal(state.connects, 1, "reconnected exactly once");
  assert.equal(backend.ready, true);
});

test("a tool-level rejection is not retried", async () => {
  const { backend, state } = await connected(["1 validation error for create_ticket"]);
  await assert.rejects(() => backend.callTool("t", {}), /validation error/);
  assert.equal(state.calls, 1, "must not re-run a call the server processed");
  assert.equal(state.connects, 0);
});

test("retry happens at most once", async () => {
  const { backend, state } = await connected(["session expired", "session expired"]);
  await assert.rejects(() => backend.callTool("t", {}), /session expired/);
  assert.equal(state.calls, 2, "one retry then give up, no reconnect loop");
});

test("a healthy call neither reconnects nor retries", async () => {
  const { backend, state } = await connected([]);
  await backend.callTool("t", {});
  assert.equal(state.calls, 1);
  assert.equal(state.connects, 0);
});

test("a backend that was down at boot recovers on the next call", async () => {
  // Previously this stayed dead for the lifetime of the pod: callTool
  // short-circuited on !ready and nothing ever tried again.
  const { backend, state } = stubBackend([]);
  assert.equal(backend.ready, false, "never connected");
  const out = await backend.callTool("t", {});
  assert.equal(out.isError, false);
  assert.equal(state.connects, 1);
  assert.equal(backend.ready, true);
});

// --- registry -------------------------------------------------------------

test("the registry lets a not-ready backend try to reconnect", async () => {
  const { backend } = stubBackend([]);
  const r = new BackendRegistry();
  r.backends.set("stub", backend);
  const out = await r.callTool("stub", "t", {});
  assert.equal(out.isError, false);
});

test("an unknown backend is refused outright", async () => {
  await assert.rejects(
    () => new BackendRegistry().callTool("nope", "t", {}),
    /is not connected/
  );
});

test("status reports a dropped backend honestly", async () => {
  const { backend } = await connected(["1 validation error"]);
  const r = new BackendRegistry();
  r.backends.set("stub", backend);
  assert.equal(r.status().stub.ready, true);
  backend.ready = false; // what a failed reconnect leaves behind
  assert.equal(r.status().stub.ready, false, "/status must not claim ready when it isn't");
});

// --- timeouts -------------------------------------------------------------
// runbook_draft generates a runbook with an LLM and opens a PR. At the SDK's
// 60s default it timed out having ALREADY created the PR: the caller saw a
// failure for an action that succeeded, and no tier_2 notification fired.

test("a timeout is never retried", () => {
  // Ambiguous by nature - the call may have completed. Retrying could open a
  // second PR or post a second ticket comment.
  assert.ok(!isRetryable(new Error("MCP error -32001: Request timed out")));
  assert.ok(!isRetryable(new Error("Request timed out")));
});

test("the tool timeout is configurable and generous by default", async () => {
  // Asserted through behaviour: the options object reaches the SDK call.
  const b = new Backend("stub");
  let seen = null;
  b._open = () => ({});
  b._connect = async () => {
    b.client = { async callTool(_p, _s, opts) { seen = opts; return { isError: false }; }, async close() {} };
    b.ready = true;
  };
  await b._connect();
  await b.callTool("t", {});
  assert.ok(seen && typeof seen.timeout === "number", "a timeout must be passed explicitly");
  assert.ok(seen.timeout >= 120000, `expected a generous default, got ${seen.timeout}`);
});
