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

### Being honest about the limits

- Classification is an LLM judgement and can misroute; the tiers, not the
  classifier, are what make that safe.
- It is only as good as its backends — today's test found a suspended ITSM
  account that would have blocked every ticket action.
- `/approvals/:id/approve` on the private port authenticates nothing. The
  NetworkPolicy is the entire access control today. That is deliberate and
  documented, but it is the thing to fix before this carries production ITSM.
- The value depends on tiering being maintained honestly. A team that promotes
  everything to tier 1 to reduce friction has bought nothing.
