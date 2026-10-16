# Freshservice user-scoped ticket access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden PAS Freshservice scoping (fail-closed get + email-like UPN) and wire `holmes-teams-bot` to `POST /triage` with `userOid`/`userUpn` when `TRIAGE_URL` is set (AB#188124).

**Architecture:** Keep existing identity broker helpers in `bridge/src/identity.js`; close the fail-open and display-name gaps; route CFC Teams traffic through the bridge so those helpers run.

**Tech Stack:** Node.js (PAS bridge), Python 3 / aiohttp / botbuilder (holmes-teams-bot), Helm charts.

## Global Constraints

- Never log `armToken` / delegated tokens.
- Generic denial text: `not found or not permitted`.
- `create_ticket` remains `tier_3_approval` in `risk-tiers.yaml` (no change).
- Do not invent Freshservice OAuth in this PBI.
- Commits only when the user asks.

---

### Task 1: PAS — fail-closed get + email-like UPN

**Files:**
- Modify: `bridge/src/identity.js`
- Modify: `bridge/src/chat/teams.js`
- Test: `bridge/test/identity.test.js`

**Interfaces:**
- Produces: `isEmailLikeUpn(value) -> boolean`; `authorizeToolCall` blocks non-email UPN for ITSM cross-user verbs; `filterItsmResult` denies when no requester email parsed.

- [ ] **Step 1: Write failing tests** in `bridge/test/identity.test.js`

```js
test("get_ticket with no parseable requester email is denied", () => {
  const result = filterItsmResult(
    "get_ticket_by_id",
    { content: [{ type: "text", text: JSON.stringify({ id: 9, subject: "secret" }) }] },
    { oid: "oid", upn: "user@example.com" }
  );
  assert.equal(result.content[0].text, "not found or not permitted");
});

test("display-name UPN blocks ITSM ticket reads", () => {
  const blocked = authorizeToolCall({
    backend: "itsm",
    verb: "search_tickets",
    caller: { oid: "oid", upn: "Jane Doe", armToken: null },
  });
  assert.equal(blocked.action, "blocked");
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd bridge && npm test -- test/identity.test.js`

- [ ] **Step 3: Implement**

In `identity.js`:
- Export `isEmailLikeUpn(value)` — true iff trimmed string matches `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- In `authorizeToolCall`, for `ITSM_CROSS_USER_VERBS`, treat missing **or** non-email-like UPN as blocked (`missing_user_token`).
- In `filterItsmResult`, when `emails.size === 0`, return generic denial (same shape as mismatch).

In `chat/teams.js`:
- Stop setting `upn: from.name`.
- Set `upn` only from email-like fields if present on `from` / `additionalProperties` (`userPrincipalName`, `email`, `mail`); else `null`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd bridge && npm test -- test/identity.test.js`

---

### Task 2: holmes-teams-bot — TRIAGE_URL client with identity

**Files:**
- Modify: `src/config.py`
- Modify: `src/bot.py`
- Create: `src/triage.py` (HTTP client + reply formatting)
- Modify: `charts/templates/deployment.yaml`
- Modify: `charts/values.yaml`
- Test: `tests/test_triage.py`

**Interfaces:**
- Consumes: PAS `POST /triage?wait=true` body `{ text, source, userOid, userUpn }` → JSON with `analysis` or `reply` (or 202 `{ id, poll }` then `GET` until done).
- Produces: Teams-visible text string; identity helpers reusable from bot.

- [ ] **Step 1: Failing tests** for payload shape and reply formatting

```python
def test_triage_payload_includes_identity():
    body = build_triage_body(text="hi", oid="abc", upn="u@cfc.com")
    assert body["userOid"] == "abc"
    assert body["userUpn"] == "u@cfc.com"
    assert body["source"]["type"] == "teams"

def test_format_triage_prefers_analysis():
    assert "hello" in format_triage_result({"lane": "infra_incident", "analysis": "hello"})
```

- [ ] **Step 2: Implement `src/triage.py` + config env vars**

- `TRIAGE_URL` (optional), `TRIAGE_TIMEOUT` (default 300), `TRIAGE_POLL_INTERVAL` (default 2).
- `call_triage(session, config, text, oid, upn)`: POST `?wait=true`; if 202, poll `poll` URL (absolute against TRIAGE_URL origin) until status done/failed or timeout.
- Extract text from `analysis`, else `reply`, else stringify safely (no tokens).

- [ ] **Step 3: Wire `bot.py`**

- Resolve oid from `from_property.aad_object_id` / `additional_properties`.
- Reuse `_requester_from_activity` for UPN (already prefers userPrincipalName/email/mail).
- If `TRIAGE_URL` set → triage path; else existing Holmes path.
- Keep access-enumeration refusal and conversation history on both paths (history still used for Holmes prompt; for triage send the user text — persona/history can stay Holmes-only for this PBI to limit scope, OR prepend history into triage text if already trivial — prefer sending user `text` only to triage to match bridge contract).

- [ ] **Step 4: Helm**

- `values.yaml`: `env.triageUrl: ""`, `env.triageTimeout: "300"`, `env.triagePollInterval: "2"`.
- `deployment.yaml`: emit `TRIAGE_URL` / `TRIAGE_TIMEOUT` / `TRIAGE_POLL_INTERVAL` when triageUrl set (or always emit timeout/interval).

- [ ] **Step 5: Run tests**

Run: `cd holmes-teams-bot && python -m pytest tests/test_triage.py tests/test_conversation.py tests/test_access_enumeration.py -q`

---

### Task 3: Checkpoint on AB#188124

- [ ] Post HTML progress comment listing PAS harden + bot TRIAGE_URL wiring.
- [ ] Confirm `create_ticket` still in `tier_3_approval`.
- [ ] Note remaining: GitOps set `TRIAGE_URL` in prod + SecOps pack (#188126).

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Fail-closed get | Task 1 |
| Email-like UPN + Teams adapter | Task 1 |
| Bot TRIAGE_URL + identity | Task 2 |
| create_ticket unchanged | Task 3 verify |
| Unit tests | Tasks 1–2 |
| WI evidence | Task 3 |
