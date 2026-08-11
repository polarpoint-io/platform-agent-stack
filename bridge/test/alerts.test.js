// Alert -> triage. These cover the two ways this goes wrong in practice:
// triaging the same firing repeatedly, and triaging everything.
import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintOf, selected, describeAlert, pollOnce } from "../src/alerts.js";

const alert = (labels, annotations = {}) => ({ labels, annotations, fingerprint: labels.fp });

function memStore() {
  const m = new Map();
  return {
    async get(id) { return m.get(id); },
    async set(id, v) { m.set(id, v); },
    async delete(id) { m.delete(id); },
    async list() { return [...m.entries()].map(([id, v]) => ({ id, ...v })); },
    _m: m,
  };
}
function memJobs() {
  const seen = [];
  return { seen, async enqueue(j) { seen.push(j); return "job-" + seen.length; } };
}
const respond = (body) => async () => ({ ok: true, json: async () => body, text: async () => "" });
const CFG = { url: "https://g.example", token: "t", labelKey: "agent", labelValue: "triage", pollSeconds: 60 };

test("a fingerprint is stable across polls", () => {
  const a = { labels: { alertname: "x", pod: "p" }, annotations: {} };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }));
  // never time-based, or every poll looks like a new alert
  assert.ok(!/\d{13}/.test(fingerprintOf(a)));
});

test("only labelled alerts are selected - the rest would drown the useful ones", () => {
  assert.equal(selected(alert({ agent: "triage" }), "agent", "triage"), true);
  assert.equal(selected(alert({ agent: "other" }), "agent", "triage"), false);
  assert.equal(selected(alert({}), "agent", "triage"), false);
  // no selector configured means everything, which the poller warns about
  assert.equal(selected(alert({}), "", ""), true);
});

test("the same firing is triaged once, not on every poll", async () => {
  const store = memStore(), jobs = memJobs();
  const body = [alert({ fp: "a1", agent: "triage", alertname: "DiskFull" })];
  const args = { config: CFG, jobs, store, fetchImpl: respond(body) };
  const first = await pollOnce(args);
  const second = await pollOnce(args);
  assert.equal(first.queued.length, 1);
  assert.equal(second.queued.length, 0, "second poll must not re-triage");
  assert.equal(jobs.seen.length, 1);
});

test("an alert that stops firing is forgotten, so a recurrence triages again", async () => {
  const store = memStore(), jobs = memJobs();
  const firing = [alert({ fp: "a1", agent: "triage", alertname: "DiskFull" })];
  await pollOnce({ config: CFG, jobs, store, fetchImpl: respond(firing) });
  const cleared = await pollOnce({ config: CFG, jobs, store, fetchImpl: respond([]) });
  assert.equal(cleared.forgotten, 1);
  const again = await pollOnce({ config: CFG, jobs, store, fetchImpl: respond(firing) });
  assert.equal(again.queued.length, 1, "a recurrence must be triaged, not suppressed forever");
});

test("the job text carries what an agent needs to act", () => {
  const s = describeAlert(alert(
    { alertname: "DiskFull", cluster: "tooling", namespace: "postiz", severity: "critical" },
    { summary: "Node disk above 90%", runbook_url: "https://rb/disk" }));
  for (const bit of ["DiskFull", "Node disk above 90%", "tooling", "postiz", "critical", "https://rb/disk"]) {
    assert.match(s, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a non-2xx from Grafana raises rather than looking like no alerts", async () => {
  const bad = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  await assert.rejects(
    pollOnce({ config: CFG, jobs: memJobs(), store: memStore(), fetchImpl: bad }),
    /HTTP 401/);
});
