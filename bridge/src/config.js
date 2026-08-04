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

  return {
    swarm,
    riskTiers,
    actionMappings,
    llmProvider,
    mcpServers: mcp.mcpServers || {},
    holmesUrl: process.env.HOLMES_URL,
    holmesRunbookMcpUrl: process.env.HOLMES_RUNBOOK_MCP_URL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
    port: parseInt(process.env.PORT || "3000", 10),
  };
}
