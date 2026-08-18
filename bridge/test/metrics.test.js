import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collect,
  render,
  resetMetrics,
  alertPolls,
  alertLastSuccess,
  triageDuration,
  triageJobs,
  actions,
  backendReady,
} from "../src/metrics.js";

test("counter renders HELP, TYPE and a labelled sample", () => {
  resetMetrics();
  alertPolls.inc({ outcome: "success" });
  alertPolls.inc({ outcome: "success" });
  alertPolls.inc({ outcome: "failure" });
  const out = render();
  assert.match(out, /# TYPE platform_agent_alert_polls_total counter/);
  assert.match(out, /platform_agent_alert_polls_total\{outcome="success"\} 2/);
  assert.match(out, /platform_agent_alert_polls_total\{outcome="failure"\} 1/);
});

test("histogram buckets are cumulative and +Inf equals the count", () => {
  resetMetrics();
  for (const v of [0.4, 3, 52, 200]) triageDuration.observe({ lane: "infra_incident" }, v);
  const out = render();
  const bucket = (le) => {
    const m = out.match(
      new RegExp(`platform_agent_triage_duration_seconds_bucket\\{lane="infra_incident",le="${le.replace("+", "\\+")}"\\} (\\d+)`)
    );
    return m ? Number(m[1]) : null;
  };
  assert.equal(bucket("0.5"), 1);          // 0.4
  assert.equal(bucket("5"), 2);            // 0.4, 3
  assert.equal(bucket("60"), 3);           // + 52
  assert.equal(bucket("+Inf"), 4);         // + 200, which is above every bucket
  assert.match(out, /platform_agent_triage_duration_seconds_count\{lane="infra_incident"\} 4/);
  assert.match(out, /platform_agent_triage_duration_seconds_sum\{lane="infra_incident"\} 255.4/);
});

test("label values are escaped so a quote cannot break the exposition", () => {
  resetMetrics();
  actions.inc({ verb: 'we"ird', tier: "tier_1_auto", action: "execute", outcome: "success" });
  const out = render();
  assert.match(out, /verb="we\\"ird"/);
});

test("metrics with no series are omitted entirely", () => {
  resetMetrics();
  const out = render();
  assert.doesNotMatch(out, /platform_agent_actions_total/);
});

test("collect reflects live backend readiness and queue depth", async () => {
  resetMetrics();
  const out = await collect({
    backends: { status: () => ({ itsm: { ready: true }, runbook_mcp: { ready: false } }) },
    executor: { listPending: async () => [{ id: "a" }, { id: "b" }] },
    jobs: { list: async (s) => (s === "queued" ? [1, 2, 3] : [4]) },
    state: { durable: true },
    version: "0.8.0",
  });
  assert.match(out, /platform_agent_backend_ready\{backend="itsm"\} 1/);
  assert.match(out, /platform_agent_backend_ready\{backend="runbook_mcp"\} 0/);
  assert.match(out, /platform_agent_approvals_pending 2/);
  assert.match(out, /platform_agent_triage_queue_depth\{status="queued"\} 3/);
  assert.match(out, /platform_agent_triage_queue_depth\{status="running"\} 1/);
  assert.match(out, /platform_agent_state_durable 1/);
  assert.match(out, /platform_agent_build_info\{version="0.8.0",node="[^"]+"\} 1/);
});

test("collect survives a backend that throws - a scrape must not take the bridge down", async () => {
  resetMetrics();
  const out = await collect({
    backends: { status: () => { throw new Error("boom"); } },
    executor: { listPending: async () => { throw new Error("mongo gone"); } },
    jobs: { list: async () => { throw new Error("mongo gone"); } },
    state: { durable: false },
    version: "0.8.0",
  });
  // Still renders, and still tells the truth about the thing it could read.
  assert.match(out, /platform_agent_state_durable 0/);
  assert.match(out, /platform_agent_process_uptime_seconds/);
});

test("stale backends do not linger after they disappear", async () => {
  resetMetrics();
  await collect({ backends: { status: () => ({ itsm: { ready: true }, gone: { ready: true } }) } });
  assert.match(render(), /backend="gone"/);
  await collect({ backends: { status: () => ({ itsm: { ready: true } }) } });
  assert.doesNotMatch(render(), /backend="gone"/);
});

test("triage jobs count by lane and terminal status", () => {
  resetMetrics();
  triageJobs.inc({ lane: "itsm_ticket", status: "done" });
  triageJobs.inc({ lane: "itsm_ticket", status: "failed" });
  const out = render();
  assert.match(out, /platform_agent_triage_jobs_total\{lane="itsm_ticket",status="done"\} 1/);
  assert.match(out, /platform_agent_triage_jobs_total\{lane="itsm_ticket",status="failed"\} 1/);
});

test("alert last-success timestamp is a unix time, not a duration", () => {
  resetMetrics();
  alertLastSuccess.set({}, Math.floor(Date.now() / 1000));
  const m = render().match(/platform_agent_alert_last_success_timestamp_seconds (\d+)/);
  assert.ok(m, "timestamp gauge should render");
  assert.ok(Number(m[1]) > 1_600_000_000, "should look like a unix timestamp");
});
