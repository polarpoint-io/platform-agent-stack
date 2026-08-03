// Talks to whichever LLM backend llm-provider.yaml selects. Both
// modelplane.yaml and foundry.yaml declare `type: openai-compatible`,
// so this assumes the standard OpenAI chat-completions shape
// (POST {endpoint}/chat/completions, Bearer apiKey). Both provider
// files carry their own "TODO(verify): schema unconfirmed" note - same
// caveat applies here. Confirm against your real Modelplane endpoint
// before trusting this in production; this is the same "verify against
// the live thing, not the example" rule the ITSM providers carry.

export async function chatCompletion(llmProvider, { messages, tools, toolChoice }) {
  if (llmProvider.type !== "openai-compatible") {
    throw new Error(`llm-provider type "${llmProvider.type}" is not supported yet - only openai-compatible is implemented`);
  }
  const endpoint = llmProvider.endpoint.replace(/\/$/, "");
  const body = {
    model: llmProvider.models.default,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  const resp = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${llmProvider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message;
}

// Front-door classification. Deliberately a single cheap completion, not
// a tool-calling loop - "which lane" is a much smaller decision than
// "what to do about it", and keeping it separate means a bad
// classification never wastes an ITSM/Holmes call.
export async function classify(llmProvider, text) {
  const message = await chatCompletion(llmProvider, {
    messages: [
      {
        role: "system",
        content:
          'Classify the message into exactly one of: "infra_incident" (an alert, outage, error, degraded service - anything about running infrastructure), "itsm_ticket" (a question about a support ticket, an access request, "how do I", anything that belongs in the service desk), or "unknown". Reply with ONLY the label, nothing else.',
      },
      { role: "user", content: text },
    ],
  });
  const label = (message?.content || "").trim().toLowerCase();
  if (label.includes("infra")) return "infra_incident";
  if (label.includes("itsm")) return "itsm_ticket";
  return "unknown";
}
