// Prometheus metrics, exposed on the PRIVATE port only.
//
// Hand-rolled rather than pulling in prom-client. This bridge carries five
// dependencies on purpose - every one of them is a supply-chain surface running
// next to credentials for the ITSM system and the cluster. The exposition format
// is a documented text protocol and the part we need is small, so the trade is
// ~150 lines here against another transitive tree. If the default Node metrics
// ever justify it, swapping to prom-client is a contained change: only this file
// knows the format.
//
// WHY THE PRIVATE PORT: /metrics names verbs, backends and approval counts. It
// is operational detail about what this thing can do to production. The public
// listener (Teams) mounts exactly one route for the same reason /approvals is
// not on it - see index.js.

const BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180];

const registry = new Map();

function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Stable key for a label set, so the same labels always hit the same series. */
function keyOf(labels, labelNames) {
  return labelNames.map((n) => `${n}=${escapeLabel(labels[n] ?? "")}`).join(",");
}

function renderLabels(labels, labelNames, extra) {
  const parts = labelNames
    .map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`)
    .concat(extra ? [extra] : []);
  return parts.length ? `{${parts.join(",")}}` : "";
}

class Metric {
  constructor(name, help, type, labelNames = []) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = labelNames;
    this.series = new Map(); // key -> { labels, value | histogram state }
    registry.set(name, this);
  }
  _slot(labels, init) {
    const key = keyOf(labels, this.labelNames);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, ...init() };
      this.series.set(key, s);
    }
    return s;
  }
}

class Counter extends Metric {
  constructor(name, help, labelNames) { super(name, help, "counter", labelNames); }
  inc(labels = {}, v = 1) { this._slot(labels, () => ({ value: 0 })).value += v; }
  render() {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(s.labels, this.labelNames)} ${s.value}`
    );
  }
}

class Gauge extends Metric {
  constructor(name, help, labelNames) { super(name, help, "gauge", labelNames); }
  set(labels = {}, v) { this._slot(labels, () => ({ value: 0 })).value = v; }
  /** Drop every series - for gauges rebuilt from scratch on each scrape. */
  reset() { this.series.clear(); }
  render() {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(s.labels, this.labelNames)} ${s.value}`
    );
  }
}

class Histogram extends Metric {
  constructor(name, help, labelNames, buckets = BUCKETS) {
    super(name, help, "histogram", labelNames);
    this.buckets = buckets;
  }
  // counts[i] is stored ALREADY CUMULATIVE - an observation increments every
  // bucket it falls at or below. Prometheus wants cumulative buckets, so render
  // emits these verbatim; summing them again here would square the counts.
  observe(labels = {}, v) {
    const s = this._slot(labels, () => ({
      counts: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    }));
    s.sum += v;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (v <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  render() {
    const lines = [];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(s.labels, this.labelNames, `le="${this.buckets[i]}"`)} ${s.counts[i]}`
        );
      }
      // +Inf must equal _count or the histogram is invalid.
      lines.push(`${this.name}_bucket${renderLabels(s.labels, this.labelNames, 'le="+Inf"')} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels, this.labelNames)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels, this.labelNames)} ${s.count}`);
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// The metrics themselves.
//
// Every label here is bounded: verbs and tiers come from risk-tiers.yaml,
// backends from .mcp.json, lanes are a closed set of three. Nothing is labelled
// with a job id, ticket id or free text - that is how a metrics endpoint turns
// into an unbounded cardinality bill.
// ---------------------------------------------------------------------------

export const buildInfo = new Gauge("platform_agent_build_info", "Bridge build info; always 1", ["version", "node"]);

// --- availability signals (the point of the exercise) ---
export const backendReady = new Gauge("platform_agent_backend_ready", "1 when an MCP backend is connected and usable", ["backend"]);
export const stateDurable = new Gauge("platform_agent_state_durable", "1 when approvals and jobs are MongoDB-backed, 0 when degraded to memory");
export const chatConnected = new Gauge("platform_agent_chat_connected", "1 when the chat front door is running", ["provider"]);
export const alertPollerEnabled = new Gauge("platform_agent_alert_poller_enabled", "1 when the Grafana alert poller is running");
// Should sum to exactly 1 across replicas. 0 means nothing is polling; >1 means
// two replicas both believe they lead, which is the split-brain to alert on.
export const leaderStatus = new Gauge("platform_agent_leader", "1 on the replica currently holding the named lease", ["lease"]);
export const authRefusals = new Counter("platform_agent_auth_refusals_total", "Requests refused by the approval-token guard", ["reason"]);

// --- alert poller ---
export const alertPolls = new Counter("platform_agent_alert_polls_total", "Grafana alert polls by outcome", ["outcome"]);
export const alertLastSuccess = new Gauge("platform_agent_alert_last_success_timestamp_seconds", "Unix time of the last successful alert poll");
export const alertsQueued = new Counter("platform_agent_alerts_queued_total", "Alerts that opened a triage job");
export const alertWebhooks = new Counter("platform_agent_alert_webhooks_total", "Grafana webhook deliveries by outcome", ["outcome"]);

// --- triage work ---
export const triageJobs = new Counter("platform_agent_triage_jobs_total", "Triage jobs by lane and terminal status", ["lane", "status"]);
export const triageDuration = new Histogram("platform_agent_triage_duration_seconds", "Wall-clock time to run a triage job", ["lane"]);
export const triageQueue = new Gauge("platform_agent_triage_queue_depth", "Triage jobs currently in each state", ["status"]);

// --- policy decisions: the audit-relevant series ---
export const actions = new Counter("platform_agent_actions_total", "Policy decisions by verb, tier and outcome", ["verb", "tier", "action", "outcome"]);
export const approvalsPending = new Gauge("platform_agent_approvals_pending", "Tier-3 actions parked waiting for a human");
export const approvalDecisions = new Counter("platform_agent_approval_decisions_total", "Approval releases by outcome", ["outcome"]);

// --- backend calls ---
export const toolCalls = new Counter("platform_agent_tool_calls_total", "MCP tool calls by backend and outcome", ["backend", "tool", "outcome"]);
export const toolDuration = new Histogram("platform_agent_tool_call_duration_seconds", "MCP tool call latency", ["backend", "tool"]);

// --- process health ---
const procUptime = new Gauge("platform_agent_process_uptime_seconds", "Process uptime");
const procMemory = new Gauge("platform_agent_process_memory_bytes", "Process memory", ["kind"]);
const eventLoopLag = new Gauge("platform_agent_event_loop_lag_seconds", "Event loop lag, sampled every 5s");

// Event loop lag matters here specifically: the worker runs jobs SERIALLY, so a
// wedged investigation shows up as lag long before it shows up as a failure.
let lagSeconds = 0;
let lagTimer = null;
export function startProcessSampling(intervalMs = 5000) {
  let last = process.hrtime.bigint();
  lagTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const drift = Number(now - last) / 1e9 - intervalMs / 1000;
    lagSeconds = Math.max(0, drift);
    last = now;
  }, intervalMs);
  lagTimer.unref?.();
  return { stop() { if (lagTimer) clearInterval(lagTimer); } };
}

/**
 * Refresh the gauges that describe *current* state, then render.
 *
 * Done at scrape time rather than on a timer so the numbers are true when read,
 * and so a scrape that never happens costs nothing. The reads are cheap and the
 * whole thing is best-effort: a metrics endpoint must not be able to take the
 * bridge down, so a failing refresh still renders what it has.
 */
export async function collect({ backends, executor, jobs, state, version = "0.0.0" } = {}) {
  buildInfo.set({ version, node: process.versions.node }, 1);
  procUptime.set({}, Math.round(process.uptime()));
  const mem = process.memoryUsage();
  procMemory.set({ kind: "rss" }, mem.rss);
  procMemory.set({ kind: "heap_used" }, mem.heapUsed);
  eventLoopLag.set({}, Number(lagSeconds.toFixed(4)));

  try {
    if (backends?.status) {
      backendReady.reset();
      for (const [name, b] of Object.entries(backends.status())) {
        backendReady.set({ backend: name }, b.ready ? 1 : 0);
      }
    }
  } catch { /* best effort */ }

  try {
    if (state) stateDurable.set({}, state.durable ? 1 : 0);
  } catch { /* best effort */ }

  try {
    if (executor?.listPending) approvalsPending.set({}, (await executor.listPending()).length);
  } catch { /* best effort */ }

  try {
    if (jobs?.list) {
      triageQueue.set({ status: "queued" }, (await jobs.list("queued")).length);
      triageQueue.set({ status: "running" }, (await jobs.list("running")).length);
    }
  } catch { /* best effort */ }

  return render();
}

export function render() {
  const out = [];
  for (const m of registry.values()) {
    const lines = m.render();
    if (!lines.length) continue;
    out.push(`# HELP ${m.name} ${m.help}`);
    out.push(`# TYPE ${m.name} ${m.type}`);
    out.push(...lines);
  }
  return out.join("\n") + "\n";
}

/** Tests only - drop every series so cases cannot leak into each other. */
export function resetMetrics() {
  for (const m of registry.values()) m.series.clear();
}

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
