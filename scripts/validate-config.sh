#!/usr/bin/env bash
set -euo pipefail
# Checks this repo's config is internally consistent. Runs in CI on every
# PR, and locally whenever you want.
#
#   ./scripts/validate-config.sh [provider]
#
# Deployment is ArgoCD's job — nothing here touches a cluster.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${1:-${ITSM_PROVIDER:-jira-service-management}}"
cd "$HERE"

fail=0
note() { echo "  $*"; }
bad()  { echo "  ERROR: $*" >&2; fail=1; }

[ -f "itsm-providers/providers/${PROVIDER}.mcp.json" ] \
  || bad "no provider file for ${PROVIDER}"
[ -f "itsm-providers/action-mappings/${PROVIDER}.yaml" ] \
  || bad "no action mapping for ${PROVIDER} — its verbs cannot resolve to tool names"

python3 - "$PROVIDER" <<'PY' || fail=1
import sys, json, yaml, pathlib
p = sys.argv[1]
policy = yaml.safe_load(open("policy/risk-tiers.yaml"))
tiers  = policy.get("risk_tiers", {})
tiered = {a for t in tiers.values() for a in t.get("actions", [])}

default = policy.get("default_policy", {}).get("unlisted_action")
if default not in tiers:
    print(f"  ERROR: default_policy.unlisted_action={default!r} is not a defined tier", file=sys.stderr)
    raise SystemExit(1)
print(f"  default_policy.unlisted_action = {default}")

dupes = [a for a in tiered if sum(a in t.get("actions", []) for t in tiers.values()) > 1]
if dupes:
    print(f"  ERROR: verbs in more than one tier: {sorted(set(dupes))}", file=sys.stderr)
    raise SystemExit(1)

mp = pathlib.Path(f"itsm-providers/action-mappings/{p}.yaml")
if mp.exists():
    mapping = yaml.safe_load(mp.read_text()) or {}
    mapped = set(mapping.get("actions", {}) or {})
    unknown = sorted(mapped - tiered)
    if unknown:
        print(f"  WARNING: {len(unknown)} mapped verb(s) in no tier: {', '.join(unknown)}")
        print(f"           they fall to default_policy.unlisted_action = {default}")
    print(f"  {len(mapped)} mapped verbs, {len(mapped)-len(unknown)} tiered")
    t4 = set(tiers.get("tier_4_draft_only", {}).get("actions", []))
    reachable = sorted(t4 & mapped)
    if reachable:
        print(f"  NOTE: tier-4 verbs are mapped and therefore reachable: {reachable}")

json.load(open("swarm/swarm.config.json"))
print("  swarm.config.json parses")
PY

json_ok() { python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1"; }
json_ok "itsm-providers/providers/${PROVIDER}.mcp.json" && note "provider file parses"
json_ok mcp/base.mcp.json && note "base MCP config parses"

[ "$fail" -eq 0 ] && echo "config OK" || { echo "config INVALID" >&2; exit 1; }
