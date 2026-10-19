# Freshservice user-scoped ticket access (AB#188124)

**Status:** approved for implementation (design dialogue 2026-10-16)  
**Parent:** AB#188120 HolmesGPT per-user authorization (Microsoft Teams)  
**Repos:** `polarpoint-io/platform-agent-stack` (primary), `holmes-teams-bot` (Teams front door)

## Problem

On the Teams path, Freshservice ticket reads and searches must not expose org-wide tickets via the shared API key. Acceptance criteria:

1. Org-wide ticket search with the Freshservice API key is blocked on the Teams path.
2. Callers cannot retrieve another requester’s ticket they are not entitled to.
3. `create_ticket` remains tier 3 parked.

## Current state

PAS `main` already implements most of the intended behaviour in `bridge/src/identity.js` (merged via triage-caller-identity and holmes-delegated-headers):

| Mechanism | Behaviour |
|-----------|-----------|
| `callerFromTriageBody` | Teams / `userOid` present → require caller; else anonymous (Slack/CLI) |
| `authorizeToolCall` | Identified caller + ITSM cross-user verb without UPN → blocked |
| `constrainItsmArgs` | Appends `email:'<upn>'` to search / filter queries |
| `filterItsmResult` | Redacts `get_ticket` when requester email ≠ caller UPN |
| Risk tiers | `create_ticket` stays `tier_3_approval` |

Gaps that still fail AC:

1. **Fail-open on get:** if `filterItsmResult` cannot parse any requester email from the MCP result, it returns the full ticket.
2. **Invalid UPN:** PAS Teams adapter sets `upn: from.name` (display name). That is not a Freshservice requester email; searches would be wrong or useless, and checks that only test “UPN present” pass incorrectly.
3. **Prod front door bypass:** SDD requires `holmes-teams-bot` → `POST /triage` when `TRIAGE_URL` is set. Local bot still posts only `{"ask": …}` to `HOLMES_CHAT_URL`, so PAS Freshservice gating never runs for that path.

## Approach (chosen)

**Harden and verify** existing scoping. Do not introduce Freshservice delegated OAuth in this PBI.

## Design

### 1. PAS — fail closed on unverifiable get

For `get_ticket` / `get_ticket_by_id`, when a caller has a UPN:

- If requester email(s) can be parsed and match caller UPN → allow.
- If requester email(s) can be parsed and do not match → return generic denial (`not found or not permitted`).
- If **no** requester email can be parsed → return the same generic denial (do not fail open).

Anonymous callers (no `caller.oid`) are unchanged (non-Teams / non-identity paths).

### 2. PAS — email-shaped UPN for ITSM

Add a small helper (e.g. `isEmailLikeUpn`) used by `authorizeToolCall` for `ITSM_CROSS_USER_VERBS`:

- Missing UPN → blocked (`missing_user_token`) — existing.
- Present but not email-like (no `@`, or equals a bare display name) → blocked with the same reason (treat as missing for ITSM).

`constrainItsmArgs` / `filterItsmResult` only run after authorize allows; still normalize comparison case-insensitively.

Update `bridge/src/chat/teams.js` so it does **not** put `from.name` into `caller.upn`. Prefer activity fields that look like UPN/email if available; otherwise leave `upn: null` and let authorize block ITSM ticket reads.

### 3. holmes-teams-bot — TRIAGE_URL path with identity

When `TRIAGE_URL` is configured:

- `POST` to bridge `/triage` (async poll on 202 per SDD FR-009 if already documented; keep behaviour aligned with SDD).
- Body includes at least: `text`, `source: { type: "teams" }`, `userOid` (AAD object id from activity), `userUpn` (from `userPrincipalName` / email / mail on `from_property`, same sources as `_requester_from_activity`).
- Do not send secrets in logs.

When `TRIAGE_URL` is unset: keep today’s direct Holmes `HOLMES_CHAT_URL` behaviour (local/dev fallback only). Production GitOps must set `TRIAGE_URL`.

SSO/OBO ARM token forwarding stays owned by AB#188121 / AB#188122; this PBI only requires oid + upn for Freshservice scoping. If delegated ARM fields already exist on the bot, pass them through; do not invent a new OBO flow here.

### 4. Tests

PAS (`bridge/test/identity.test.js`):

- `filterItsmResult` denies when JSON has no requester email fields.
- `authorizeToolCall` blocks `search_tickets` / `get_ticket` when UPN is display-name-like.
- Existing “other requester redacted” and “query scoped to email” tests remain green.

Bot (unit tests):

- With `TRIAGE_URL` set, outbound payload includes `userOid` and `userUpn`.
- Without `TRIAGE_URL`, behaviour stays Holmes-direct.

### 5. Non-goals

- Freshservice OAuth / per-user API tokens.
- Expanding Teams audience or SecOps T1–T6 execution (AB#188126).
- Changing `create_ticket` tier or unmapped write verbs.

## Success criteria

- [ ] Teams-identified path cannot org-wide search tickets.
- [ ] Teams-identified path cannot read another requester’s ticket (including unparseable MCP payloads).
- [ ] `create_ticket` still tier 3 in `risk-tiers.yaml`.
- [ ] Unit tests cover fail-closed get + invalid UPN + bot triage identity payload.
- [ ] Short evidence note posted on AB#188124 for SecOps handoff.

## Implementation notes

- Prefer minimal diffs in `identity.js`, `chat/teams.js`, and bot `bot.py` / `config.py` (+ chart env for `TRIAGE_URL` if missing).
- Never log `armToken` / delegated tokens.
- Generic denial string stays `not found or not permitted` (no ticket leakage in error text).
