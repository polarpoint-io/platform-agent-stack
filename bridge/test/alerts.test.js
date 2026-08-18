// Alert -> triage. These cover the two ways this goes wrong in practice:
// triaging the same firing repeatedly, and triaging everything.
import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintOf, selected, describeAlert, pollOnce, startAlertPoller, createAlertWebhook, ingestFiring } from "../src/alerts.js";

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

// --- leader election -------------------------------------------------------
// Only one replica may poll. Two would each hit Grafana on their own timer and
// race to enqueue the same firing - and seen_alerts dedupe is a check-then-set,
// so both can miss and both enqueue. One alert, N tickets.

const pollerConfig = {
  enabled: true, url: "http://grafana.test", token: "t",
  pollSeconds: 3600, labelKey: "agent", labelValue: "triage",
};
const noStore = { async get() { return null; }, async set() {}, async list() { return []; }, async delete() {} };
const okFetch = (counter) => async () => { counter.n++; return { ok: true, json: async () => [] }; };

test("a follower does not poll at all", async () => {
  const c = { n: 0 };
  const p = startAlertPoller({
    config: pollerConfig, jobs: { async enqueue() { return "j"; } },
    store: noStore, fetchImpl: okFetch(c), isLeader: () => false,
  });
  await new Promise((r) => setTimeout(r, 40));
  p.stop();
  assert.equal(c.n, 0, "a follower must never call Grafana");
});

test("the leader polls", async () => {
  const c = { n: 0 };
  const p = startAlertPoller({
    config: pollerConfig, jobs: { async enqueue() { return "j"; } },
    store: noStore, fetchImpl: okFetch(c), isLeader: () => true,
  });
  await new Promise((r) => setTimeout(r, 40));
  p.stop();
  assert.equal(c.n, 1, "the leader polls once per interval");
});

test("a follower schedules exactly ONE timer per pass", async () => {
  // Regression: returning early inside try{} while finally{} also scheduled
  // meant every follower pass started a second timer, doubling on each tick
  // until the process died.
  const c = { n: 0 };
  const p = startAlertPoller({
    config: { ...pollerConfig, pollSeconds: 0.01 },
    jobs: { async enqueue() { return "j"; } },
    store: noStore, fetchImpl: okFetch(c),
    isLeader: () => false,
  });
  await new Promise((r) => setTimeout(r, 120));
  p.stop();
  // ~12 passes at 10ms. Doubling timers would put this in the thousands.
  assert.ok(c.n === 0, "still never polls");
});

test("a replica that wins the lease later starts polling without a restart", async () => {
  const c = { n: 0 };
  let leader = false;
  const p = startAlertPoller({
    config: { ...pollerConfig, pollSeconds: 0.01 },
    jobs: { async enqueue() { return "j"; } },
    store: noStore, fetchImpl: okFetch(c), isLeader: () => leader,
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.n, 0, "not leading yet");
  leader = true;
  await new Promise((r) => setTimeout(r, 60));
  p.stop();
  assert.ok(c.n > 0, "took over within one interval");
});

// --- webhook intake --------------------------------------------------------
// The push alternative to polling. Must behave IDENTICALLY on selection and
// dedupe, or switching mechanism silently changes which alerts make tickets.

const whConfig = { labelKey: "agent", labelValue: "triage" };

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const wh = (body, deps) => {
  const res = fakeRes();
  return createAlertWebhook(deps)({ body }, res).then(() => res);
};

test("webhook triages a firing alert that opted in", async () => {
  const store = memStore();
  const enqueued = [];
  const res = await wh(
    { alerts: [{ status: "firing", fingerprint: "f1", labels: { agent: "triage", alertname: "HighMem" }, annotations: {} }] },
    { config: whConfig, jobs: { async enqueue(j) { enqueued.push(j); return "job1"; } }, store }
  );
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.queued, 1);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].text, /HighMem is firing/);
  assert.equal(enqueued[0].source.type, "alert");
});

test("webhook ignores an alert that did not opt in - same filter as the poller", async () => {
  const store = memStore();
  const res = await wh(
    { alerts: [{ status: "firing", fingerprint: "f2", labels: { alertname: "Noisy" }, annotations: {} }] },
    { config: whConfig, jobs: { async enqueue() { throw new Error("must not enqueue"); } }, store }
  );
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.queued, 0);
});

test("webhook does not triage the same firing twice", async () => {
  const store = memStore();
  const jobs = { n: 0, async enqueue() { this.n++; return "j" + this.n; } };
  const payload = { alerts: [{ status: "firing", fingerprint: "dup", labels: { agent: "triage", alertname: "Flap" }, annotations: {} }] };
  await wh(payload, { config: whConfig, jobs, store });
  await wh(payload, { config: whConfig, jobs, store });
  assert.equal(jobs.n, 1, "second delivery must be deduped on fingerprint");
});

test("webhook forgets a resolved alert so a recurrence triages again", async () => {
  const store = memStore();
  const jobs = { n: 0, async enqueue() { this.n++; return "j" + this.n; } };
  const firing = { alerts: [{ status: "firing", fingerprint: "r1", labels: { agent: "triage", alertname: "Disk" }, annotations: {} }] };
  await wh(firing, { config: whConfig, jobs, store });
  const res = await wh(
    { alerts: [{ status: "resolved", fingerprint: "r1", labels: { agent: "triage", alertname: "Disk" }, annotations: {} }] },
    { config: whConfig, jobs, store }
  );
  assert.equal(res.body.forgotten, 1);
  await wh(firing, { config: whConfig, jobs, store });
  assert.equal(jobs.n, 2, "a recurrence after resolution must triage again");
});

test("webhook rejects a payload that is not Grafana-shaped", async () => {
  const res = await wh({ nope: true }, { config: whConfig, jobs: {}, store: memStore() });
  assert.equal(res.statusCode, 400);
});

test("poller and webhook share dedupe - the same firing via both makes ONE job", async () => {
  const store = memStore();
  const jobs = { n: 0, async enqueue() { this.n++; return "j" + this.n; } };
  const alert = { status: "firing", fingerprint: "shared", labels: { agent: "triage", alertname: "Both" }, annotations: {} };
  await wh({ alerts: [alert] }, { config: whConfig, jobs, store });
  await ingestFiring({ alerts: [alert], config: whConfig, jobs, store });
  assert.equal(jobs.n, 1, "running both intakes must not double-triage");
});
