import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorizeToolCall,
  callerFromTriageBody,
  constrainItsmArgs,
  holmesChatBody,
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

test("ITSM ticket reads are scoped to the caller email", () => {
  const args = constrainItsmArgs("search_tickets", { query: "open" }, {
    oid: "oid",
    upn: "user@example.com",
  });
  assert.equal(args.email, "user@example.com");
  assert.equal(args.query, "open");
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
