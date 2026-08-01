# itsm-providers

Pluggable ITSM MCP backends. Jira Service Management today, swappable without
touching the swarm or the risk policy.

## Layout

```
providers/        <name>.mcp.json — the MCP server definition
action-mappings/  <name>.yaml — generic policy verbs to real tool names
```

The chart reads both, selected by `itsmProvider` in `values.yaml`.

## Open items — resolve before this is used in anger

- **Only Jira Service Management is implemented.** Adding ServiceNow or
  Freshservice means writing both files for it — a provider definition
  and an action mapping. Several community MCP servers exist for each,
  with different install commands and credential handling. Treat any
  provider you haven't run against a live server as a starting shape.
- **Action mappings must not be guessed.** The generic verbs in
  [`../policy/risk-tiers.yaml`](../policy/risk-tiers.yaml) need mapping to
  whatever tool names your MCP server actually exposes. Connect first,
  read the live tool list, then write the mapping. A wrong mapping doesn't
  fail loudly — it silently ungates an action.

The chart refuses to render on a missing mapping, and
`scripts/validate-config.sh` warns on any mapped verb that appears in no
tier. Neither can tell you a verb is mapped to the *wrong* tool.

## What the Jira mapping does not map, and why

Two verbs are deliberately left out of
`action-mappings/jira-service-management.yaml`. Both are cases where the
verb-to-tool model is too coarse for the risk tiers:

- **`update_ticket_status` (tier 2) and `close_ticket` (tier 3) are the
  same tool.** Jira models both as `transitionJiraIssue` with a different
  transition id. A mapping keyed on tool name can't separate them, so
  mapping the tier-2 verb would let an auto-executing action perform a
  tier-3 close. Expressing this needs the tier decision to see the
  transition id, which `risk-tiers.yaml` has no way to say today.

- **`assign_ticket` (tier 3) is `editJiraIssue`** — the same
  general-purpose field editor that can rewrite summary, description,
  priority or any custom field. Mapping one tier-3 verb to it grants far
  more than assignment.

Both are commented out with this reasoning in the mapping file. Leaving a
verb unmapped means it cannot execute at all, which is the safe state.
Freshservice and ServiceNow expose narrower per-action tools and may not
have this problem — it is a Jira modelling detail, not a general one.

## Related

- [`../policy`](../policy) — the tiers these verbs are gated by
- [`../swarm`](../swarm) — resolves `action-mappings/${ITSM_PROVIDER}.yaml`
