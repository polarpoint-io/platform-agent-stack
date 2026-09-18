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
 * On-Behalf-Of is opt-in. Slack, CLI, alert pollers, and any caller that
 * omits source.type=teams and userOid keep the previous unauthenticated
 * path (workload identity / org ITSM key). Teams, or any body that
 * includes userOid, fail closed without a verified caller.
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

function emailQueryClause(upn) {
  const safe = String(upn || "").replace(/'/g, "");
  return `email:'${safe}'`;
}

export function constrainItsmArgs(verb, args, caller) {
  const out = { ...(args || {}) };
  if (!caller?.upn) return out;
  if (verb === "filter_tickets" || verb === "search_tickets") {
    const clause = emailQueryClause(caller.upn);
    const raw = String(out.query || "").trim();
    const stripped = raw
      .replace(/\bemail\s*:\s*'[^']*'/gi, "")
      .replace(/\bemail\s*:\s*"[^"]*"/gi, "")
      .replace(/\s+AND\s+/gi, " AND ")
      .replace(/^\s*AND\s*|\s*AND\s*$/gi, "")
      .trim();
    out.query = stripped ? `(${stripped}) AND ${clause}` : clause;
    delete out.email;
    return out;
  }
  if (ITSM_CROSS_USER_VERBS.has(verb) || verb === "create_ticket") {
    out.email = caller.upn;
  }
  return out;
}

function toolResultText(result) {
  const structured = result?.structuredContent?.result;
  if (typeof structured === "string") return structured;
  if (structured && typeof structured === "object") {
    try {
      return JSON.stringify(structured);
    } catch {
      return "";
    }
  }
  return (result?.content || [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function requesterEmailsFromItsmResult(result) {
  const text = toolResultText(result);
  const emails = new Set();
  const add = (value) => {
    const s = String(value || "").trim().toLowerCase();
    if (s.includes("@")) emails.add(s);
  };
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed?.tickets || parsed?.ticket
        ? [].concat(parsed.tickets || parsed.ticket)
        : parsed
          ? [parsed]
          : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      add(row.email);
      add(row.requester_email);
      add(row.requester?.email);
      add(row.requester?.mail);
    }
  } catch {
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
      add(match[0]);
    }
  }
  return emails;
}

export function filterItsmResult(verb, result, caller) {
  if (!caller?.upn) return result;
  if (verb !== "get_ticket" && verb !== "get_ticket_by_id") return result;
  const emails = requesterEmailsFromItsmResult(result);
  if (emails.size === 0) return result;
  if (emails.has(String(caller.upn).toLowerCase())) return result;
  return {
    content: [{ type: "text", text: GENERIC_DENIED }],
    isError: false,
  };
}

export function holmesChatHeaders(caller) {
  const headers = { "content-type": "application/json" };
  if (caller?.oid) headers["X-User-Oid"] = String(caller.oid);
  if (caller?.upn) headers["X-User-Upn"] = String(caller.upn);
  if (caller?.armToken) headers["X-Delegated-Arm"] = String(caller.armToken);
  return headers;
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
