// Regression tests for the bug that made a tier_3 approval a no-op:
// buildToolSchemas advertised a hardcoded {ticket_id, text} shape for
// every verb, so the model produced arguments no real tool accepts. The
// call was still parked, a human approved it, and only then did the
// backend reject it - with the error wrapped in a 200 response.
//
// These use a stub backend rather than a live server: the point is that
// the schema offered to the model is the BACKEND'S, whatever it happens
// to be, not one this file invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolSchemas } from "../src/itsmAgent.js";
import { Policy } from "../src/policy.js";

const riskTiers = {
  default_policy: { unlisted_action: "tier_4_draft_only", on_unlisted: "warn" },
  risk_tiers: {
    tier_1_auto: { actions: ["search_tickets"] },
    tier_3_approval: { actions: ["create_ticket"] },
  },
};

const actionMappings = {
  provider: "stub",
  actions: { search_tickets: "filter_tickets", create_ticket: "create_ticket" },
};

const createTicketSchema = {
  type: "object",
  required: ["subject", "description", "source", "priority", "status"],
  properties: {
    subject: { type: "string" },
    description: { type: "string" },
    source: {}, priority: {}, status: {},
  },
};

function backendsWith(tools, ready = true) {
  return { get: (name) => (name === "itsm" ? { ready, tools } : undefined) };
}

const policy = new Policy({ riskTiers, actionMappings });

test("parameters come from the backend tool's inputSchema, not a guess", () => {
  const schemas = buildToolSchemas(actionMappings, policy, backendsWith([
    { name: "create_ticket", description: "Create a ticket", inputSchema: createTicketSchema },
    { name: "filter_tickets", description: "Filter", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  ]));

  const create = schemas.find((s) => s.function.name === "create_ticket");
  assert.deepEqual(create.function.parameters, createTicketSchema);
  assert.deepEqual(create.function.parameters.required,
    ["subject", "description", "source", "priority", "status"]);

  // The specific regression: the old hardcoded shape must not reappear.
  assert.ok(!("text" in create.function.parameters.properties),
    "create_ticket must not advertise the invented free-text 'text' property");

  const search = schemas.find((s) => s.function.name === "search_tickets");
  assert.deepEqual(Object.keys(search.function.parameters.properties), ["query"]);
});

test("each verb gets its own schema - they are not all identical", () => {
  const schemas = buildToolSchemas(actionMappings, policy, backendsWith([
    { name: "create_ticket", inputSchema: createTicketSchema },
    { name: "filter_tickets", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  ]));
  const [a, b] = schemas.map((s) => JSON.stringify(s.function.parameters));
  assert.notEqual(a, b, "every verb sharing one schema is exactly the original bug");
});

test("a verb with no resolvable schema is omitted, never guessed", () => {
  // Tool missing from the backend entirely.
  let schemas = buildToolSchemas(actionMappings, policy, backendsWith([
    { name: "filter_tickets", inputSchema: { type: "object", properties: {} } },
  ]));
  assert.deepEqual(schemas.map((s) => s.function.name), ["search_tickets"]);

  // Backend not connected at all.
  schemas = buildToolSchemas(actionMappings, policy, { get: () => undefined });
  assert.deepEqual(schemas, []);

  // Tool present but carrying no schema.
  schemas = buildToolSchemas(actionMappings, policy, backendsWith([
    { name: "create_ticket" }, { name: "filter_tickets" },
  ]));
  assert.deepEqual(schemas, []);
});

test("an unmapped verb is never offered to the model", () => {
  const withUnmapped = {
    provider: "stub",
    actions: { ...actionMappings.actions, close_ticket: undefined },
  };
  delete withUnmapped.actions.close_ticket;
  const schemas = buildToolSchemas(withUnmapped, policy, backendsWith([
    { name: "create_ticket", inputSchema: createTicketSchema },
    { name: "filter_tickets", inputSchema: { type: "object", properties: {} } },
  ]));
  assert.ok(!schemas.some((s) => s.function.name === "close_ticket"));
});
