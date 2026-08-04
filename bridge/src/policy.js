// Enforces risk-tiers.yaml and action-mappings/<provider>.yaml. See
// ../../policy/README.md and ../../itsm-providers/README.md for what
// the tiers mean and which verbs are deliberately unmapped.

// Tools whose name IS already the policy verb - no action-mapping
// needed. Currently just holmesgpt-runbook-mcp, whose tool names were
// chosen to match risk-tiers.yaml directly (see holmesgpt's own
// Application values.yaml comment).
const DIRECT_VERBS = new Set([
  "runbook_search",
  "runbook_get",
  "runbook_gap_detect",
  "runbook_draft",
  "root_cause_analyse",
]);

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
