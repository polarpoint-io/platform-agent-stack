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

  const firing = alerts.filter((a) => selected(a, config.labelKey, config.labelValue));
  const firingIds = new Set(firing.map(fingerprintOf));
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
  return { checked: alerts.length, selected: firing.length, queued, forgotten };
}

/** Polls until stopped. Returns a handle with .stop(). */
export function startAlertPoller({ config, jobs, store, fetchImpl = fetch }) {
  if (!config.enabled) {
    console.log("[alerts] disabled - nothing delivers alerts to /triage");
    return { stop() {} };
  }
  if (!config.url || !config.token) {
    console.warn("[alerts] enabled but url or token is missing - not polling");
    return { stop() {} };
  }

  let timer = null;
  let stopped = false;
  const run = async () => {
    try {
      const r = await pollOnce({ config, jobs, store, fetchImpl });
      if (r.queued.length) {
        for (const q of r.queued) console.log(`[alerts] queued ${q.jobId} for ${q.name} (${q.id})`);
      }
    } catch (err) {
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
