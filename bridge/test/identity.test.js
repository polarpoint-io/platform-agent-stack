import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorizeToolCall,
  callerFromTriageBody,
  constrainItsmArgs,
  filterItsmResult,
  holmesChatBody,
  holmesChatHeaders,
  isEmailLikeUpn,
  persistableCaller,
  requireCaller,
  sanitizeAzureError,
} from "../src/identity.js";

test("requireCaller reads userOid and does not put the ARM token in persistable form", () => {
  const caller = requireCaller({
    userOid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    userUpn: "user@example.com",
    delegatedTokens: { arm: "secret-token-value" },
  });
  assert.equal(caller.oid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(caller.armToken, "secret-token-value");
  const stored = persistableCaller(caller);
  assert.deepEqual(stored, {
    oid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    upn: "user@example.com",
  });
  assert.ok(!("armToken" in stored));
});

test("missing userOid is 401", () => {
  assert.throws(() => requireCaller({ text: "hello" }), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.code, "MISSING_IDENTITY");
    return true;
  });
});

test("Teams source without oid fails; CLI without source does not", () => {
  assert.throws(
    () => callerFromTriageBody({ text: "x", source: { type: "teams" } }),
    (err) => err.status === 401
  );
  assert.equal(callerFromTriageBody({ text: "x" }), null);
});

test("Azure tools without an ARM token are blocked once a caller is present", () => {
  const blocked = authorizeToolCall({
    backend: "azure",
    verb: "resourceGraph",
    caller: { oid: "oid", upn: "user@example.com", armToken: null },
  });
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.reason, "missing_user_token");
  const allowed = authorizeToolCall({
    backend: "itsm",
    verb: "add_ticket_comment",
    caller: { oid: "oid", upn: "user@example.com" },
  });
  assert.equal(allowed.action, "allow");
  const anonymous = authorizeToolCall({
    backend: "azure",
    verb: "resourceGraph",
    caller: null,
  });
  assert.equal(anonymous.action, "allow");
});

test("ticket reads without a UPN are blocked for an identified caller", () => {
  const blocked = authorizeToolCall({
    backend: "itsm",
    verb: "search_tickets",
    caller: { oid: "oid", upn: null },
  });
  assert.equal(blocked.action, "blocked");
});

test("create_ticket subject longer than 255 characters is clipped into the description", () => {
  const subject = `${"A".repeat(300)} tail`;
  const args = constrainItsmArgs("create_ticket", {
    subject,
    description: "short",
    email: "model@example.com",
  }, null);
  assert.equal(args.subject.length <= 255, true);
  assert.match(args.subject, /\.\.\.$/);
  assert.match(args.description, /tail/);
  assert.match(args.description, /^short/);
  assert.equal(args.email, "model@example.com");
});

test("create_ticket subject of 255 characters is left unchanged", () => {
  const subject = "B".repeat(255);
  const args = constrainItsmArgs("create_ticket", { subject, description: "d" }, null);
  assert.equal(args.subject, subject);
  assert.equal(args.description, "d");
});

test("create_ticket subject clipping does not split a surrogate pair", () => {
  // 251 ASCII chars + an astral emoji (2 UTF-16 code units) + 20 more chars.
  // A naive slice(0, 252) cuts between the emoji's two code units.
  const emoji = "\u{1F600}"; // U+1F600, a surrogate pair in UTF-16
  const subject = `${"A".repeat(251)}${emoji}${"B".repeat(20)}`;
  const args = constrainItsmArgs("create_ticket", { subject, description: "d" }, null);
  // Neither half may contain a lone surrogate.
  for (const s of [args.subject, args.description]) {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      const isSurrogate = code >= 0xd800 && code <= 0xdfff;
      if (!isSurrogate) continue;
      assert.equal(code >= 0xd800 && code <= 0xdbff, true, `lone low surrogate at ${i} in ${JSON.stringify(s)}`);
      assert.equal(i + 1 < s.length, true, `unpaired high surrogate at end of ${JSON.stringify(s)}`);
      const low = s.charCodeAt(i + 1);
      assert.equal(low >= 0xdc00 && low <= 0xdfff, true, `high surrogate not followed by low surrogate in ${JSON.stringify(s)}`);
      i++; // skip the low surrogate we just validated
    }
  }
  assert.equal(args.subject.length <= 255, true);
  assert.match(args.description, new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ITSM ticket reads are scoped to the caller email", () => {
  const args = constrainItsmArgs("search_tickets", { query: "open" }, {
    oid: "oid",
    upn: "user@example.com",
  });
  assert.equal(args.query, "(open) AND email:'user@example.com'");
  assert.equal(args.email, undefined);
});

test("holmesChatBody carries identity; sanitizeAzureError hides 403 detail", () => {
  const body = holmesChatBody("are the nodes healthy?", {
    oid: "oid",
    upn: "user@example.com",
    armToken: "secret-token-value",
  });
  assert.equal(body.user.oid, "oid");
  assert.equal(body.delegatedTokens.arm, "secret-token-value");
  assert.equal(
    sanitizeAzureError("AuthorizationFailed: The client does not have authorization"),
    "not found or not permitted"
  );
});

test("holmesChatHeaders carry oid and ARM token", () => {
  const headers = holmesChatHeaders({
    oid: "oid",
    upn: "user@example.com",
    armToken: "secret-token-value",
  });
  assert.equal(headers["X-User-Oid"], "oid");
  assert.equal(headers["X-Delegated-Arm"], "secret-token-value");
});

test("get_ticket for another requester is redacted", () => {
  const result = filterItsmResult(
    "get_ticket_by_id",
    { content: [{ type: "text", text: JSON.stringify({ email: "other@example.com", id: 9 }) }] },
    { oid: "oid", upn: "user@example.com" }
  );
  assert.equal(result.content[0].text, "not found or not permitted");
});

test("get_ticket with no parseable requester email is denied", () => {
  const result = filterItsmResult(
    "get_ticket_by_id",
    { content: [{ type: "text", text: JSON.stringify({ id: 9, subject: "secret" }) }] },
    { oid: "oid", upn: "user@example.com" }
  );
  assert.equal(result.content[0].text, "not found or not permitted");
});

test("display-name UPN blocks ITSM ticket reads", () => {
  assert.equal(isEmailLikeUpn("Jane Doe"), false);
  assert.equal(isEmailLikeUpn("user@example.com"), true);
  const blocked = authorizeToolCall({
    backend: "itsm",
    verb: "search_tickets",
    caller: { oid: "oid", upn: "Jane Doe", armToken: null },
  });
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.reason, "missing_user_token");
});

test("callers without userOid are not required to send On-Behalf-Of tokens", () => {
  const caller = callerFromTriageBody({ text: "list nodes", source: { type: "slack" } });
  assert.equal(caller, null);
  const azure = authorizeToolCall({
    backend: "azure",
    verb: "resourceGraph",
    caller: null,
  });
  assert.equal(azure.action, "allow");
  const tickets = authorizeToolCall({
    backend: "itsm",
    verb: "search_tickets",
    caller: null,
  });
  assert.equal(tickets.action, "allow");
  const headers = holmesChatHeaders(null);
  assert.equal(headers["X-Delegated-Arm"], undefined);
  assert.equal(headers["X-User-Oid"], undefined);
});
