// Loads config from the two ConfigMaps this chart renders
// (templates/configmap-config.yaml, templates/configmap-mcp.yaml),
// mounted at /config and /app/.mcp.json: swarm.config.json,
// risk-tiers.yaml, action-mappings.yaml, llm-provider.yaml, .mcp.json.

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const MCP_JSON_PATH = process.env.MCP_JSON_PATH || "/app/.mcp.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8"));
}

// swarm.config.json / llm-provider.yaml use ${VAR} placeholders that were
// always meant to be resolved against the container's own env (that's
// what envFrom + the ExternalSecrets in this chart are for). Do that
// substitution once, here, rather than in every caller.
function substituteEnv(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
      if (process.env[name] === undefined) {
        console.warn(`[config] ${name} referenced in config but not set in env`);
        return match;
      }
      return process.env[name];
    });
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

export function loadConfig() {
  const swarm = substituteEnv(readJson(`${CONFIG_DIR}/swarm.config.json`));
  const riskTiers = substituteEnv(readYaml(`${CONFIG_DIR}/risk-tiers.yaml`));
  const actionMappings = existsSync(`${CONFIG_DIR}/action-mappings.yaml`)
    ? substituteEnv(readYaml(`${CONFIG_DIR}/action-mappings.yaml`))
    : null;
  const llmProvider = substituteEnv(readYaml(`${CONFIG_DIR}/llm-provider.yaml`));
  const mcp = substituteEnv(readJson(MCP_JSON_PATH));

  // Per-backend "this server reports failure as a successful result"
  // patterns, declared in itsm-providers/providers/<name>.mcp.json as
  // resultIsErrorWhen. Compiled once here; executor.js applies them.
  // Kept out of the generic path deliberately - see executor.js.
  const resultChecks = {};
  const compile = (name, pattern) => {
    if (!pattern) return;
    try {
      resultChecks[name] = new RegExp(pattern);
    } catch (err) {
      console.error(`[config] ignoring invalid resultIsErrorWhen for "${name}": ${err.message}`);
    }
  };
  for (const [name, def] of Object.entries(mcp.mcpServers || {})) {
    compile(name, def?.resultIsErrorWhen);
  }
  // runbook_mcp isn't in .mcp.json - it's an http backend configured by URL -
  // so it had no way to declare this and its failures came back as successes.
  // holmesgpt-runbook-mcp returns {"error": ...} with isError false when a
  // Confluence query fails, which read as a healthy tier_1 result.
  compile("runbook_mcp", process.env.RUNBOOK_MCP_RESULT_IS_ERROR_WHEN);

  return {
    swarm,
    riskTiers,
    actionMappings,
    llmProvider,
    mcpServers: mcp.mcpServers || {},
    resultChecks,
    holmesUrl: process.env.HOLMES_URL,
    holmesRunbookMcpUrl: process.env.HOLMES_RUNBOOK_MCP_URL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
    // Pending tier-3 approvals are MongoDB-backed when set, in-memory
    // otherwise - see stateStore.js.
    mongoUri: process.env.MONGO_URI || "",
    // Set when the database is reached through a proxy rather than at the
    // address baked into the connection secret - see rewriteMongoHost().
    mongoHostOverride: process.env.MONGO_HOST_OVERRIDE || "",
    // Grafana alerts -> /triage. Polls out rather than receiving a webhook:
    // alerting happens outside the estate and the bridge is tailnet-only behind
    // a deny-all NetworkPolicy, so nothing out there can reach in.
    alerts: {
      enabled: (process.env.ALERTS_ENABLED || "false").toLowerCase() === "true",
      url: process.env.GRAFANA_URL || "",
      token: process.env.GRAFANA_TOKEN || "",
      pollSeconds: parseInt(process.env.ALERTS_POLL_SECONDS || "60", 10),
      // OPT-IN. Without a selector every warning in the estate becomes a triage
      // job and then a ticket, and the ones that matter drown.
      labelKey: process.env.ALERTS_LABEL_KEY || "agent",
      labelValue: process.env.ALERTS_LABEL_VALUE || "triage",
      // The PUSH alternative to polling. Lower latency and needs no leader
      // election - the Service delivers each POST to one replica, which is what
      // the poller needs a lease to arrange. Costs a public endpoint, so it is
      // off by default and authenticated when on. Both may run at once; the
      // fingerprint dedupe is shared, so they cannot double-triage.
      webhook: {
        enabled: (process.env.ALERTS_WEBHOOK_ENABLED || "false").toLowerCase() === "true",
        path: process.env.ALERTS_WEBHOOK_PATH || "/alerts/webhook",
        // Its own secret, not APPROVAL_TOKEN: this one is handed to Grafana and
        // lives in a contact point, so it should be rotatable on its own and
        // must not also unlock tier-3 approvals.
        token: process.env.ALERTS_WEBHOOK_TOKEN || "",
      },
    },

    // Chat front door. "none" (default), "slack" or "teams" - see chat/index.js
    // for why the platform is a deployment choice rather than something the
    // agents or the policy know about.
    chat: {
      provider: (process.env.CHAT_PROVIDER || "none").toLowerCase().trim(),
      // Slack (Socket Mode)
      appToken: process.env.SLACK_APP_TOKEN || "",
      botToken: process.env.SLACK_BOT_TOKEN || "",
      // Teams (Bot Framework)
      appId: process.env.MICROSOFT_APP_ID || "",
      appPassword: process.env.MICROSOFT_APP_PASSWORD || "",
      tenantId: process.env.MICROSOFT_APP_TENANT_ID || "",
      appType: process.env.MICROSOFT_APP_TYPE || "SingleTenant",
      // Who may release a tier-3 action. EMPTY MEANS NOBODY, matching the
      // NetworkPolicy's treatment of an empty peer list - approving is the one
      // thing that should never default open.
      approvers: (process.env.CHAT_APPROVERS || "")
        .split(",").map((s) => s.trim()).filter(Boolean),
    },
    port: parseInt(process.env.PORT || "3000", 10),
    // A SECOND listener, used only by a chat adapter that has to be reachable
    // from outside (Teams). It is separate from `port` on purpose: everything on
    // `port` - /triage, /actions, /approvals - authenticates nothing, and the
    // only thing standing in front of it is a deny-all NetworkPolicy. Exposing
    // that pod publicly to serve one webhook would put an unauthenticated
    // "execute this parked tier-3" endpoint on the internet. Nothing but the
    // adapter's own route is ever registered on this port.
    publicPort: parseInt(process.env.PUBLIC_PORT || "3979", 10),
    // A THIRD listener, serving only /metrics. Same argument as publicPort: a
    // scraper has to reach this pod, and `port` carries /approvals/:id/approve
    // with no authentication in front of it. Opening the main port to the
    // monitoring namespace would make "release a parked tier-3" reachable by
    // anything running there. Only /metrics is ever mounted here.
    metrics: {
      enabled: (process.env.METRICS_ENABLED || "true").toLowerCase() === "true",
      port: parseInt(process.env.METRICS_PORT || "9090", 10),
      path: process.env.METRICS_PATH || "/metrics",
    },

    // Shared secret guarding the two routes that can change something:
    // /approvals/:id/approve and /actions/:verb. EMPTY DISABLES THEM - a
    // missing credential must never read as "no authentication required".
    // Chat approvals are unaffected; they never traverse HTTP.
    approvalToken: process.env.APPROVAL_TOKEN || "",

    // Which replica polls Grafana. Job claiming is atomic so it needs no
    // election, but the poller does - see leader.js.
    leader: {
      // Pod name under the downward API; falls back to something unique so two
      // processes on one machine still contend correctly.
      holder: process.env.POD_NAME || `${process.env.HOSTNAME || "local"}-${process.pid}`,
      ttlMs: parseInt(process.env.LEADER_TTL_MS || "30000", 10),
      renewMs: parseInt(process.env.LEADER_RENEW_MS || "10000", 10),
    },
  };
}
