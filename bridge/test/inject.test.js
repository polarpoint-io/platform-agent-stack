// Deployment facts injected into every backend call.
//
// The Atlassian Rovo MCP Server needs a cloudId on every tool call and its
// API-key auth is not bound to one. That value cannot come from the model:
// it has no way to know it, and a model-supplied cloudId is one that prompt
// injection can redirect into someone else's Atlassian site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendRegistry } from "../src/mcpBackends.js";

const inject = (i, a, warn = () => {}) => BackendRegistry.applyInjected(i, a, warn);

test("injected values are added to the call", () => {
  const out = inject({ cloudId: "abc" }, { issueIdOrKey: "SD-1" });
  assert.deepEqual(out, { issueIdOrKey: "SD-1", cloudId: "abc" });
});

test("injected values OVERRIDE the model - they are not defaults", () => {
  // The whole point: a value the model must not choose is not a default.
  const out = inject({ cloudId: "ours" }, { cloudId: "somebody-elses", summary: "x" });
  assert.equal(out.cloudId, "ours", "a model-supplied cloudId must never win");
  assert.equal(out.summary, "x", "everything else is left alone");
});

test("no injectArgs leaves the args untouched", () => {
  const args = { a: 1 };
  assert.equal(inject(null, args), args);
  assert.equal(inject(undefined, args), args);
});

test("undefined args still receive the injected values", () => {
  assert.deepEqual(inject({ cloudId: "abc" }, undefined), { cloudId: "abc" });
});

test("an UNRESOLVED placeholder is dropped, not injected verbatim", () => {
  // config.js leaves ${VAR} in place when the env var is unset. Injecting the
  // literal would send Atlassian "${ATLASSIAN_CLOUD_ID}" as a cloudId, which
  // reads as a supplied value rather than a missing one.
  const warnings = [];
  const out = inject(
    { cloudId: "${ATLASSIAN_CLOUD_ID}", projectKey: "SD" },
    { summary: "x" },
    (m) => warnings.push(m)
  );
  assert.equal("cloudId" in out, false, "the placeholder must not be injected");
  assert.equal(out.projectKey, "SD", "resolved values still inject");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unresolved placeholder/);
});

test("a placeholder does not mask a value the model supplied", () => {
  // Dropping the injection leaves whatever the model had. That is the honest
  // outcome - the call fails on a wrong cloudId rather than a nonsense one.
  const out = inject({ cloudId: "${UNSET}" }, { cloudId: "from-model" });
  assert.equal(out.cloudId, "from-model");
});

test("non-string injected values are passed through", () => {
  const out = inject({ limit: 50, flag: true }, {});
  assert.deepEqual(out, { limit: 50, flag: true });
});
