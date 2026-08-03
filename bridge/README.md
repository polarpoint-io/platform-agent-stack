# bridge

The MCP bridge itself, as custom code — not a Ruflo image.

## Why this exists instead of using Ruflo

The blog post this stack is built for describes Ruflo as hosting the
agents, terminating every MCP call, and enforcing `../policy/risk-tiers.yaml`
against `../itsm-providers/action-mappings/`. That mechanism doesn't
exist in the real `ruflo` npm package — checked directly, not assumed:

- `bin/ruflo.js`'s `mcp start` only exposes Ruflo's own built-in tools
  (agent/swarm/memory/hooks). There's no code path that reads an
  external `.mcp.json` and re-exposes those servers' tools.
- Ruflo's own bundled `src/mcp-bridge/index.js` *is* a real MCP-merging
  HTTP gateway (same shape as this one — an Express server with a
  stdio-spawning client), but its backend list (`BACKEND_DEFS`) is
  hardcoded to six fixed dev-tool CLIs (ruvector, ruflo itself,
  agentic-flow, claude-code, gemini, codex). There's no config file or
  env var that adds an ITSM server to that list, and no tier/policy
  check anywhere in its request path.

So this directory is what actually does what the blog describes:
connects to the configured ITSM MCP server and `holmesgpt-runbook-mcp`,
gates every tool call through `risk-tiers.yaml` + the action mapping,
and routes inbound text between HolmesGPT (infra) and the ITSM backend
(tickets). Built on `@modelcontextprotocol/sdk` directly rather than
depending on the `ruflo` npm package at all — none of its logic is
reused, so there's no reason to carry its (large, native-module-heavy)
dependency tree.

## Layout

```
src/
├── config.js       loads swarm.config.json / risk-tiers.yaml / action-mappings.yaml /
│                    llm-provider.yaml / .mcp.json — the same files this chart already
│                    rendered before this existed, ${VAR} env substitution included
├── policy.js         tier resolution + verb->tool resolution, one function: decide(verb)
├── mcpBackends.js      connects to every server in .mcp.json (stdio) plus
│                        holmesgpt-runbook-mcp (streamable-http), best-effort per backend
├── executor.js           the one place every tool call passes through: policy.decide()
│                          first, then act — tier_1 silent, tier_2 execute+notify,
│                          tier_3 park pending approval, tier_4 never executes
├── llm.js                 openai-compatible chat completions (classify + itsm-support's
│                           tool-calling), against whichever provider llmProvider selects
├── holmes.js                POST {HOLMES_URL}/api/chat — confirmed against holmesgpt's
│                            real server.py, not assumed from a comment
├── sreAgent.js               sre-investigator: relay to Holmes + tier-1 runbook_search
├── itsmAgent.js               itsm-support: single-turn tool-calling scoped to only the
│                              verbs action-mappings.yaml actually maps
├── notify.js                  Slack Incoming Webhook POST (SLACK_WEBHOOK_URL) for tier 2/3
└── index.js                    Express app: /triage, /actions/:verb, /approvals, /status
```

## Endpoints

- `POST /triage {"text": "..."}` — the front door. Classifies, then
  routes to Holmes or itsm-support. This is the blog's "someone posts
  ... in Slack" trace, minus an actual Slack app in front of it (see
  below).
- `POST /actions/:verb {"args": {...}, "summary": "..."}` — call one
  policy verb directly, bypassing classification. Useful for testing a
  mapping/tier.
- `GET /approvals`, `POST /approvals/:id/approve` — tier_3 actions park
  here instead of executing; nothing auto-approves them.
- `GET /status` — connected backends, their live tool lists, pending
  approvals.

## What's real here and what isn't yet

**Real and tested:** the policy engine (tier resolution, action-mapping
resolution, and — checked explicitly — that a deliberately-unmapped verb
like Freshservice's `close_ticket` is blocked, not silently executed),
the MCP client connections (stdio + streamable-http, official SDK), the
Express routes, graceful best-effort backend connection (a backend that
fails to connect doesn't take the process down).

**Not yet real:**

- **No Slack app.** `/triage` is a plain HTTP endpoint; nothing calls it
  automatically when someone posts in `#platform-support`. Wiring an
  actual Slack Events API subscription (or a slash command) to POST here
  is the remaining piece to match the blog's Tuesday-morning trace
  exactly.
- **`itsm-support`'s tool-calling is single-turn.** One completion picks
  zero-or-one action and calls it. It doesn't loop (call a tool, look at
  the result, decide whether to call another). Good enough for "check a
  ticket and comment on it"; not for a multi-step ITSM workflow.
- **`confluence-read`** has no backend — `../confluence-toolset/` is
  still the placeholder it always was. `search_confluence` and
  `get_confluence_page` will resolve to "blocked, no mapping" until that
  lands.
- **`kubernetes` / `prometheus` / `grafana` / `thanos` / `azure-mcp`**
  from `sre-investigator`'s toolset in `swarm.config.json` aren't
  connected by this bridge at all — Holmes already has its own
  toolsets for exactly this (kubernetes/core, prometheus, etc., see its
  own Application values), so `sreAgent.js` relays to Holmes instead of
  duplicating that. If `sre-investigator` is ever meant to call those
  tools directly rather than through Holmes, that's separate work.
