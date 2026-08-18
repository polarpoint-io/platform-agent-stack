// Authentication for the two routes that can CHANGE something.
//
// Until this existed, POST /approvals/:id/approve took no credentials at all:
// a UUID was the only thing between a caller and releasing a parked tier-3
// action, and the NetworkPolicy was the entire access control. That is
// defensible for a lab and not for production, and it was the last blocker
// before this could carry a real ITSM backend.
//
// Two routes are guarded, not one:
//   POST /approvals/:id/approve  - releases a parked tier-3
//   POST /actions/:verb          - executes a verb directly, skipping
//                                  classification entirely
// The second is easy to overlook and is arguably the sharper edge: it takes a
// verb by name. It is still subject to the risk tiers - a tier_3 verb parks
// rather than runs - but a tier_1 or tier_2 executes immediately.
//
// FAILS CLOSED. With no token configured the guarded routes return 503 and
// refuse everything, matching how an empty `approvers` list means nobody and an
// empty NetworkPolicy peer list means nobody. A missing credential must never
// read as "no authentication required".
//
// Chat approvals are unaffected: the Slack/Teams adapters hold the executor
// in-process and never traverse HTTP, so they are gated by `chat.approvers`
// instead. Turning this on does not break the front door.

import { timingSafeEqual } from "node:crypto";
import { authRefusals } from "./metrics.js";

/** Compare without leaking length or content through timing. */
export function tokensMatch(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Compare lengths separately and still run the constant-time compare
  // against a fixed-size buffer so the work done does not vary.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Pull a bearer token out of Authorization, or the X-Approval-Token header. */
export function presentedToken(req) {
  const header = req.get?.("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1].trim();
  return (req.get?.("x-approval-token") || "").trim();
}

/**
 * Express middleware guarding the state-changing routes.
 *
 * @param token the shared secret, from ESO. Empty disables the routes.
 */
export function requireApprovalToken(token) {
  return function guard(req, res, next) {
    if (!token) {
      // Say plainly why, because "403 on approve" with a correct token in hand
      // is otherwise a long afternoon.
      console.warn(`[auth] ${req.method} ${req.path} refused - APPROVAL_TOKEN is not set, so approvals over HTTP are disabled`);
      authRefusals.inc({ reason: "not_configured" });
      return res.status(503).json({
        error:
          "approvals over HTTP are disabled: no APPROVAL_TOKEN is configured. " +
          "Set externalSecrets.keys.approval (APPROVAL_TOKEN) to enable them, " +
          "or approve from Slack/Teams, which is gated by chat.approvers instead.",
      });
    }
    if (!tokensMatch(presentedToken(req), token)) {
      console.warn(`[auth] ${req.method} ${req.path} refused - bad or missing bearer token`);
      authRefusals.inc({ reason: "bad_token" });
      return res.status(401).json({ error: "a valid bearer token is required for this endpoint" });
    }
    return next();
  };
}
