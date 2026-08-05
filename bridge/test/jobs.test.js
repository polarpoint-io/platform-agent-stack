// /triage used to run inline and return the answer. Slack and Teams both want
// an ack within 3 seconds; the measured lanes take ~6s (ITSM) and ~29s (infra),
// and runbook_draft runs to 180s. So the front door queues, and a worker
// answers later.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStateStore } from "../src/stateStore.js";

import { createJobs, startWorker, QUEUED, RUNNING, DONE, FAILED } from "../src/jobs.js";

async function newJobs() {
  return createJobs((await createStateStore("")).jobs);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("enqueue returns an id and the job starts queued", async () => {
  const jobs = await newJobs();
  const id = await jobs.enqueue({ text: "pods are restarting" });
  const job = await jobs.get(id);
  assert.equal(job.status, QUEUED);
  assert.equal(job.text, "pods are restarting");
  assert.ok(job.createdAt);
});

test("claim takes the oldest job and marks it running", async () => {
  const jobs = await newJobs();
  const first = await jobs.enqueue({ text: "one" });
  await tick();
  await jobs.enqueue({ text: "two" });

  const claimed = await jobs.claim();
  assert.equal(claimed.id, first, "oldest first");
  assert.equal(claimed.status, RUNNING);
  assert.ok(claimed.startedAt);
});

test("a job is only claimed once", async () => {
  const jobs = await newJobs();
  await jobs.enqueue({ text: "only me" });
  const a = await jobs.claim();
  const b = await jobs.claim();
  assert.ok(a);
  assert.equal(b, undefined, "a second worker must not get the same job");
});

test("claim returns undefined on an empty queue", async () => {
  assert.equal(await (await newJobs()).claim(), undefined);
});

test("complete stores the result", async () => {
  const jobs = await newJobs();
  const id = await jobs.enqueue({ text: "x" });
  await jobs.claim();
  await jobs.complete(id, { lane: "itsm_ticket", actions: [] });
  const job = await jobs.get(id);
  assert.equal(job.status, DONE);
  assert.equal(job.result.lane, "itsm_ticket");
  assert.ok(job.finishedAt);
});

test("fail stores the reason rather than losing it", async () => {
  const jobs = await newJobs();
  const id = await jobs.enqueue({ text: "x" });
  await jobs.claim();
  await jobs.fail(id, new Error("Holmes unreachable"));
  const job = await jobs.get(id);
  assert.equal(job.status, FAILED);
  assert.match(job.error, /Holmes unreachable/);
});

// --- crash recovery -------------------------------------------------------

test("a job abandoned mid-flight is requeued", async () => {
  const jobs = await newJobs();
  const id = await jobs.enqueue({ text: "x" });
  await jobs.claim();

  // Nothing to requeue yet - it only just started.
  assert.deepEqual(await jobs.requeueStale(), []);

  // Now pretend the worker died an hour ago.
  const requeued = await jobs.requeueStale(Date.now() + 3600_000);
  assert.deepEqual(requeued, [id]);
  const job = await jobs.get(id);
  assert.equal(job.status, QUEUED);
  assert.equal(job.attempts, 1, "attempts is tracked so a poison job is visible");
});

test("requeueStale leaves finished jobs alone", async () => {
  const jobs = await newJobs();
  const id = await jobs.enqueue({ text: "x" });
  await jobs.claim();
  await jobs.complete(id, { lane: "unknown" });
  assert.deepEqual(await jobs.requeueStale(Date.now() + 3600_000), []);
  assert.equal((await jobs.get(id)).status, DONE);
});

// --- worker ---------------------------------------------------------------

test("the worker drains the queue and records results", async () => {
  const jobs = await newJobs();
  const seen = [];
  const a = await jobs.enqueue({ text: "one" });
  const b = await jobs.enqueue({ text: "two" });

  const worker = startWorker({
    jobs,
    handle: async (job) => ({ lane: "unknown", echoed: job.text }),
    onResult: async (job) => seen.push(job.id),
    intervalMs: 5,
  });
  try {
    for (let i = 0; i < 50 && seen.length < 2; i++) await tick();
  } finally {
    worker.stop();
  }

  assert.deepEqual(seen.sort(), [a, b].sort());
  assert.equal((await jobs.get(a)).result.echoed, "one");
  assert.equal((await jobs.get(b)).status, DONE);
});

test("one failing job does not stop the worker", async () => {
  const jobs = await newJobs();
  const bad = await jobs.enqueue({ text: "boom" });
  const good = await jobs.enqueue({ text: "fine" });

  const worker = startWorker({
    jobs,
    handle: async (job) => {
      if (job.text === "boom") throw new Error("classifier exploded");
      return { lane: "unknown" };
    },
    intervalMs: 5,
  });
  try {
    for (let i = 0; i < 50; i++) {
      if ((await jobs.get(good))?.status === DONE) break;
      await tick();
    }
  } finally {
    worker.stop();
  }

  assert.equal((await jobs.get(bad)).status, FAILED);
  assert.match((await jobs.get(bad)).error, /classifier exploded/);
  assert.equal((await jobs.get(good)).status, DONE, "the queue kept moving");
});

test("onResult is told about failures too, not just successes", async () => {
  const jobs = await newJobs();
  await jobs.enqueue({ text: "boom" });
  const seen = [];
  const worker = startWorker({
    jobs,
    handle: async () => { throw new Error("nope"); },
    onResult: async (job) => seen.push(job.status),
    intervalMs: 5,
  });
  try {
    for (let i = 0; i < 50 && !seen.length; i++) await tick();
  } finally {
    worker.stop();
  }
  assert.deepEqual(seen, [FAILED], "a chat adapter has to be able to report failure");
});

// --- store ----------------------------------------------------------------

test("the in-memory store reports itself as not durable", async () => {
  const s = await createStateStore("");
  assert.equal(s.durable, false, "/status must be honest that a restart loses state");
  assert.ok(s.approvals && s.jobs, "both collections exist either way");
});

test("an unreachable MongoDB degrades instead of killing the bridge", async () => {
  // A state store being down used to be fatal, so the pod crash-looped and
  // took the ITSM and SRE lanes with it - neither of which needs durability.
  // Losing persistence is not a reason to stop answering; claiming durability
  // you do not have would be.
  const s = await createStateStore(
    "mongodb://nobody@does-not-resolve.invalid:27017/x?serverSelectionTimeoutMS=250",
    { connectTimeoutMs: 250 }
  );
  assert.equal(s.durable, false);
  assert.match(s.degradedReason, /unreachable/i, "/status must say why, not just that");
  // and it still works
  const jobs = createJobs(s.jobs);
  const id = await jobs.enqueue({ text: "still serving" });
  assert.equal((await jobs.get(id)).status, QUEUED);
});
