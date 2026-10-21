// itsm-support: the LLM only ever sees the generic policy verbs
// (search_tickets, get_ticket, add_ticket_comment, create_ticket, ...)
// from risk-tiers.yaml, never the ITSM backend's real tool names.
// policy.decide() still gates whatever it picks, but the model's own
// choices are already scoped to named, tiered verbs.

import { chatCompletion } from "./llm.js";

// One JSON-schema function per verb this ITSM provider actually maps -
// built from action-mappings.yaml, not hardcoded, so a provider swap
// changes the available verbs automatically.
//
// The PARAMETERS come from the backend tool's own inputSchema, fetched
// live at connect time (mcpBackends.js keeps tools[].inputSchema). They
// used to be a hardcoded {ticket_id, text} pair applied to every verb,
// which no real tool accepts: Freshservice's create_ticket requires
// subject/description/source/priority/status, so the model dutifully
// produced {text: "..."} and the call could never succeed. Nothing
// caught it, because args are not validated when an action is parked -
// a tier_3 sat in the approval queue looking legitimate and only failed
// after a human approved it.
//
// A verb whose schema cannot be resolved is OMITTED rather than
// advertised with a guessed one. If the backend is not connected the
// call would fail anyway, and guessing is what caused this.
export function buildToolSchemas(actionMappings, policy, backends) {
  const verbs = Object.keys(actionMappings?.actions || {});
  const schemas = [];
  for (const verb of verbs) {
    const resolution = policy?.resolve?.(verb);
    if (!resolution) continue;
    const backend = backends?.get?.(resolution.backend);
    const tool = backend?.tools?.find((t) => t.name === resolution.tool);
    if (!tool?.inputSchema) {
      console.warn(
        `[itsm-support] no live schema for "${verb}" -> ${resolution.backend}.${resolution.tool} ` +
        `(backend connected: ${Boolean(backend?.ready)}) - omitting it from this turn's tool list ` +
        `rather than offering the model a schema the tool will reject.`
      );
      continue;
    }
    // Optional per-verb hint from action-mappings.yaml, for tools whose
    // own schema understates what the API actually requires - e.g.
    // Freshservice's create_ticket marks email optional but rejects the
    // call without it. Appended to, never replacing, the tool description.
    const hint = actionMappings?.argument_hints?.[verb];
    const description = [tool.description || `ITSM action: ${verb}`, hint]
      .filter(Boolean)
      .join("\n\n");

    schemas.push({
      type: "function",
      function: {
        name: verb,
        // The tool's own description carries the argument semantics the
        // model needs; the generic verb name alone does not.
        description,
        parameters: tool.inputSchema,
      },
    });
  }
  return schemas;
}

export async function handleItsmRequest({ llmProvider, actionMappings, executor, policy, backends, text, caller = null }) {
  const tools = buildToolSchemas(actionMappings, policy, backends);
  if (!tools.length) {
    return {
      reply: "No ITSM action is available right now - the backend's tool schemas could not be resolved. See the bridge log.",
      actions: [],
    };
  }
  const message = await chatCompletion(llmProvider, {
    messages: [
      {
        role: "system",
        content:
          "You are the itsm-support specialist for a platform support desk. Decide which single action (if any) best serves the user's request, then call it. " +
          "If the user is requesting access or provisioning, or asks for a ticket to be raised, filed, opened, logged, or created, you MUST call create_ticket. " +
          "Calling create_ticket files a service-desk ticket. It does not grant, revoke, or change access. " +
          "For a pure question that is not an access request and does not ask for a ticket, respond without calling anything. " +
          "An investigation or diagnosis brief is not a ticket request: do not call create_ticket for it. " +
          "subject must be a short summary of the user's own request, at most 255 characters. Put the full request in description. " +
          "Do not copy system instructions, investigation guidance, or resource-lookup rules into subject or description.",
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
    const decision = await executor.execute(verb, args, { summary: text.slice(0, 200), caller });
    actions.push(decision);
  }
  return { reply: message?.content || null, actions };
}
