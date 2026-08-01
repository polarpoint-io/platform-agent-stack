# llm-providers

Which LLM backend the agents call — Azure AI Foundry now, Modelplane
self-host later. Swapping backends shouldn't touch the swarm.

## What will live here

- Provider config for Azure AI Foundry (current)
- Provider config for Modelplane (later — *alongside* Foundry, not
  instead of it)
- A selection mechanism so a swap doesn't reach into agent definitions

## Open items

- **Ruflo provider field names are unverified.** The Foundry config
  follows the general OpenAI-compatible shape; it has not been checked
  against Ruflo's current exact schema. Confirm before relying on it.

## Related

- [`../swarm`](../swarm) — the agents whose calls this routes
