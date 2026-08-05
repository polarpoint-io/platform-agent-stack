// Enforces risk-tiers.yaml and action-mappings/<provider>.yaml. See
// ../../policy/README.md and ../../itsm-providers/README.md for what
// the tiers mean and which verbs are deliberately unmapped.

// Tools whose name IS already the policy verb - no action-mapping
// needed. Currently just holmesgpt-runbook-mcp, whose tool names were
// chosen to match risk-tiers.yaml directly (see holmesgpt's own
// Application values.yaml comment).
// Verified against a live tools/list from holmesgpt-runbook-mcp 1.1.2 on
// 2026-08-05. It exposes exactly: runbook_search, runbook_get,
// investigation_classify, runbook_draft, root_cause_analyse.
//
// This list previously carried "runbook_gap_detect", which that server has
// never exposed, and omitted "investigation_classify", which it does - so a
// tier_1 verb sat in risk-tiers.yaml permanently unable to execute while a
// name nobody implements looked supported. Exactly the failure the ITSM
// action-mappings are careful about, in the one place that skips mappings.
// assertVerbsResolve() below turns that into a boot-time warning.
export const DIRECT_VERBS = new Set([
  "runbook_search",
  "runbook_get",
  "investigation_classify",
  "runbook_draft",
  "root_cause_analyse",
]);

// Every verb the policy can resolve should exist on the backend that claims
// it. Nothing enforces that at render time - a mapping and a DIRECT_VERB are
// both just strings - so check it once at startup against the tools each
// backend actually reported, and say so loudly. A verb that resolves to a
// tool the server doesn't have fails at call time looking like a transport
// problem, which is a long way from the real cause.
export function assertVerbsResolve(policy, backends, log = console.warn) {
  const problems = [];
  const verbs = new Set([
    ...DIRECT_VERBS,
    ...Object.keys(policy.actionMappings?.actions || {}),
  ]);
  for (const verb of verbs) {
    const res = policy.resolve(verb);
    if (!res) continue;
    const backend = backends.get?.(res.backend);
    if (!backend?.ready) continue; // not connected; already logged elsewhere
    if (!backend.tools?.some((t) => t.name === res.tool)) {
      problems.push(`${verb} -> ${res.backend}.${res.tool} (not in that backend's tool list)`);
    }
  }
  if (problems.length) {
    log(
      `[policy] ${problems.length} verb(s) resolve to a tool their backend does not expose. ` +
      `These cannot execute and will fail at call time:\n  - ${problems.join("\n  - ")}`
    );
  }
  return problems;
}

export class Policy {
  constructor({ riskTiers, actionMappings }) {
    this.riskTiers = riskTiers;
    this.actionMappings = actionMappings;
    this.verbToTier = new Map();
    for (const [tierName, tier] of Object.entries(riskTiers.risk_tiers || {})) {
      for (const action of tier.actions || []) {
        this.verbToTier.set(action, tierName);
      }
    }
  }

  tierFor(verb) {
    return this.verbToTier.get(verb) || this.riskTiers.default_policy.unlisted_action;
  }

  // Resolves a generic policy verb to {backend, tool}. Returns null if
  // the verb has no mapping - per this repo's own convention, an
  // unmapped verb cannot execute at all, full stop, regardless of tier.
  resolve(verb) {
    if (DIRECT_VERBS.has(verb)) {
      return { backend: "runbook_mcp", tool: verb };
    }
    const mapped = this.actionMappings?.actions?.[verb];
    if (mapped) {
      return { backend: "itsm", tool: mapped };
    }
    return null;
  }

  // The single gate every tool call goes through. Returns a decision,
  // never executes anything itself - the caller (bridge.js) is
  // responsible for actually calling the backend for tier_1/tier_2, and
  // for parking/logging for tier_3/tier_4.
  decide(verb) {
    const tier = this.tierFor(verb);
    const resolution = this.resolve(verb);
    const unlisted = !this.verbToTier.has(verb);
    if (unlisted && this.riskTiers.default_policy.on_unlisted === "warn") {
      console.warn(`[policy] unlisted verb "${verb}" - falling to ${tier}`);
    }
    if (!resolution) {
      return {
        verb,
        tier,
        action: "blocked",
        reason: `"${verb}" has no action mapping - it cannot execute regardless of tier (see itsm-providers/README.md for why some verbs are deliberately left unmapped).`,
      };
    }
    switch (tier) {
      case "tier_1_auto":
        return { verb, tier, action: "execute", notify: false, ...resolution };
      case "tier_2_notify":
        return { verb, tier, action: "execute", notify: true, ...resolution };
      case "tier_3_approval":
        return { verb, tier, action: "park", notify: true, ...resolution };
      case "tier_4_draft_only":
      default:
        return { verb, tier, action: "draft", notify: true, ...resolution };
    }
  }
}
