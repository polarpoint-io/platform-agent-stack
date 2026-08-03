// HolmesGPT stays outside this bridge entirely - its own chart, its own
// cluster DNS name, its own release cadence (see README "How it works").
// This is the one HTTP call the sre-investigator path makes. Endpoint
// and request/response shape confirmed against the real holmesgpt
// server source (server.py: POST /api/chat, ChatRequest.ask,
// ChatResponse.analysis) - not assumed from the chart comment alone.

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
