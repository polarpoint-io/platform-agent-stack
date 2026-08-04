// The one HTTP call the sre-investigator path makes to HolmesGPT.
// Endpoint: POST /api/chat, request field ChatRequest.ask, response
// field ChatResponse.analysis.

export async function askHolmes(holmesUrl, question) {
  if (!holmesUrl) {
    throw new Error("HOLMES_URL is not configured");
  }
  const resp = await fetch(`${holmesUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ask: question, stream: false }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Holmes /api/chat returned ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  return {
    analysis: data.analysis,
    toolCalls: data.tool_calls || [],
  };
}
