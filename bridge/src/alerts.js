// Grafana alerts -> /triage.
//
// The only path by which the agent notices something without a human asking.
// Everything else is someone typing in Slack.
//
// It POLLS rather than receiving a webhook, and that is deliberate. Alerting
// happens in Grafana Cloud, outside the estate; the bridge is tailnet-only
// behind a deny-all NetworkPolicy and authenticates nothing, so nothing out
// there can reach in. Polling dials OUT the same way Slack's Socket Mode does:
// no public endpoint, no inbound authentication, no new attack surface. It works
// against a self-hosted Grafana too - only the URL changes.
//
// Reads Grafana's built-in Alertmanager, which is what "currently firing" means:
//   GET {url}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false
//
// OPT-IN. Only alerts carrying the configured label reach the agent. Without
// that, every warning in the estate becomes a triage job and then a ticket, and
// the useful ones drown. Label the handful of rules that genuinely want an agent
// looking at them.

import { alertPolls, alertLastSuccess, alertsQueued, alertPollerEnabled, alertWebhooks } from "./metrics.js";

const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Stable identity for an alert, so the same firing is not triaged twice. */
export function fingerprintOf(alert) {
  // Grafana supplies one. Fall back to the sorted labels, which is what a
  // fingerprint is anyway - and never to something time-based, or every poll
  // looks like a new alert.
  if (alert.fingerprint) return String(alert.fingerprint);
  const labels = alert.labels || {};
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
}

/** Does this alert opt in? */
export function selected(alert, labelKey, labelValue) {
  if (!labelKey) return true;
  const v = (alert.labels || {})[labelKey];
  return labelValue ? v === labelValue : v !== undefined;
}

/** The sentence the agent is asked to act on. */
export function describeAlert(alert) {
  const l = alert.labels || {};
  const a = alert.annotations || {};
  const name = l.alertname || "alert";
  const parts = [
    `${name} is firing.`,
    a.summary || a.description || "",
    l.cluster ? `Cluster: ${l.cluster}.` : "",
    l.namespace ? `Namespace: ${l.namespace}.` : "",
    l.pod ? `Pod: ${l.pod}.` : "",
    l.severity ? `Severity: ${l.severity}.` : "",
    a.runbook_url ? `Runbook: ${a.runbook_url}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * Triage anything firing that we have not already triaged.
 *
 * Shared by BOTH intake paths - the poller and the webhook - so that choosing
 * one or the other is a delivery decision and nothing else. The opt-in label
 * filter, the fingerprint dedupe and the enqueued text are identical either way;
 * if they diverged, switching mechanism would quietly change which alerts
 * produce tickets.
 */
export async function ingestFiring({ alerts, config, jobs, store, now = Date.now }) {
  const firing = alerts.filter((a) => selected(a, config.labelKey, config.labelValue));
  const queued = [];
  for (const alert of firing) {
    const id = fingerprintOf(alert);
    if (await store.get(id)) continue;          // already triaged this firing
    const jobId = await jobs.enqueue({
      text: describeAlert(alert),
      source: { type: "alert", fingerprint: id, labels: alert.labels || {} },
    });
    await store.set(id, { firstSeen: new Date(now()).toISOString(), jobId });
    queued.push({ id, jobId, name: (alert.labels || {}).alertname });
  }
  return { selected: firing.length, queued };
}

/**
 * One pass: fetch what is firing, triage anything new, forget what has resolved.
 *
 * Split out from the loop so it can be tested without timers, and so a single
 * pass can be triggered by hand.
 */
export async function pollOnce({ config, jobs, store, fetchImpl = fetch, now = Date.now }) {
  const url = `${config.url.replace(/\/+$/, "")}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`alert fetch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const alerts = await res.json();
  if (!Array.isArray(alerts)) throw new Error("alert fetch returned a non-array");

  const { selected: selectedCount, queued } = await ingestFiring({ alerts, config, jobs, store, now });
  const firingIds = new Set(
    alerts.filter((a) => selected(a, config.labelKey, config.labelValue)).map(fingerprintOf)
  );

  // Forget anything that has stopped firing, so a recurrence is triaged again
  // rather than suppressed forever. Also expire stragglers: an alert that
  // vanishes while the bridge is down would otherwise sit in the store for good.
  let forgotten = 0;
  for (const seen of await store.list()) {
    const stale = seen.firstSeen && now() - Date.parse(seen.firstSeen) > SEEN_TTL_MS;
    if (!firingIds.has(seen.id) || stale) {
      await store.delete(seen.id);
      forgotten++;
    }
  }
  return { checked: alerts.length, selected: selectedCount, queued, forgotten };
}

/**
 * The push alternative to polling: Grafana POSTs here when an alert fires.
 *
 * WHY BOTH EXIST. Polling dials out, so it needs no exposure at all - the right
 * default on a tailnet-only estate, and the only option when Grafana genuinely
 * cannot reach you. A webhook is lower latency (no up-to-pollSeconds delay),
 * costs nothing while quiet, and needs NO leader election: the Service delivers
 * each POST to exactly one replica, which is the thing the poller needs a Mongo
 * lease to arrange. The trade is that it requires a public, authenticated
 * endpoint. Pick per environment; enabling both is supported and harmless
 * because the fingerprint dedupe is shared.
 *
 * MOUNTED ON THE PUBLIC LISTENER, never the private one - same reasoning as
 * Teams. And it authenticates: an unauthenticated route that enqueues work
 * would let anyone on the internet spend LLM budget and raise tickets.
 *
 * Grafana's unified-alerting payload is {alerts:[{status,labels,annotations,
 * fingerprint}]}. Resolved alerts are FORGOTTEN rather than ignored, so a
 * recurrence triages again instead of being suppressed forever - matching what
 * the poller does when an alert stops appearing.
 */
export function createAlertWebhook({ config, jobs, store, now = Date.now }) {
  return async function handle(req, res) {
    const body = req.body || {};
    const incoming = Array.isArray(body.alerts) ? body.alerts : null;
    if (!incoming) {
      alertWebhooks.inc({ outcome: "bad_payload" });
      return res.status(400).json({ error: "expected a Grafana webhook payload with an alerts array" });
    }

    try {
      const firing = incoming.filter((a) => (a.status || "firing") === "firing");
      const resolved = incoming.filter((a) => a.status === "resolved");

      const { queued } = await ingestFiring({ alerts: firing, config, jobs, store, now });

      let forgotten = 0;
      for (const alert of resolved) {
        const id = fingerprintOf(alert);
        if (await store.get(id)) {
          await store.delete(id);
          forgotten++;
        }
      }

      for (const q of queued) console.log(`[alerts] webhook queued ${q.jobId} for ${q.name} (${q.id})`);
      alertWebhooks.inc({ outcome: "accepted" });
      alertsQueued.inc({}, queued.length);
      // 202: the work is queued, not done. Grafana only needs to know it landed.
      return res.status(202).json({ received: incoming.length, queued: queued.length, forgotten });
    } catch (err) {
      console.error(`[alerts] webhook failed: ${err.message}`);
      alertWebhooks.inc({ outcome: "error" });
      return res.status(500).json({ error: err.message });
    }
  };
}

/** Polls until stopped. Returns a handle with .stop(). */
export function startAlertPoller({ config, jobs, store, fetchImpl = fetch, isLeader = () => true }) {
  if (!config.enabled) {
    console.log("[alerts] disabled - nothing delivers alerts to /triage");
    alertPollerEnabled.set({}, 0);
    return { stop() {} };
  }
  if (!config.url || !config.token) {
    console.warn("[alerts] enabled but url or token is missing - not polling");
    alertPollerEnabled.set({}, 0);
    return { stop() {} };
  }
  alertPollerEnabled.set({}, 1);

  let timer = null;
  let stopped = false;
  const run = async () => {
    try {
      // Followers keep their timer running but do not poll, so a replica that
      // wins the lease later starts within one interval rather than needing a
      // restart. Not counted as a success: a follower skipping is not evidence
      // that Grafana is reachable, and treating it as such would keep
      // alert_last_success_timestamp fresh on every replica while the actual
      // leader was failing.
      //
      // Returns without scheduling - the finally block owns the timer, and
      // scheduling here too would start a second one on every pass.
      if (!isLeader()) return;
      const r = await pollOnce({ config, jobs, store, fetchImpl });
      // A poller that fails silently is indistinguishable from a quiet estate.
      // The success TIMESTAMP is the one to alert on: polls_total going flat is
      // only visible as an absence, whereas staleness is a positive signal.
      alertPolls.inc({ outcome: "success" });
      alertLastSuccess.set({}, Math.floor(Date.now() / 1000));
      if (r.queued.length) {
        alertsQueued.inc({}, r.queued.length);
        for (const q of r.queued) console.log(`[alerts] queued ${q.jobId} for ${q.name} (${q.id})`);
      }
    } catch (err) {
      alertPolls.inc({ outcome: "failure" });
      // Keep polling. Grafana Cloud being briefly unreachable is not a reason to
      // stop noticing alerts for the rest of the process's life.
      console.error(`[alerts] poll failed: ${err.message}`);
    } finally {
      if (!stopped) timer = setTimeout(run, config.pollSeconds * 1000);
    }
  };

  console.log(
    `[alerts] polling ${config.url} every ${config.pollSeconds}s` +
    (config.labelKey
      ? ` for alerts labelled ${config.labelKey}${config.labelValue ? "=" + config.labelValue : ""}`
      : " for ALL alerts - consider setting a label selector")
  );
  run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
