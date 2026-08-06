// The chat layer is a translation shim, and these test the two things that
// actually matter about it: that approving is gated on identity, and that a
// finished job is described honestly - including its tier and whether
// anything ran.
//
// The adapters themselves need @slack/bolt or botbuilder and a live service,
// so they aren't exercised here. What IS exercised is everything an adapter
// depends on to behave correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canApprove, createChatAdapter, SUPPORTED_PROVIDERS } from "../src/chat/index.js";
import { summariseJob, describeAction, pendingApprovalsIn } from "../src/chat/format.js";

// --- who may approve ------------------------------------------------------

test("an empty approver list means nobody, not everybody", () => {
  // The failure mode to avoid: an unset config quietly making every user an
  // approver. Same reasoning as the NetworkPolicy's empty peer list.
  assert.equal(canApprove("U123", []), false);
  assert.equal(canApprove("U123", undefined), false);
});

test("only listed users may approve", () => {
  const allow = ["U_ONCALL", "U_LEAD"];
  assert.equal(canApprove("U_ONCALL", allow), true);
  assert.equal(canApprove("U_RANDOM", allow), false);
});

test("a missing user id is never an approver", () => {
  // A malformed payload must not read as an authorised one.
  assert.equal(canApprove(undefined, ["U1"]), false);
  assert.equal(canApprove("", ["U1", ""]), false);
});

// --- provider selection ---------------------------------------------------

test("no provider configured is a supported state, not an error", () => {
  assert.equal(createChatAdapter({ provider: "none", config: {}, deps: {} }), null);
  assert.equal(createChatAdapter({ provider: "", config: {}, deps: {} }), null);
});

test("an unknown provider throws rather than silently disabling chat", () => {
  // A typo in chatProvider should not look like "chat is switched off".
  assert.throws(
    () => createChatAdapter({ provider: "slakc", config: {}, deps: {} }),
    /unknown chatProvider "slakc"/
  );
});

test("both platforms are registered", () => {
  assert.deepEqual(SUPPORTED_PROVIDERS.sort(), ["slack", "teams"]);
});

// --- what a human is told -------------------------------------------------

test("a parked action says nothing has run, and names the tier", () => {
  const line = describeAction({
    verb: "create_ticket", tier: "tier_3_approval", action: "park", approvalId: "abc",
  });
  assert.match(line, /needs approval/);
  assert.match(line, /tier_3_approval/);
  assert.match(line, /Nothing has been executed/);
});

test("a blocked action gives the reason", () => {
  const line = describeAction({
    verb: "update_ticket_status", tier: "tier_2_notify", action: "blocked",
    reason: "no action mapping",
  });
  assert.match(line, /blocked/);
  assert.match(line, /no action mapping/);
});

test("an executed tier_1 is not dressed up as an approval", () => {
  const line = describeAction({ verb: "search_tickets", tier: "tier_1_auto", action: "execute", notify: false });
  assert.match(line, /Ran/);
  assert.doesNotMatch(line, /approval/i);
});

test("a failed job reports the failure rather than an empty summary", () => {
  const s = summariseJob({ status: "failed", error: "Holmes unreachable" });
  assert.match(s, /failed/i);
  assert.match(s, /Holmes unreachable/);
});

test("a failed job with no reason still says something", () => {
  assert.match(summariseJob({ status: "failed" }), /no reason given/);
});

test("an infra result surfaces Holmes' analysis", () => {
  const s = summariseJob({
    status: "done",
    result: { lane: "infra_incident", analysis: "The pod was OOMKilled.\n\nMore detail follows." },
  });
  assert.match(s, /OOMKilled/);
  assert.ok(!s.includes("More detail follows"), "only the first paragraph, for a thread reply");
});

test("an itsm result lists every action, not just the first", () => {
  const s = summariseJob({
    status: "done",
    result: { lane: "itsm_ticket", actions: [
      { verb: "search_tickets", tier: "tier_1_auto", action: "execute" },
      { verb: "create_ticket", tier: "tier_3_approval", action: "park", approvalId: "x" },
    ]},
  });
  assert.match(s, /search_tickets/);
  assert.match(s, /create_ticket/);
});

// --- approval buttons -----------------------------------------------------

test("only parked actions get an approve button", () => {
  const job = { result: { actions: [
    { verb: "search_tickets", action: "execute" },
    { verb: "create_ticket", action: "park", approvalId: "id-1" },
    { verb: "grant_access", action: "draft" },
    { verb: "close_ticket", action: "blocked" },
  ]}};
  const parked = pendingApprovalsIn(job);
  assert.deepEqual(parked.map((a) => a.verb), ["create_ticket"]);
});

test("a parked action with no approvalId is not offered", () => {
  // Nothing to approve against - a button would 404 on click.
  const job = { result: { actions: [{ verb: "create_ticket", action: "park" }] } };
  assert.deepEqual(pendingApprovalsIn(job), []);
});

test("a job with no actions offers no buttons", () => {
  assert.deepEqual(pendingApprovalsIn({ result: {} }), []);
  assert.deepEqual(pendingApprovalsIn({}), []);
});

// --- delivery addressing --------------------------------------------------

test("a teams job carries its own conversation reference", async () => {
  // It used to live in an in-memory Map, so a pod restart stranded every
  // in-flight Teams request with no way to reply. Slack never had this
  // problem: channel and thread ids are already on the job.
  const { pendingApprovalsIn } = await import("../src/chat/format.js");
  const job = {
    id: "j1",
    source: { type: "teams", ref: { conversation: { id: "19:abc" }, serviceUrl: "https://smba" }, user: "aad-1" },
    result: { lane: "itsm_ticket", actions: [] },
  };
  assert.ok(job.source.ref, "the reference must travel with the job");
  assert.equal(JSON.parse(JSON.stringify(job.source.ref)).conversation.id, "19:abc",
    "and must be plain JSON so it survives the job store");
  assert.deepEqual(pendingApprovalsIn(job), []);
});

// ---------------------------------------------------------------------------
// composePrompt - what the agent actually receives from Slack.
//
// These exist because the bot used to ask a clarifying question it could never
// receive an answer to: each mention was a standalone job with no thread
// history, and a reply without an @mention raised no event at all.
import { composePrompt } from "../src/chat/slack.js";

test("prior turns are included so a follow-up answer means something", () => {
  const out = composePrompt({
    transcript: ["user: raise a ticket about disk pressure", "assistant: which requester?"],
    email: null,
    text: "surj@polarpoint.io",
  });
  assert.match(out, /Earlier in this thread:/);
  assert.match(out, /raise a ticket about disk pressure/);
  assert.match(out, /assistant: which requester\?/);
  // The new message is last, so it reads as the current ask.
  assert.ok(out.trimEnd().endsWith("surj@polarpoint.io"));
});

test("the requester is stated, so create_ticket stops having to ask", () => {
  const out = composePrompt({ transcript: [], email: "surj@polarpoint.io", text: "raise a ticket" });
  assert.match(out, /The person making this request is surj@polarpoint\.io/);
  assert.match(out, /requester email/);
});

test("a first message with no history and no resolvable email is just the text", () => {
  const out = composePrompt({ transcript: [], email: null, text: "what is broken" });
  assert.strictEqual(out, "what is broken");
});
