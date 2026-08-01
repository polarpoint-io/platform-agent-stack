#!/usr/bin/env bash
set -euo pipefail
# Brings the stack up. Run this FROM platform-agent-stack/.
#
# Most of what this repo needs is already here — swarm/, policy/,
# itsm-providers/, llm-providers/, confluence-toolset/ are directories,
# not sibling repos, so there is nothing to clone or wire for them and no
# env vars to persist. Only ruflo-bridge is a separate checkout, because
# it is an independently released Helm artifact.

BASE_DIR="${BASE_DIR:-..}"
ORG="${GH_ORG:-polarpoint-io}"
ITSM_PROVIDER="${ITSM_PROVIDER:?set to a name under itsm-providers/providers/, e.g. freshservice}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Ruflo version -----------------------------------------------------
# Pinned deliberately. Do NOT change back to @latest: versions before
# 3.16.3 ship a docker-compose default that exposes the MCP bridge's
# POST /mcp endpoints with no auth (CVE-2026-59726 "RufRoot", CVSS 10.0
# — unauthenticated RCE, key theft, agent-memory poisoning).
# Advisory: GHSA-c4hm-4h84-2cf3
RUFLO_MIN_VERSION="3.16.3"
RUFLO_VERSION="${RUFLO_VERSION:-3.30.2}"

if [ "$(printf '%s\n%s\n' "$RUFLO_MIN_VERSION" "$RUFLO_VERSION" \
        | sort -V | head -n1)" != "$RUFLO_MIN_VERSION" ]; then
  echo "ERROR: RUFLO_VERSION=$RUFLO_VERSION is below the patched floor $RUFLO_MIN_VERSION" >&2
  echo "       (CVE-2026-59726 — unauthenticated RCE in the MCP bridge). Refusing." >&2
  exit 1
fi

# --- ruflo-bridge: the one sibling checkout ----------------------------
if [ ! -d "$BASE_DIR/ruflo-bridge" ]; then
  command -v gh >/dev/null || { echo "ERROR: ruflo-bridge not found at $BASE_DIR and gh is not installed" >&2; exit 1; }
  gh repo clone "$ORG/ruflo-bridge" "$BASE_DIR/ruflo-bridge"
fi

# --- Provider + mapping, both in-repo ----------------------------------
PROVIDER_FILE="$HERE/itsm-providers/providers/${ITSM_PROVIDER}.mcp.json"
ACTION_MAPPING="$HERE/itsm-providers/action-mappings/${ITSM_PROVIDER}.yaml"

[ -f "$PROVIDER_FILE" ] || { echo "ERROR: no provider file at $PROVIDER_FILE" >&2; exit 1; }

# A missing mapping means the policy's generic verbs cannot resolve to real
# tool names — the action reaches the backend ungated. Fail here instead.
[ -f "$ACTION_MAPPING" ] || {
  echo "ERROR: no action mapping at $ACTION_MAPPING" >&2
  echo "       policy/risk-tiers.yaml gates generic verbs; without this mapping" >&2
  echo "       they cannot be resolved to real tool names." >&2
  exit 1
}

# Every verb the mapping names must exist in the policy, or it runs
# untiered. This check is only possible because policy and mappings are
# now in one repo — as sibling repos, nothing could see both sides.
if command -v python3 >/dev/null; then
  python3 - "$HERE/policy/risk-tiers.yaml" "$ACTION_MAPPING" <<'PYEOF'
import sys, yaml
policy, mapping = (yaml.safe_load(open(p)) for p in sys.argv[1:3])
tiered = {a for t in policy.get("risk_tiers", {}).values() for a in t.get("actions", [])}
mapped = set((mapping or {}).get("actions", {}) or {})
unknown = sorted(mapped - tiered)
if unknown:
    default = policy.get("default_policy", {}).get("unlisted_action", "<unset>")
    print(f"WARNING: {len(unknown)} mapped verb(s) appear in no tier: {', '.join(unknown)}")
    print(f"         they will fall to default_policy.unlisted_action = {default}")
else:
    print(f"policy check: {len(mapped)} mapped verb(s), all tiered")
PYEOF
fi

# --- Merge the provider into ruflo-bridge's .mcp.json ------------------
BRIDGE_MCP="$BASE_DIR/ruflo-bridge/.mcp.json"
[ -f "$BRIDGE_MCP" ] || { echo "ERROR: $BRIDGE_MCP not found" >&2; exit 1; }

BACKUP="$BRIDGE_MCP.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$BRIDGE_MCP" "$BACKUP"
echo "Backed up existing .mcp.json to $BACKUP"

TMP_MCP="$(mktemp)"
trap 'rm -f "$TMP_MCP"' EXIT
jq -s '.[0].mcpServers.itsm = .[1].itsm | .[0]' "$BRIDGE_MCP" "$PROVIDER_FILE" > "$TMP_MCP"
jq -e . "$TMP_MCP" >/dev/null || { echo "ERROR: merge produced invalid JSON" >&2; exit 1; }
cp "$TMP_MCP" "$BRIDGE_MCP"

# --- Bring up the swarm ------------------------------------------------
SWARM_CONFIG="$HERE/swarm/swarm.config.json"
MAX_AGENTS="$(jq -r '.maxAgents' "$SWARM_CONFIG")"
TOPOLOGY="$(jq -r '.topology' "$SWARM_CONFIG")"

claude mcp add ruflo -- npx "ruflo@${RUFLO_VERSION}" mcp start
npx "ruflo@${RUFLO_VERSION}" swarm init \
  --topology "$TOPOLOGY" --max-agents "$MAX_AGENTS"

echo
echo "Stack wired (ruflo ${RUFLO_VERSION}, topology ${TOPOLOGY}, max-agents ${MAX_AGENTS})."
echo "No env vars to export — swarm/swarm.config.json resolves policy and"
echo "mappings by relative path within this repo."
echo
echo "Before exposing the bridge: confirm ruflo-bridge's MCP endpoint is not"
echo "reachable beyond its NetworkPolicy peers. The RufRoot fix closed the"
echo "default docker-compose exposure; it does not authenticate an endpoint"
echo "you deliberately publish."
