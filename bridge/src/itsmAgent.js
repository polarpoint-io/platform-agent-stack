// itsm-support: the LLM only ever sees the generic policy verbs
// (search_tickets, get_ticket, add_ticket_comment, create_ticket, ...)
// from risk-tiers.yaml, never the ITSM backend's real tool names.
// policy.decide() still gates whatever it picks, but the model's own
// choices are already scoped to named, tiered verbs.

import { chatCompletion } from "./llm.js";

// One JSON-schema function per verb this ITSM provider actually maps -
// built from action-mappings.yaml, not hardcoded, so a provider swap
// changes the available verbs automatically.
function buildToolSchemas(actionMappings) {
  const verbs = Object.keys(actionMappings?.actions || {});
  return verbs.map((verb) => ({
    type: "function",
    function: {
      name: verb,
      description: `ITSM action: ${verb}`,
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket ID, if this action targets a specific ticket" },
          text: { type: "string", description: "Free-text content for this action (comment body, ticket description, search query, etc.)" },
        },
      },
    },
  }));
}

export async function handleItsmRequest({ llmProvider, actionMappings, executor, text }) {
  const tools = buildToolSchemas(actionMappings);
  const message = await chatCompletion(llmProvider, {
    messages: [
      {
        role: "system",
        content:
          "You are the itsm-support specialist for a platform support desk. Decide which single action (if any) best serves the user's request, then call it. Only call an action if it's clearly needed - for a pure question, you may respond without calling anything.",
      },
      { role: "user", content: text },
    ],
    tools,
  });

  if (!message?.tool_calls?.length) {
    return { reply: message?.content || "No action needed.", actions: [] };
  }

  const actions = [];
  for (const call of message.tool_calls) {
    const verb = call.function?.name;
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || "{}");
    } catch {
      // model returned malformed JSON args - fall through with empty args
    }
    const decision = await executor.execute(verb, args, { summary: text.slice(0, 200) });
    actions.push(decision);
  }
  return { reply: message?.content || null, actions };
}
