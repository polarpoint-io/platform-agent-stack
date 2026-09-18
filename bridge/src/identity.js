// Caller identity on POST /triage. Teams (and holmes-teams-bot) must send
// userOid; Azure and unfiltered ITSM reads fail closed without a user token.
// Never log armToken.

const GENERIC_DENIED = "not found or not permitted";

const USER_TOKEN_BACKENDS = new Set([
  "azure",
  "holmes-azure-mcp",
]);

export const ITSM_CROSS_USER_VERBS = new Set([
  "filter_tickets",
  "get_ticket",
  "get_ticket_by_id",
  "search_tickets",
]);

export function requireCaller(body) {
  const oid = String(body?.userOid || body?.user?.oid || "").trim();
  if (!oid) {
    const err = new Error("body.userOid is required");
    err.code = "MISSING_IDENTITY";
    err.status = 401;
    throw err;
  }
  return {
    oid,
    upn: body?.userUpn || body?.user?.upn || null,
    armToken: body?.delegatedTokens?.arm || null,
  };
}

/**
 * Teams HTTP front door must identify the user. Alert poller / CLI (no
 * source.type=teams and no userOid) keep the previous unauthenticated path.
 */
export function callerFromTriageBody(body) {
  const isTeams = body?.source?.type === "teams";
  const hasOidField = Boolean(body?.userOid || body?.user?.oid);
  if (isTeams || hasOidField) return requireCaller(body);
  return null;
}

export function persistableCaller(caller) {
  if (!caller?.oid) return null;
  return { oid: caller.oid, upn: caller.upn || null };
}

export function sanitizeAzureError(message) {
  const text = String(message || "");
  if (/AuthorizationFailed|Forbidden|403|does not have authorization/i.test(text)) {
    return GENERIC_DENIED;
  }
  return text;
}

/**
 * Fail closed on the identified-user path. Never fall back to workload
 * identity or the org ITSM API key for those callers.
 */
export function authorizeToolCall({ backend, verb, caller }) {
  if (!caller?.oid) return { action: "allow" };
  const needsUserToken = USER_TOKEN_BACKENDS.has(backend) || USER_TOKEN_BACKENDS.has(verb);
  if (needsUserToken && !caller.armToken) {
    return {
      action: "blocked",
      reason: "missing_user_token",
      outcome: "blocked",
    };
  }
  if (ITSM_CROSS_USER_VERBS.has(verb) && !caller.upn) {
    return {
      action: "blocked",
      reason: "missing_user_token",
      outcome: "blocked",
    };
  }
  return { action: "allow" };
}

export function constrainItsmArgs(verb, args, caller) {
  const out = { ...(args || {}) };
  if (!caller?.upn) return out;
  if (ITSM_CROSS_USER_VERBS.has(verb) || verb === "create_ticket") {
    out.email = caller.upn;
  }
  return out;
}

export function holmesChatBody(text, caller) {
  if (!caller?.oid) {
    return { ask: text, stream: false };
  }
  return {
    ask: text,
    stream: false,
    user: { oid: caller.oid, upn: caller.upn },
    delegatedTokens: caller.armToken ? { arm: caller.armToken } : {},
  };
}
