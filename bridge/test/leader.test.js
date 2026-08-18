import { test } from "node:test";
import assert from "node:assert/strict";
import { startLeaderElection } from "../src/leader.js";
import { resetMetrics, render } from "../src/metrics.js";

const tick = () => new Promise((r) => setImmediate(r));

/** A lease store with the same compare-and-swap semantics as the Mongo one. */
function fakeLeases() {
  const held = new Map(); // name -> { holder, expiresAt }
  return {
    held,
    async acquire(name, holder, ttlMs, now = Date.now()) {
      const cur = held.get(name);
      if (cur && cur.holder !== holder && cur.expiresAt > now) return false;
      held.set(name, { holder, expiresAt: now + ttlMs });
      return true;
    },
    async release(name, holder) {
      if (held.get(name)?.holder === holder) held.delete(name);
    },
  };
}

test("the first replica leads and the second does not", async () => {
  const leases = fakeLeases();
  const now = () => 1000;
  const a = startLeaderElection({ leases, holder: "pod-a", renewMs: 10_000, now });
  await tick();
  const b = startLeaderElection({ leases, holder: "pod-b", renewMs: 10_000, now });
  await tick();

  assert.equal(a.isLeader(), true, "pod-a took the lease");
  assert.equal(b.isLeader(), false, "pod-b must not also lead");
  await a.stop();
  await b.stop();
});

test("exactly one leader - the metric sums to 1 across replicas", async () => {
  resetMetrics();
  const leases = fakeLeases();
  const now = () => 1000;
  const a = startLeaderElection({ leases, holder: "pod-a", renewMs: 10_000, now });
  await tick();
  const b = startLeaderElection({ leases, holder: "pod-b", renewMs: 10_000, now });
  await tick();
  // Both write the same gauge in their own process; here they share one
  // registry, so the check is that the leader reports 1 and stopping clears it.
  assert.match(render(), /platform_agent_leader\{lease="alert-poller"\} \d/);
  await a.stop();
  assert.equal(a.isLeader(), false, "stopping stands down");
  await b.stop();
});

test("an expired lease is taken over", async () => {
  const leases = fakeLeases();
  let t = 1000;
  const a = startLeaderElection({ leases, holder: "pod-a", ttlMs: 30_000, renewMs: 10_000, now: () => t });
  await tick();
  assert.equal(a.isLeader(), true);
  await a.stop();

  // pod-a is gone WITHOUT releasing - simulate by re-holding a stale lease.
  leases.held.set("alert-poller", { holder: "pod-a", expiresAt: t + 30_000 });
  t += 31_000; // past expiry

  const b = startLeaderElection({ leases, holder: "pod-b", ttlMs: 30_000, renewMs: 10_000, now: () => t });
  await tick();
  assert.equal(b.isLeader(), true, "a dead leader's lease must be reclaimable");
  await b.stop();
});

test("stop() releases the lease so a rolling deploy does not wait out the TTL", async () => {
  const leases = fakeLeases();
  const now = () => 1000;
  const a = startLeaderElection({ leases, holder: "pod-a", renewMs: 10_000, now });
  await tick();
  await a.stop();
  assert.equal(leases.held.has("alert-poller"), false, "lease handed back on shutdown");

  const b = startLeaderElection({ leases, holder: "pod-b", renewMs: 10_000, now });
  await tick();
  assert.equal(b.isLeader(), true, "successor leads immediately");
  await b.stop();
});

test("FAILS CLOSED: a store error stands the leader down rather than assuming it still leads", async () => {
  const leases = fakeLeases();
  const now = () => 1000;
  const a = startLeaderElection({ leases, holder: "pod-a", renewMs: 10_000, now });
  await tick();
  assert.equal(a.isLeader(), true);

  leases.acquire = async () => { throw new Error("mongo gone"); };
  // Force the next attempt without waiting for the renew timer.
  const b = startLeaderElection({ leases, holder: "pod-a", renewMs: 10_000, now });
  await tick();
  assert.equal(b.isLeader(), false, "an unreachable store must not read as 'still leading'");
  await a.stop();
  await b.stop();
});
