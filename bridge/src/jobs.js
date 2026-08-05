// The /triage work queue.
//
// /triage used to do the whole thing inline and return the answer. That can't
// back a chat integration: Slack wants an acknowledgement within 3 seconds and
// Teams' Bot Framework the same, while the measured lanes take ~6s (ITSM) and
// ~29s (infra, because Holmes genuinely investigates), and runbook_draft runs
// to its 180s timeout. So the front door now accepts, queues, and answers
// later.
//
// It also removes a failure mode we hit for real: a caller giving up on a slow
// call that had already completed, so a tier_2 write happened with nobody
// recording it.

import { randomUUID } from "node:crypto";

export const QUEUED = "queued";
export const RUNNING = "running";
export const DONE = "done";
export const FAILED = "failed";

// A job claimed by a worker that then died would sit in RUNNING forever.
// Anything running longer than this is treated as abandoned and requeued.
const STALE_AFTER_MS = parseInt(process.env.TRIAGE_STALE_AFTER_MS || "600000", 10);

export function createJobs(collection) {
  return {
    async enqueue({ text, source = null }) {
      const id = randomUUID();
      await collection.set(id, {
        text,
        source,
        status: QUEUED,
        createdAt: new Date().toISOString(),
        attempts: 0,
      });
      return id;
    },

    async get(id) {
      const job = await collection.get(id);
      return job ? { id, ...job } : undefined;
    },

    async list(status) {
      return collection.list(status ? { status } : {});
    },

    /** Take the oldest queued job, marking it running. Undefined if none. */
    async claim() {
      return collection.claimOldest(
        { status: QUEUED },
        { status: RUNNING },
        { startedAt: new Date().toISOString() }
      );
    },

    async complete(id, result) {
      const job = await collection.get(id);
      if (!job) return;
      await collection.set(id, {
        ...job,
        status: DONE,
        result,
        finishedAt: new Date().toISOString(),
      });
    },

    async fail(id, error) {
      const job = await collection.get(id);
      if (!job) return;
      await collection.set(id, {
        ...job,
        status: FAILED,
        error: String(error?.message || error),
        finishedAt: new Date().toISOString(),
      });
    },

    /**
     * Requeue jobs left RUNNING by a worker that died mid-flight.
     *
     * Deliberately conservative: it only requeues, it never re-runs a tool
     * call directly. The job re-enters classification from the top, and any
     * write it reaches is gated by the same policy as the first time - a
     * tier_3 will park again rather than execute. Note a tier_2 that already
     * completed before the crash COULD run twice this way; that's the honest
     * tradeoff of at-least-once delivery, and why STALE_AFTER_MS is generous.
     */
    async requeueStale(now = Date.now()) {
      const running = await collection.list({ status: RUNNING });
      const requeued = [];
      for (const job of running) {
        const started = Date.parse(job.startedAt || job.createdAt || 0);
        if (!Number.isFinite(started) || now - started < STALE_AFTER_MS) continue;
        const { id, ...rest } = job;
        await collection.set(id, {
          ...rest,
          status: QUEUED,
          attempts: (rest.attempts || 0) + 1,
          startedAt: null,
        });
        requeued.push(id);
      }
      if (requeued.length) {
        console.warn(`[jobs] requeued ${requeued.length} job(s) abandoned mid-flight: ${requeued.join(", ")}`);
      }
      return requeued;
    },
  };
}

/**
 * Pull jobs off the queue one at a time and run them.
 *
 * Serial on purpose. The bridge is one replica, an infra triage pins a Holmes
 * investigation for ~30s, and running several at once would mostly buy
 * contention on the same backends.
 */
export function startWorker({ jobs, handle, onResult, intervalMs = 1000 }) {
  let stopped = false;

  async function tick() {
    const job = await jobs.claim();
    if (!job) return false;
    console.log(`[jobs] running ${job.id}`);
    try {
      const result = await handle(job);
      await jobs.complete(job.id, result);
      await onResult?.({ ...job, status: DONE, result });
    } catch (err) {
      console.error(`[jobs] ${job.id} failed: ${err.message}`);
      await jobs.fail(job.id, err);
      await onResult?.({ ...job, status: FAILED, error: String(err.message || err) });
    }
    return true;
  }

  async function loop() {
    while (!stopped) {
      let worked = false;
      try {
        worked = await tick();
      } catch (err) {
        console.error(`[jobs] worker loop error: ${err.message}`);
      }
      // Only sleep when idle, so a backlog drains without waiting a second
      // between each job.
      if (!worked) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  loop();
  return { stop: () => { stopped = true; }, tick };
}
