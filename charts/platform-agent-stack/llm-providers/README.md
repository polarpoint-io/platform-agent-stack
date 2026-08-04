# llm-providers

Which LLM backend the agents call. Swapping backends shouldn't touch the
swarm.

## What's here

- `anthropic.yaml` — the active backend, calls the Anthropic Messages API
  directly
- `foundry.yaml` — Azure AI Foundry, OpenAI-compatible
- `modelplane.yaml.example` — self-hosted, OpenAI-compatible. Rename to
  `modelplane.yaml` to enable.

Credentials come from the environment in all three. Nothing secret
belongs in these files.

The split between `models.default` and `models.triage` (where present)
is the point: triage is high-volume and low-stakes, investigation is the
opposite, so a cheaper model on the router is worth having.

## Related

- [`../swarm`](../swarm) — the agents whose calls this routes
