# itsm-providers

Pluggable ITSM MCP backends, swappable without touching the swarm or the
risk policy.

## Layout

```
providers/        <name>.mcp.json — the MCP server definition
action-mappings/  <name>.yaml — generic policy verbs to real tool names
```

The chart reads both, selected by `itsmProvider` in `values.yaml`.

## Open items — resolve before this is used in anger

- **Jira Service Management is wired but NOT yet run against a live
  server.** Corrected 2026-08-18 against Atlassian's current docs, having
  been unusable as originally committed: it named `https://mcp.atlassian.com/v1/sse`
  with `"transport": "sse"`, and (a) that endpoint stopped being supported
  on 2026-06-30, (b) the bridge has no SSE transport, and (c)
  `connectAll()` only ever called `connectStdio`, so a `url` provider was
  never dispatched at all. It now uses `/v1/mcp` over Streamable HTTP with
  a service-account API key as a Bearer token, which is Atlassian's
  documented non-interactive path — their OAuth 2.1 flow is a browser
  consent a pod cannot complete.

  Before it can work, an **org admin** must enable API-token auth for the
  Rovo MCP Server (Security → Atlassian Rovo MCP Server settings) and
  create a service account with an API key. Then seed
  `platform-agent-stack-atlassian` and set `jira.projectKey`.

  The mapped tool names were cross-checked against Atlassian's published
  tool list and match exactly — but read the lesson at the bottom of this
  file before trusting that. Note API-key auth exposes a **smaller** tool
  set than OAuth, because some product scopes are unavailable to API keys.

- **Freshservice is implemented and proven**, though the account is
  currently suspended. ServiceNow
  is not yet. Freshservice uses the self-hosted community server
  (github.com/effytech/freshservice_mcp) rather than Freshworks' own
  hosted MCP integration, which is Beta/EAP-gated to selected
  Enterprise-plan customers as of writing — see
  `providers/freshservice.mcp.json` for the note and a path to switch if
  that changes. Both providers here are a starting shape until run
  against a live server — treat any provider you haven't verified that
  way, including these two.
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

## What the Freshservice mapping does not map, and why

Same problem as Jira, but wider: this server's ticket editing is a single
`update_ticket(ticket_id, ticket_fields)` tool with no dedicated
status-transition or assignment tool. `update_ticket_status` (tier 2),
`close_ticket` (tier 3) and `assign_ticket` (tier 3) would all resolve to
that one general-purpose editor, which can also rewrite summary,
description, priority or any custom field. Mapping any one of the three
grants everything the other two would have, plus more. All three stay
unmapped — see the comment block in
`action-mappings/freshservice.yaml` for the full reasoning.

This contradicts this file's own earlier assumption that Freshservice and
ServiceNow "expose narrower per-action tools and may not have this
problem" — for the community `effytech/freshservice_mcp` server at least,
it is not narrower than Jira's, it is coarser.

## Related

- [`../policy`](../policy) — the tiers these verbs are gated by
- [`../swarm`](../swarm) — resolves `action-mappings/${ITSM_PROVIDER}.yaml`
