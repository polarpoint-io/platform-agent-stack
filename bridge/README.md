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
