// The chat front door, as a pluggable adapter rather than a Slack special
// case - same shape as itsm-providers, for the same reason: the platform is a
// deployment choice, not something the agents or the policy should know about.
//
// An adapter's whole job is translation. It turns an inbound message into a
// queued /triage job, and turns a finished job back into a reply. It never
// touches the policy, never calls a backend, and never approves anything
// itself - it asks executor.approve() like every other caller, so a button in
// a chat client is gated by exactly the same tiers as a curl.
//
// THE CONSTRAINT THAT SHAPES ALL OF THIS: Slack wants an acknowledgement
// within 3 seconds, and Teams' Bot Framework expects the same. The measured
// lanes take ~6s (ITSM) and ~29s (infra), and runbook_draft runs to 180s. No
// adapter can answer inline. Every one of them acks, enqueues, and replies
// later from onResult.
//
// Adapters differ in one important way, which the interface has to allow for:
//
//   Slack  - Socket Mode dials OUT to Slack over a WebSocket. No inbound
//            endpoint, so it works from a private cluster with no ingress.
//   Teams  - Bot Framework has no Socket Mode equivalent and needs a public
//            HTTPS endpoint, so its adapter registers an Express route via
//            `routes` and the deployment has to be reachable from Microsoft.
//
// Hence `start()` receives the Express app: an adapter that needs a route can
// add one, and an adapter that doesn't simply ignores it.

import { createSlackAdapter } from "./slack.js";
import { createTeamsAdapter } from "./teams.js";

const ADAPTERS = {
  slack: createSlackAdapter,
  teams: createTeamsAdapter,
};

/**
 * @returns an adapter, or null when no chat front door is configured.
 *
 * Unknown provider names throw rather than silently running without a front
 * door - a typo in chatProvider should not look like "chat is switched off".
 */
export function createChatAdapter({ provider, config, deps }) {
  if (!provider || provider === "none") {
    console.log("[chat] no chat provider configured - /triage is HTTP only");
    return null;
  }
  const factory = ADAPTERS[provider];
  if (!factory) {
    throw new Error(
      `unknown chatProvider "${provider}" - expected one of: ${Object.keys(ADAPTERS).join(", ")}, or none`
    );
  }
  return factory({ config, deps });
}

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

/**
 * Is this user allowed to approve a tier-3 action?
 *
 * Shared by every adapter deliberately. Until now the only approval path was
 * an unauthenticated POST with a UUID, so anyone who could reach the bridge
 * could release a gated action. A chat button finally carries an identity,
 * and this is where that identity is actually checked - an empty allowlist
 * means nobody, not everybody, matching how the NetworkPolicy treats an empty
 * peer list.
 */
export function canApprove(userId, allowlist) {
  if (!userId) return false;
  const allowed = allowlist || [];
  if (!allowed.length) return false;
  return allowed.includes(userId);
}
