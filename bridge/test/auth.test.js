import { test } from "node:test";
import assert from "node:assert/strict";
import { tokensMatch, presentedToken, requireApprovalToken } from "../src/auth.js";
import { resetMetrics, render } from "../src/metrics.js";

const reqWith = (headers = {}, method = "POST", path = "/approvals/x/approve") => ({
  method,
  path,
  get: (n) => headers[n.toLowerCase()],
});

function runGuard(guard, req) {
  let status = null;
  let body = null;
  let nexted = false;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  guard(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

test("tokensMatch is true only for an exact match", () => {
  assert.equal(tokensMatch("s3cret", "s3cret"), true);
  assert.equal(tokensMatch("s3cret", "s3crey"), false);
  assert.equal(tokensMatch("s3cre", "s3cret"), false, "shorter must not match");
  assert.equal(tokensMatch("s3crett", "s3cret"), false, "longer must not match");
});

test("tokensMatch refuses empty and non-string input rather than passing it", () => {
  assert.equal(tokensMatch("", ""), false, "empty must never match empty");
  assert.equal(tokensMatch(undefined, "s3cret"), false);
  assert.equal(tokensMatch("s3cret", undefined), false);
  assert.equal(tokensMatch(null, null), false);
});

test("presentedToken reads Bearer, case-insensitively, and the fallback header", () => {
  assert.equal(presentedToken(reqWith({ authorization: "Bearer abc123" })), "abc123");
  assert.equal(presentedToken(reqWith({ authorization: "bearer abc123" })), "abc123");
  assert.equal(presentedToken(reqWith({ authorization: "  Bearer   abc123  " })), "abc123");
  assert.equal(presentedToken(reqWith({ "x-approval-token": "abc123" })), "abc123");
  assert.equal(presentedToken(reqWith({})), "");
  assert.equal(presentedToken(reqWith({ authorization: "Basic abc123" })), "", "Basic is not a bearer token");
});

test("FAILS CLOSED: no configured token disables the route entirely", () => {
  const r = runGuard(requireApprovalToken(""), reqWith({ authorization: "Bearer anything" }));
  assert.equal(r.nexted, false, "must not reach the handler");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no APPROVAL_TOKEN is configured/);
});

test("a correct token reaches the handler", () => {
  const r = runGuard(requireApprovalToken("s3cret"), reqWith({ authorization: "Bearer s3cret" }));
  assert.equal(r.nexted, true);
  assert.equal(r.status, null);
});

test("a wrong or missing token is 401 and never reaches the handler", () => {
  for (const headers of [{ authorization: "Bearer wrong" }, {}, { authorization: "Bearer " }]) {
    const r = runGuard(requireApprovalToken("s3cret"), reqWith(headers));
    assert.equal(r.nexted, false);
    assert.equal(r.status, 401);
  }
});

test("refusals are counted separately so misconfiguration is distinguishable from attack", () => {
  resetMetrics();
  runGuard(requireApprovalToken(""), reqWith({}));
  runGuard(requireApprovalToken("s3cret"), reqWith({ authorization: "Bearer wrong" }));
  const out = render();
  assert.match(out, /platform_agent_auth_refusals_total\{reason="not_configured"\} 1/);
  assert.match(out, /platform_agent_auth_refusals_total\{reason="bad_token"\} 1/);
});
