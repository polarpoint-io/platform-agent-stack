// Talks to whichever LLM backend llm-provider.yaml selects. Two shapes
// supported: `type: anthropic` (Anthropic's native Messages API) and
// `type: openai-compatible` (Modelplane/Foundry-style proxies). Callers
// always get back and pass in the OpenAI-style shape
// ({content, tool_calls: [{function: {name, arguments}}]}) - Anthropic
// requests/responses are translated to/from that shape here, so
// itsmAgent.js and everything else stays backend-agnostic.

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 1024;

async function anthropicCompletion(llmProvider, { messages, tools, toolChoice }) {
  // Anthropic wants system content as a top-level field, not a message.
  const systemMessages = messages.filter((m) => m.role === "system");
  const system = systemMessages.map((m) => m.content).join("\n\n") || undefined;
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const body = {
    model: llmProvider.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system,
    messages: conversation,
  };
  if (tools) {
    // OpenAI function schema -> Anthropic tool schema.
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    if (toolChoice === "required") body.tool_choice = { type: "any" };
    else if (typeof toolChoice === "object") body.tool_choice = { type: "tool", name: toolChoice.function?.name };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": llmProvider.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Anthropic API returned ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();

  // Anthropic's response -> the OpenAI-style shape callers expect.
  const textBlocks = data.content.filter((b) => b.type === "text").map((b) => b.text);
  const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");
  return {
    content: textBlocks.length ? textBlocks.join("\n") : null,
    tool_calls: toolUseBlocks.length
      ? toolUseBlocks.map((b) => ({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } }))
      : undefined,
  };
}

async function openaiCompatibleCompletion(llmProvider, { messages, tools, toolChoice }) {
  const endpoint = llmProvider.endpoint.replace(/\/$/, "");
  const body = { model: llmProvider.models.default, messages };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  const resp = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llmProvider.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message;
}

export async function chatCompletion(llmProvider, params) {
  if (llmProvider.type === "anthropic") return anthropicCompletion(llmProvider, params);
  if (llmProvider.type === "openai-compatible") return openaiCompatibleCompletion(llmProvider, params);
  throw new Error(`llm-provider type "${llmProvider.type}" is not supported - only "anthropic" and "openai-compatible" are implemented`);
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
