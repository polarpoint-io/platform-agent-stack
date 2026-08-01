# itsm-providers

Pluggable ITSM MCP backends. Freshservice today, swappable without touching the swarm or the risk policy.

> **Status: scaffold.** The name, the boundary and the open items below
> are settled; the implementation is not written yet. Nothing here is
> wired into a running stack.

## What will live here

- `<provider>.mcp.json` per backend — the MCP server definition
- `action-mappings/<provider>.yaml` — generic policy verbs mapped to that
  server's real tool names

## Open items — resolve before this is used in anger

- **ServiceNow and Jira Service Management files are unverified
  templates, not real config.** Several community MCP servers exist for
  each, with different install commands. Treat them as a starting shape.
- **Action mappings must not be guessed.** The generic verbs in
  [agent-risk-policy](../agent-risk-policy) need mapping to whatever tool
  names your MCP server actually exposes. Connect first, read the live
  tool list, then write the mapping. A wrong mapping doesn't fail loudly
  — it silently ungates an action.
- **Layout is unsettled.** `platform-agent-stack/setup.sh` currently
  accepts the provider file at either `providers/<name>.mcp.json` or
  `<name>.mcp.json` and reports both on failure. Pick one and drop the
  other once this repo has real contents.

## How this fits

Consumed by [agent-swarm-topology](../agent-swarm-topology)
(`itsm-support.actionMapping`) and wired by
[platform-agent-stack](../platform-agent-stack).

See `platform-agent-stack` for the architecture diagram, the full repo
map, and how these components are composed.
