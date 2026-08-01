# llm-inference-providers

Which LLM backend the agents call — Azure AI Foundry now, Modelplane self-host later.

> **Status: scaffold.** The name, the boundary and the open items below
> are settled; the implementation is not written yet. Nothing here is
> wired into a running stack.

## What will live here

- Provider config for Azure AI Foundry (current)
- Provider config for Modelplane (later — *alongside* Foundry, not
  instead of it)
- A selection mechanism so swapping backends doesn't touch the swarm

## Open items — resolve before this is used in anger

- **Ruflo provider field names are unverified.** The Foundry config
  follows the general OpenAI-compatible shape; it has not been checked
  against Ruflo's current exact schema. Confirm before relying on it.

## How this fits

Referenced by [agent-swarm-topology](../agent-swarm-topology) for all agents'
LLM calls.

See `platform-agent-stack` for the architecture diagram, the full repo
map, and how these components are composed.
