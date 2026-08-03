# llm-providers

Which LLM backend the agents call — Azure AI Foundry now, Modelplane
self-host later. Swapping backends shouldn't touch the swarm.

## What's here

- `foundry.yaml` — Azure AI Foundry, the current backend
- `modelplane.yaml.example` — self-hosted, intended to run *alongside*
  Foundry rather than replace it. Rename to `modelplane.yaml` to enable.

Credentials come from the environment in both. Nothing secret belongs in
these files.

The split between `models.default` and `models.triage` is the point:
triage is high-volume and low-stakes, investigation is the opposite, so a
cheaper model on the router is worth having.

## Open items

- **Ruflo provider field names are unverified.** The Foundry config
  follows the general OpenAI-compatible shape; it has not been checked
  against Ruflo's current exact schema. Confirm before relying on it.

## Related

- [`../swarm`](../swarm) — the agents whose calls this routes
