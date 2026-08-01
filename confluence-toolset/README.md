# confluence-toolset

Read-only Confluence access over REST, for environments where the Confluence MCP isn't available or wanted.

> **Status: scaffold.** The name, the boundary and the open items below
> are settled; the implementation is not written yet. Nothing here is
> wired into a running stack.

## What will live here

- REST client for Confluence page and search reads
- Service-account credential handling, reusing the existing
  docs-as-code publish pipeline's approach
- No write path — by design

## Open items — resolve before this is used in anger

- **Read-only is a design constraint, not a default.** If a write path
  is ever added it needs tiering in
  [agent-risk-policy](../agent-risk-policy) first.

## How this fits

Consumed by [agent-swarm-topology](../agent-swarm-topology)
(`itsm-support.toolsets: confluence-read`).

See `platform-agent-stack` for the architecture diagram, the full repo
map, and how these components are composed.
