// Exercises Policy.decide() against the real risk-tiers.yaml and both
// real action-mappings/*.yaml files - no ConfigMap or cluster needed.
// Run: node --test test/policy.test.js  (from bridge/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { Policy } from "../src/policy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHART = path.resolve(HERE, "../../charts/platform-agent-stack");

function loadYaml(p) {
  return yaml.load(readFileSync(p, "utf8"));
}

const riskTiers = loadYaml(path.join(CHART, "policy/risk-tiers.yaml"));

function policyFor(provider) {
  const actionMappings = loadYaml(
    path.join(CHART, `itsm-providers/action-mappings/${provider}.yaml`)
  );
  return new Policy({ riskTiers, actionMappings });
}

// One representative, mapped verb per tier, true for both providers.
const TIER_CASES = [
  ["search_tickets", "tier_1_auto", "execute", false],
  ["add_ticket_comment", "tier_2_notify", "execute", true],
  ["create_ticket", "tier_3_approval", "park", true],
];

for (const provider of ["jira-service-management", "freshservice"]) {
  test(`${provider}: tiered + mapped verbs resolve to the right action`, () => {
    const policy = policyFor(provider);
    for (const [verb, tier, action, notify] of TIER_CASES) {
      const decision = policy.decide(verb);
      assert.equal(decision.tier, tier, `${verb} tier`);
      assert.equal(decision.action, action, `${verb} action`);
      assert.equal(decision.notify, notify, `${verb} notify`);
      assert.ok(decision.backend, `${verb} must resolve a backend`);
      assert.ok(decision.tool, `${verb} must resolve a tool`);
    }
  });

  test(`${provider}: tiered but deliberately unmapped verbs are blocked regardless of tier`, () => {
    const policy = policyFor(provider);
    // Every provider's action-mapping README documents these as
    // present in a tier but intentionally left out of `actions:`.
    for (const verb of ["update_ticket_status", "close_ticket", "assign_ticket"]) {
      const decision = policy.decide(verb);
      assert.equal(decision.action, "blocked", `${verb} must be blocked`);
      assert.ok(!decision.backend, `${verb} must not resolve a backend`);
    }
  });

  test(`${provider}: a verb in no tier at all falls to default_policy.unlisted_action`, () => {
    const policy = policyFor(provider);
    const decision = policy.decide("some_totally_new_verb_no_server_has_yet");
    assert.equal(decision.tier, riskTiers.default_policy.unlisted_action);
    // tier_4_draft_only + unmapped -> blocked, not draft, since resolve()
    // is checked first regardless of tier.
    assert.equal(decision.action, "blocked");
  });

  test(`${provider}: tier_4 verbs are unmapped by convention, so they block rather than draft`, () => {
    const policy = policyFor(provider);
    for (const verb of riskTiers.risk_tiers.tier_4_draft_only.actions) {
      const decision = policy.decide(verb);
      assert.equal(decision.tier, "tier_4_draft_only");
      // If a future mapping adds one of these, this test starts failing
      // loudly here - which is the point (see action-mappings' "NOT
      // MAPPED, deliberately" comments before mapping any of them).
      assert.equal(decision.action, "blocked", `${verb} expected unmapped`);
    }
  });
}

test("holmesgpt-runbook-mcp verbs resolve directly, no action-mapping needed", () => {
  // DIRECT_VERBS bypass action-mappings entirely, so this must hold with
  // actionMappings: null too (sre-investigator has no ITSM mapping).
  const policy = new Policy({ riskTiers, actionMappings: null });
  for (const verb of ["runbook_search", "runbook_get", "root_cause_analyse"]) {
    const decision = policy.decide(verb);
    assert.equal(decision.action, "execute");
    assert.equal(decision.backend, "runbook_mcp");
    assert.equal(decision.tool, verb);
  }
  // runbook_draft is tier_2 - direct-resolves but still notifies.
  const draft = policy.decide("runbook_draft");
  assert.equal(draft.tier, "tier_2_notify");
  assert.equal(draft.action, "execute");
  assert.equal(draft.notify, true);
});

test("no verb appears in more than one tier (risk-tiers.yaml itself)", () => {
  const seen = new Map();
  for (const [tierName, tier] of Object.entries(riskTiers.risk_tiers)) {
    for (const verb of tier.actions || []) {
      assert.ok(!seen.has(verb), `"${verb}" is in both ${seen.get(verb)} and ${tierName}`);
      seen.set(verb, tierName);
    }
  }
});
