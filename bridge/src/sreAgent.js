// sre-investigator, made real. Holmes does its own tool orchestration
// internally (kubernetes/core, logs, prometheus, etc. - see its own
// Application values) so this doesn't reimplement an investigation
// loop; it relays to Holmes for the diagnosis, then separately offers
// runbook_search as tier-1 supporting context. runbook_draft (tier 2,
// opens a draft PR) still goes through the executor/policy gate exactly
// like every other action - Holmes itself never gets a write path.

import { askHolmes } from "./holmes.js";

export async function handleInfraRequest({ holmesUrl, executor, text }) {
  const holmes = await askHolmes(holmesUrl, text);

  // Read-only, tier_1_auto - safe to run alongside Holmes without
  // waiting on anything.
  const runbookSearch = await executor
    .execute("runbook_search", { query: text }, { summary: "supporting runbook lookup" })
    .catch((err) => ({ action: "error", reason: err.message }));

  return {
    analysis: holmes.analysis,
    holmesToolCalls: holmes.toolCalls,
    runbookSearch,
  };
}
