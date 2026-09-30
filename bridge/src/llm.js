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
        // The PRECEDENCE RULE below is not cosmetic. Observed 2026-08-19:
        // "Please raise a ticket ... the build agent has run out of disk and
        // pipelines are failing" classified as infra_incident, because the
        // subject matter is infrastructure and the old prompt said "anything
        // about running infrastructure". The infra lane is READ-ONLY and has no
        // ticketing tool, so it could not do the one thing asked - it replied
        // about a disabled ServiceNow toolset and nothing was filed. Misrouting
        // that way is a dead end, not a near miss, so an explicit ask for a
        // ticket has to beat the topic.
        //
        // "how do I" used to sit unconditionally under itsm_ticket. Observed
        // 2026-09-30: "how do I add an MCP for Grafana" landed in itsm_ticket,
        // whose only tools are the ITSM provider's ticket/KB API - it has no
        // Confluence search and no runbook tool, so the model could not look
        // anything up and just asked clarifying questions instead of finding
        // the runbook. infra_incident is the lane with runbook_search and real
        // Confluence access. The distinction that actually matters is not the
        // words "how do I", it's what's being asked how-to about: a technical/
        // platform question belongs in infra_incident so it can be looked up;
        // an access/provisioning "how do I" belongs in itsm_ticket because
        // that's a service-desk request regardless of phrasing.
        content:
          'Classify the message into exactly one of: "infra_incident", "itsm_ticket", or "unknown". ' +
          'Reply with ONLY the label, nothing else.\n\n' +
          'PRECEDENCE RULE, apply this first: if the message explicitly asks for a ticket to be raised, ' +
          'filed, opened, logged or created, classify it "itsm_ticket" EVEN IF the subject is ' +
          'infrastructure. Only that lane can create tickets; the infrastructure lane is read-only, so ' +
          'routing such a request there means nothing happens at all.\n\n' +
          '"infra_incident" - someone wants something INVESTIGATED, explained or looked up: an alert, ' +
          'an outage, an error, a degraded service, "why is X failing", "what is wrong with Y", or a ' +
          'technical/platform "how do I" or "how to" question about infrastructure, Kubernetes, an MCP ' +
          'server, a runbook, or how something in the platform works or is configured (e.g. "how do I ' +
          'add an MCP for Grafana", "how do I configure X"). This lane has runbook and documentation ' +
          'search; route a technical how-to here even though it is phrased as "how do I".\n' +
          '"itsm_ticket" - a request that belongs in the service desk: raising or updating a ticket, an ' +
          'access or provisioning request (e.g. "how do I get access to X", "how do I request Y"), or ' +
          'a question about an existing ticket.\n' +
          '"unknown" - neither of the above.',
      },
      { role: "user", content: text },
    ],
  });
  const label = (message?.content || "").trim().toLowerCase();
  if (label.includes("infra")) return "infra_incident";
  if (label.includes("itsm")) return "itsm_ticket";
  return "unknown";
}
