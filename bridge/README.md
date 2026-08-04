# bridge

The MCP bridge: connects to the configured ITSM MCP server and
`holmesgpt-runbook-mcp`, gates every tool call through `risk-tiers.yaml`
and the action mapping, and routes inbound text between HolmesGPT
(infra) and the ITSM backend (tickets).

## Layout

```
src/
├── config.js       loads swarm.config.json / risk-tiers.yaml / action-mappings.yaml /
│                    llm-provider.yaml / .mcp.json, with ${VAR} env substitution
├── policy.js         tier resolution + verb->tool resolution, one function: decide(verb)
├── mcpBackends.js      connects to every server in .mcp.json (stdio) plus
│                        holmesgpt-runbook-mcp (streamable-http), best-effort per backend
├── executor.js           the one place every tool call passes through: policy.decide()
│                          first, then act — tier_1 silent, tier_2 execute+notify,
│                          tier_3 park pending approval, tier_4 never executes
├── llm.js                 talks to Anthropic (native Messages API) or an
│                           openai-compatible provider, for classify() and
│                           itsm-support's tool-calling
├── holmes.js                POST {HOLMES_URL}/api/chat
├── sreAgent.js               sre-investigator: relay to Holmes + tier-1 runbook_search
├── itsmAgent.js               itsm-support: single-turn tool-calling scoped to only the
│                              verbs action-mappings.yaml actually maps
├── notify.js                  Slack Incoming Webhook POST (SLACK_WEBHOOK_URL) for tier 2/3
└── index.js                    Express app: /triage, /actions/:verb, /approvals, /status
```

## Endpoints

- `POST /triage {"text": "..."}` — classifies the message, then routes
  to Holmes or itsm-support.
- `POST /actions/:verb {"args": {...}, "summary": "..."}` — call one
  policy verb directly, bypassing classification. Useful for testing a
  mapping/tier.
- `GET /approvals`, `POST /approvals/:id/approve` — tier_3 actions park
  here instead of executing; nothing auto-approves them.
- `GET /status` — connected backends, their live tool lists, pending
  approvals.

## Testing

### Policy unit tests

`test/policy.test.js` runs `Policy.decide()` against the real
`risk-tiers.yaml` and both real `action-mappings/*.yaml` files - no
cluster, no ConfigMap, no live backend. Covers: one mapped verb per
tier resolves to the right `{tier, action, notify}`; the deliberately
unmapped verbs (`update_ticket_status`, `close_ticket`, `assign_ticket`)
block regardless of tier; an unknown verb falls to
`default_policy.unlisted_action`; every `tier_4_draft_only` verb is
still unmapped; `holmesgpt-runbook-mcp`'s direct verbs resolve without
an action-mapping at all. Runs in CI (`validate.yml`, `bridge` job) on
every push/PR.

```sh
cd bridge && npm install && node --test test/*.test.js
```

This only proves the policy logic is correct against the config files -
it doesn't touch a live backend. For that, use `/actions/:verb` below.

### Live, against the deployed pod

`POST /actions/:verb` calls `executor.execute()` directly, bypassing
the LLM classifier in `/triage` - it's the fastest way to see a real
tier decision, and for tier_1/tier_2 it actually calls the real backend
(Holmes or the ITSM MCP server), not a mock.

Port-forward to the pod first (run this yourself - this environment has
no direct kubectl access):

```sh
kubectl port-forward -n agents svc/platform-agent-stack-non-prod-platform-agent-stack 3000:3000
```

Then, in another shell:

```sh
# what's connected, and which ITSM provider is active
curl -s localhost:3000/status | jq

# tier_1_auto: executes immediately, no notify. Read-only, safe to run -
# routes to the real ITSM backend.
curl -s -X POST localhost:3000/actions/search_tickets   -H 'content-type: application/json'   -d '{"args": {"query": "test"}}' | jq

# tier_1_auto via holmesgpt-runbook-mcp instead of the ITSM backend -
# DIRECT_VERBS resolve without an action-mapping.
curl -s -X POST localhost:3000/actions/runbook_search   -H 'content-type: application/json'   -d '{"args": {"query": "disk pressure"}}' | jq

# tier_2_notify: executes AND posts to Slack. This really writes a
# comment to the ticket you give it - use a scratch/test ticket ID.
curl -s -X POST localhost:3000/actions/add_ticket_comment   -H 'content-type: application/json'   -d '{"args": {"ticket_id": "<test-ticket-id>", "body": "policy tier test - safe to ignore"}, "summary": "tier-2 test"}' | jq

# tier_3_approval: does NOT execute - parks and returns a pending id,
# also posts to Slack. Nothing happens in the ITSM backend yet.
curl -s -X POST localhost:3000/actions/create_ticket   -H 'content-type: application/json'   -d '{"args": {"subject": "policy tier test"}, "summary": "tier-3 test"}' | jq

# see it queued
curl -s localhost:3000/approvals | jq

# only run this if you actually want the ticket created - it calls the
# real backend now
curl -s -X POST localhost:3000/approvals/<id-from-above>/approve | jq

# blocked: tiered but deliberately unmapped (see action-mappings' "NOT
# MAPPED, deliberately" comments) - never reaches the backend
curl -s -X POST localhost:3000/actions/update_ticket_status   -H 'content-type: application/json'   -d '{"args": {}}' | jq

# blocked: not in risk-tiers.yaml at all, falls to
# default_policy.unlisted_action and has no mapping either
curl -s -X POST localhost:3000/actions/some_made_up_verb   -H 'content-type: application/json'   -d '{"args": {}}' | jq
```

### Full pipeline, through classification

`POST /triage` is the actual front door - it classifies free text with
the LLM first, then hands off to either `sreAgent.js` (Holmes) or
`itsmAgent.js` (ITSM backend), which itself picks a verb and calls
`executor.execute()`. This exercises the LLM call in `llm.js`, so it
needs a working, funded LLM provider key - `/actions/:verb` above does
not.

```sh
curl -s -X POST localhost:3000/triage   -H 'content-type: application/json'   -d '{"text": "the checkout pods keep restarting, can you look?"}' | jq
# -> {"lane": "infra_incident", ...} - routed to Holmes

curl -s -X POST localhost:3000/triage   -H 'content-type: application/json'   -d '{"text": "customer says their invite emails never arrived, open a ticket"}' | jq
# -> {"lane": "itsm_ticket", ...} - itsm-support picked a verb (likely
# create_ticket, tier_3) and it went through the same executor path
```

## Known gaps

- **No Slack app.** `/triage` is a plain HTTP endpoint; nothing calls it
  automatically when someone posts in a channel. Wiring an actual Slack
  Events API subscription (or a slash command) to POST here is the
  remaining piece.
- **`itsm-support`'s tool-calling is single-turn.** One completion picks
  zero-or-one action and calls it. It doesn't loop (call a tool, look at
  the result, decide whether to call another).
- **`confluence-read`** has no backend — `../confluence-toolset/` is
  still a placeholder. `search_confluence` and `get_confluence_page`
  will resolve to "blocked, no mapping" until that lands.
- **`kubernetes` / `prometheus` / `grafana` / `thanos` / `azure-mcp`**
  from `sre-investigator`'s toolset in `swarm.config.json` aren't
  connected by this bridge — Holmes already has its own toolsets for
  these, so `sreAgent.js` relays to Holmes instead.
- **Pending approvals are in-memory** — they don't survive a pod
  restart.
