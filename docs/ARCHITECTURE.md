# Architecture, reasoning and business case

Companion to the [README](../README.md), which covers layout and deployment.
This document explains *why* the stack is shaped the way it is, and what it is
worth to an organisation running it.

---

## What it is

A policy-gated front door between the people who report problems and the systems
that can fix them. Someone describes a problem in plain language; the stack works
out what kind of problem it is, investigates it against live system state, and
either resolves it, drafts the fix, or parks it for a human — according to how
much damage the action could do.

It is deliberately **not** an autonomous operator. Every capability it has is
enumerated, tiered by blast radius, and the default for anything unenumerated is
"a human does this".

---

## Architecture

### Three ways in, one way through

```
  Slack (Socket Mode)  ─┐
  Teams (Bot Framework) ├─→  POST /triage  ─→  queue  ─→  triage-router
  Grafana alert poller ─┘        (202)         (Mongo)     (classifier)
                                                                │
                                              ┌─────────────────┴─────────────┐
                                              ↓                               ↓
                                      sre-investigator                  itsm-support
                                       (HolmesGPT)                    (Freshservice…)
                                              │                               │
                                              └──────────→ executor ←──────────┘
                                                        (risk policy)
                                                              │
                                        ┌─────────────────────┼──────────────────────┐
                                        ↓                     ↓                      ↓
                                   tier 1/2               tier 3                  tier 4
                                    execute              park for              draft only
                                                         approval
```

Three entry points, one pipeline. The chat platform is a **deployment choice**:
neither the agents nor the policy know whether a request arrived from Slack,
Teams, or an alert. Adding a fourth front door means writing an adapter, not
touching the policy.

### The two lanes

`triage-router` classifies each request into one of two lanes:

- **`infra_incident`** → relays to HolmesGPT, which reads Kubernetes, Prometheus,
  Grafana, Thanos and runbooks. Read-only by design; the Kubernetes Remediation
  MCP (restart/scale/drain) exists upstream and is deliberately **not** enabled.
- **`itsm_ticket`** → maps natural language to a verb (`create_ticket`,
  `add_ticket_comment`, …) and hands it to the ITSM backend.

### The policy engine

Every tool call for every backend goes through `executor.js` first. There is no
path around it. Four tiers, by blast radius:

| Tier | Behaviour | Examples |
|------|-----------|----------|
| `tier_1_auto` | Executes unattended | `get_ticket`, `runbook_search`, `root_cause_analyse` |
| `tier_2_notify` | Executes, posts to Slack for visibility | `add_ticket_comment`, `runbook_draft` |
| `tier_3_approval` | Parks; a named human releases it | `create_ticket`, `close_ticket`, `k8s_restart` |
| `tier_4_draft_only` | Agent drafts, human performs | `grant_access`, `modify_production_infra` |

---

## Design reasoning

The decisions worth defending, and what each one is protecting against.

**Alerts are polled, not received.** Alerting lives in Grafana Cloud, outside the
estate. The bridge is tailnet-only behind a deny-all NetworkPolicy and
authenticates nothing. A webhook would mean an inbound hole; polling dials out
the same way Slack's Socket Mode does. No public endpoint, no inbound auth, no
new attack surface — and it works unchanged against a self-hosted Grafana.

**Alert triage is opt-in.** Only alerts carrying `agent=triage` reach the stack.
Without a selector, every warning in the estate becomes a triage job and then a
ticket, and the ones that matter drown.

**The public listener is a separate process.** Teams cannot dial out — the Bot
Framework POSTs to an endpoint you host. If that endpoint were the main app, the
public surface would also include `POST /approvals/:id/approve`, which takes no
credentials: anyone reaching it could release a parked tier-3 action. So an
adapter needing public reachability gets its own Express app on its own port with
exactly one route mounted. Slack dials out, so it never gets an app at all.

**Unlisted actions fail closed.** `unlisted_action: tier_4_draft_only`.
Enumerating four tiers says nothing about a verb that appears in none of them —
and that verb is exactly what a new MCP server introduces. A tool list can grow
without the policy file changing. Fail closed, and log the verb by name so it can
be tiered properly.

**Empty approvers means nobody, not everybody.** Matching the NetworkPolicy's
treatment of an empty peer list. Approving is the one thing that should never
default open.

**Requests are queued, not answered inline.** Slack and Teams want an ack inside
3 seconds; the infra lane takes 30–50s (today's test: 52s). So `/triage` returns
`202` and a job id. The queue is MongoDB-backed, and anything left `RUNNING`
belongs to a worker that died — it is requeued at boot rather than lost silently.

**Parked approvals are durable.** A tier-3 action waiting for a human must
survive a restart, or the restart becomes a silent denial. `/status` reports
`durableState` honestly so an operator can see when it is degraded to in-memory.

**Some backends report failure as success.** `holmesgpt-runbook-mcp` returns
`{"error": ...}` with `isError: false` when a Confluence query fails, which reads
as a healthy tier-1 result. Backends declare a `resultIsErrorWhen` pattern,
compiled once at boot, and the executor applies it. Without this, a broken
backend looks like a working one.

**Verbs are checked against reality at boot.** `assertVerbsResolve()` says so at
startup if a tiered verb points at a tool its backend does not have. This came
from a real case: `runbook_gap_detect` was tiered for months and never existed. A
tiered verb nothing implements looks supported and silently isn't.

**Policy and mappings live in the same repo.** A policy change and the mapping
change it depends on are one commit and one review.

**Metrics get a third listener.** Same argument as the Teams endpoint, applied
again: a scraper has to reach the pod, and the main port carries
`POST /approvals/:id/approve` with no credentials. Allowing the monitoring
namespace to `:3000` would let anything scheduled there release a parked tier-3
action. So `/metrics` is on `:9090` with nothing else mounted, and the
NetworkPolicy has a separate rule that opens only that port. A metrics agent can
count approvals without being able to grant one.

**The metrics are the policy decisions, not just the HTTP traffic.** A tier-3
that parked never reaches a backend, so counting backend calls alone would make
every gated action invisible — precisely the actions an auditor cares about.
`platform_agent_actions_total` is labelled by verb, tier, action and outcome, so
"what did this thing do, and what did it refuse to do" is one query.

**Alert-poller health is a timestamp, not a counter.** A poller that stops is
indistinguishable from a quiet estate if you are watching a counter, because both
look like "no increase". `alert_last_success_timestamp_seconds` makes staleness a
positive signal you can alert on.

---

## What the end-to-end test proved

Run 2026-08-18 against the multitenant cluster, bridge `0.7.0`, via the same
`/triage` front door Slack uses.

| Behaviour | Result |
|-----------|--------|
| Infra classification and investigation | Routed `infra_incident`; HolmesGPT built an 8-step plan, scanned 52 pods and every namespace; completed in 52s |
| **Grounding** | Asked about a fictional `checkout-api` pod, it reported the pod and namespace do not exist and offered three hypotheses — it did **not** invent a diagnosis |
| ITSM classification | Routed `itsm_ticket` |
| Refusing to guess | Asked to raise a ticket without a requester, it asked for the email rather than inventing one (`actions: []`) |
| **Tier-3 gating** | `create_ticket` → `tier_3_approval` → `park`, `result: null`, approval id issued. Nothing executed |
| **Failure handling** | Approving it returned `502` with `stillPending: true` — the approval was *not* consumed, so it stays re-approvable |
| Durability | An approval parked on 2026-08-05 has survived 13 days and multiple restarts |
| Alert poller | ~30 consecutive successful polls, zero failures |

One real finding: **the Freshservice account is suspended**
(`"code": "account_suspended"`), so every ITSM call returns `403`. That is a
commercial issue, not a defect — and the stack surfaced it precisely rather than
swallowing it. It also explains the 13-day-old parked approval, which was never
going to execute.

The most valuable results here are the negative ones. A system that refuses to
diagnose a pod that doesn't exist, refuses to invent a requester, refuses to
execute a write without a human, and refuses to discard an approval whose backend
rejected it, is a system you can let near production.

---

## How this helps an organisation

**It does the first ten minutes.** Most incident time is spent establishing what
is actually true: which pods are unhealthy, what changed, whether a runbook
exists. That work is mechanical, and it happens before anyone senior is useful.
Running it automatically the moment an alert fires means the human arrives to
findings rather than a blank terminal.

**Risk is explicit and reviewable.** "Which actions can automation take without a
human?" is normally an emergent property of scattered scripts and nobody can
answer it. Here it is one file, in version control, reviewed like code. An
auditor can read `risk-tiers.yaml`; a new tool cannot quietly grant itself
execute rights.

**It reduces the tax on senior engineers.** Tier 1 and 2 clear unattended.
Tier 3 arrives as a decision — with the investigation already attached — rather
than as a task. The expensive people spend their attention on judgement.

**Everything is attributable.** Every action is a tiered verb with a recorded
decision, an approver where required, and a durable record. This is the part
that makes it viable in a regulated environment.

**It runs where the organisation already is.** No inbound exposure, no SaaS
sitting in the middle of production access. Enterprise clients can run it in AKS
with a Teams bot; the same chart runs in a home lab with Slack. The ITSM backend
is swappable in a commit.

### Production hardening

Three of the four blockers identified on 2026-08-18 are closed.

**The approval endpoint authenticates.** `POST /approvals/:id/approve` and
`POST /actions/:verb` both require a bearer token from External Secrets,
compared in constant time. Both are guarded, not just the first — `/actions/:verb`
takes a verb by name and skips classification entirely, which is the sharper
edge of the two and easy to overlook. It **fails closed**: with no token
configured the routes return `503` and refuse everything, matching how an empty
`approvers` list means nobody. Chat approvals are unaffected, since the adapters
hold the executor in-process and never traverse HTTP.

**It runs multiple replicas.** Job claiming was already safe at any replica
count — `claimOldest` is a single atomic `findOneAndUpdate`. The alert poller was
not: every replica would poll on its own timer and race to enqueue the same
firing, and the `seen_alerts` dedupe is a check-then-set, so two replicas can
both miss and both enqueue. One alert, N tickets. A Mongo lease elects one
poller; the lease is handed back on shutdown so a rolling deploy doesn't cost 30s
of unwatched alerts, and a store error stands the leader **down** rather than
letting it assume it still leads. `platform_agent_leader` should sum to exactly
1 across replicas — 0 means nothing is polling, above 1 is split brain.

Scaling above one replica **requires durable state**. With `MONGO_URI` unset the
store falls back to in-memory and each replica gets its own queue, its own
approvals and its own belief that it leads.

**Alerts can be pushed as well as polled.** Polling dials out and needs no
exposure, which is the right default on a tailnet-only estate and the only option
when Grafana can't reach you. A webhook is lower latency, costs nothing while
quiet, and needs no leader election at all — the Service delivers each POST to
exactly one replica, which is precisely what the lease exists to arrange. The
trade is a public authenticated endpoint, so it mounts on the same separate
listener as the Teams route and fails closed without its own token. Both intakes
share the fingerprint dedupe, so running both cannot double-triage.

**A parked action can now be declined, and every decision is kept.** Approving
used to be the only outcome; clearing an unwanted action meant deleting it from
MongoDB, which left no record that a human had considered it and said no.
`POST /approvals/:id/reject` declines without ever calling the backend, Slack
carries a Reject button beside Approve, and an `approval_decisions` collection
outlives the pending record with actor, reason, tool, target and both
timestamps. "Who approved DO-4, when, and why was the other one refused" is now
answerable from the system itself.

The ITSM backend is **Jira** via Atlassian's Rovo MCP Server, targeting the DO
project — Freshservice's account is suspended and returns 403 on every call.

### Being honest about the limits

- Classification is an LLM judgement and can misroute; the tiers, not the
  classifier, are what make that safe.
- It is only as good as its backends — today's test found a suspended ITSM
  account that would have blocked every ticket action.
- The approval token is a shared secret, so it identifies *a* holder, not *which*
  person. An actor is now required and recorded on every decision, but an HTTP
  one is self-asserted and stored `actorVerified: false` to say so. Chat
  identities are platform-verified. Real per-person attribution needs OIDC.
- `/triage` itself takes no credentials. Harmless while the NetworkPolicy admits
  nobody to that port and both front doors dial out, but adding one entry to
  `networkPolicy.allowedNamespaces` would let anything in-cluster spend LLM
  budget and raise tickets. Guard it before opening that list.
- Nothing alerts on the metrics yet. The series are correct; no one is paged
  when the poller stalls or `platform_agent_leader` reads 0.
- The value depends on tiering being maintained honestly. A team that promotes
  everything to tier 1 to reduce friction has bought nothing.
