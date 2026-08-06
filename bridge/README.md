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
├── stateStore.js           parked tier_3 approvals AND queued /triage jobs — in-memory,
│                            or MongoDB-backed when MONGO_URI is set. Degrades rather
│                            than crash-looping when Mongo is unreachable
├── jobs.js                  the /triage queue: enqueue, claim, complete, requeue stale.
│                             claimOldest uses findOneAndUpdate so two replicas cannot
│                             run the same job
├── llm.js                 talks to Anthropic (native Messages API) or an
│                           openai-compatible provider, for classify() and
│                           itsm-support's tool-calling
├── holmes.js                POST {HOLMES_URL}/api/chat
├── sreAgent.js               sre-investigator: relay to Holmes + tier-1 runbook_search
├── itsmAgent.js               itsm-support: single-turn tool-calling scoped to only the
│                              verbs action-mappings.yaml actually maps
├── notify.js                  Slack Incoming Webhook POST (SLACK_WEBHOOK_URL) for tier 2/3
├── chat/                       the conversational front door — separate from notify.js,
│   ├── index.js                 which is one-way outbound
│   ├── slack.js                  Socket Mode: dials out, needs no ingress
│   ├── teams.js                   Bot Framework: needs a public HTTPS endpoint
│   └── format.js                   how a finished job reads back
└── index.js                    Express app: /triage, /actions/:verb, /approvals, /status
```

## Endpoints

- `POST /triage {"text": "..."}` — queues the request and returns **202
  with a job id**, not the answer. Slack and Teams both want an ack inside
  3 seconds and the infra lane runs ~29s, so the answer cannot be the HTTP
  response. Add `?wait=true` to block for it — useful for a curl, useless
  for a bot.
- `GET /triage/:id` — one job. `GET /triage` — the queue.
- `POST /actions/:verb {"args": {...}, "summary": "..."}` — call one
  policy verb directly, bypassing classification. Useful for testing a
  mapping/tier.
- `GET /approvals`, `POST /approvals/:id/approve` — tier_3 actions park
  here instead of executing; nothing auto-approves them.
- `GET /status` — connected backends, their live tool lists, pending
  approvals, queue depth, and `durableState` — which says plainly whether
  a restart would lose parked approvals and queued work.

All of the above are on the main port, which **authenticates nothing**;
the deny-all NetworkPolicy is the access control. A chat adapter that needs
an inbound endpoint (Teams) gets its own listener on its own port with
nothing mounted but `/api/messages`, exposed by a separate `-endpoint`
Service. Point an Ingress at that Service, never at the main one:
`/approvals/:id/approve` takes no credentials and will execute a parked
tier-3 for anyone who can POST to it.

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

Easiest is to skip the port-forward and call the bridge from inside its
own pod - the NetworkPolicy is deny-all (`ingress: []`), so a separate
debug pod cannot reach it, and exec'ing in is the only path that isn't
blocked by design:

```sh
POD=$(kubectl -n agents get pod -l app.kubernetes.io/name=platform-agent-stack -o jsonpath='{.items[0].metadata.name}')
kubectl -n agents exec $POD -- wget -qO- http://127.0.0.1:3000/status
```

Two things that will waste your time otherwise:

- **Use `127.0.0.1`, not `localhost`.** busybox resolves `localhost` to
  `::1` first and the bridge listens on IPv4 only, so `localhost:3000`
  gives "Connection refused" from a pod that is working fine.
- **`wget -q` throws away the body on a non-2xx.** Every error response
  here is JSON with an `error` field, and you will see none of it. Use
  `kubectl exec $POD -- node -e '...fetch...'` when you need to read a
  failure, which is most of the time.

If you would rather port-forward:

```sh
kubectl port-forward -n agents svc/platform-agent-stack-non-prod-platform-agent-stack 3000:3000
```

Then, in another shell (`localhost` is fine from outside the pod):

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

## The chat front door

**Slack is live.** Socket Mode, so the bridge dials out over a WebSocket and
needs no ingress, no public DNS and no request-signature verification — which
is what makes it workable on an estate where every hostname is tailnet-only.
`slack-app-manifest.yaml` at the repo root creates the app; it is derived from
what `chat/slack.js` actually calls rather than a generic template.

Set `chat.provider: slack` and `chat.approvers`, and supply `SLACK_APP_TOKEN`
and `SLACK_BOT_TOKEN` through ESO. **`approvers` empty means nobody** — the
identity check is the whole reason the button exists, since the HTTP approve
endpoint has none.

How it behaves:

- An @mention queues a job and gets an eyes reaction — an honest ack that the
  work is queued, not done. The answer arrives in-thread.
- **Replies in a thread it has already spoken in are picked up too**, without
  needing another mention. Only `app_mention` was subscribed at first, so a
  plain reply raised no event: the bot could ask a clarifying question and then
  ignore the answer. Needs `channels:history` and `message.channels`.
- Prior turns in the thread are passed as context, so a follow-up means
  something. Each job used to be standalone.
- The asker's email is resolved from their Slack profile and stated to the
  agent, because Freshservice rejects `create_ticket` without a requester and
  the person asking *is* the requester. Needs `users:read.email`. Every one of
  these degrades to the older single-shot behaviour rather than failing.
- A tier-3 comes back with an Approve button and a confirm dialog. Pressing it
  is checked against `approvers` server-side — the button being visible is not
  the same as it being usable.

**Teams is implemented but unproven.** It has no Socket Mode equivalent: the
Bot Framework POSTs to an endpoint you host, so it needs something publicly
reachable. Set `chat.endpoint.enabled: true` and it serves `/api/messages` on
its own port and its own Service, so exactly that one route can be exposed —
see the note under Endpoints for why that separation is not optional. That
route can be public because the Bot Framework validates a JWT on every
request. `MicrosoftAppType` supports `UserAssignedMSI`, so on AKS with
workload identity there is no bot secret to hold at all.

## Known gaps

- **Thread history is fetched from Slack, not kept here.** `conversations.replies`
  needs `channels:history`, and Teams has no cheap equivalent — reading prior
  turns there means Graph with tenant admin consent. Since the bridge already
  has durable state, keeping the transcript itself keyed by thread id would be
  platform-neutral and need no extra scope on either. That is the version to
  build if Teams becomes real.
- **No Alertmanager receiver.** A chat front door covers a human typing a
  sentence; an alert firing at 3am still has no path in. That is an in-cluster
  POST with no public endpoint and no 3-second limit, so it is the cheaper of
  the two — it just has not been done.
- **`itsm-support`'s tool-calling is single-turn.** One completion picks
  zero-or-one action and calls it. It doesn't loop (call a tool, look at
  the result, decide whether to call another). Because of that it also
  cannot recover from a rejected call - it sees the rejection only as a
  thrown error at the HTTP layer, not as something to retry with better
  arguments.

- **Nothing validates arguments at park time.** `executor.execute()`
  gates the VERB, not the payload. A tier_3 whose arguments the backend
  will reject still parks, still notifies, and still sits in the queue
  looking legitimate; it fails when a human approves it. Since v0.2.2
  that failure is at least loud - the approval survives and the endpoint
  returns 502 rather than 200 - but validating against the tool's
  inputSchema before parking would be better than reporting it after.
- **`confluence-read`** has no backend — `../confluence-toolset/` is
  still a placeholder. `search_confluence` and `get_confluence_page`
  will resolve to "blocked, no mapping" until that lands.
- **`kubernetes` / `prometheus` / `grafana` / `thanos` / `azure-mcp`**
  from `sre-investigator`'s toolset in `swarm.config.json` aren't
  connected by this bridge — Holmes already has its own toolsets for
  these, so `sreAgent.js` relays to Holmes instead.
- **State is in-memory unless `mongoState.enabled: true`** — parked
  approvals and queued jobs would be lost on a pod restart and invisible to
  any other replica. It is enabled in this estate and backed by
  mongostate-crossplane over the tailnet, which `GET /status` reports as
  `durableState`. Off by default because it needs a one-time cross-cluster
  RBAC/token setup, documented in that repo. When Mongo is unreachable the
  bridge degrades to in-memory and says so in `degradedReason` rather than
  crash-looping.
