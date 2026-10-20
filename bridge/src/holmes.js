// The one HTTP call the sre-investigator path makes to HolmesGPT.
// Endpoint: POST /api/chat, request field ChatRequest.ask, response
// field ChatResponse.analysis.

import { holmesChatBody, holmesChatHeaders, sanitizeAzureError } from "./identity.js";

export async function askHolmes(holmesUrl, question, caller) {
  if (!holmesUrl) {
    throw new Error("HOLMES_URL is not configured");
  }
  const resp = await fetch(`${holmesUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: holmesChatHeaders(caller),
    body: JSON.stringify(holmesChatBody(question, caller)),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Holmes /api/chat returned ${resp.status}: ${sanitizeAzureError(text.slice(0, 500))}`);
  }
  const data = await resp.json();
  return {
    analysis: sanitizeAzureError(data.analysis || ""),
    toolCalls: data.tool_calls || [],
  };
}
