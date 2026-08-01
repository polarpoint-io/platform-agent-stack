# confluence-toolset

Read-only Confluence access over REST, for environments where the
Confluence MCP isn't available or wanted. Reuses the service-account
approach from the existing docs-as-code publish pipeline.

## Not implemented yet

This directory is a placeholder. The rest of the stack works without it
— `itsm-support` simply has no Confluence toolset until this lands.

What it needs:

- REST client for Confluence page and search reads
- Service-account credential handling
- No write path — by design

## Open items

- **Read-only is a design constraint, not a default.** If a write path is
  ever added it needs tiering in
  [`../policy/risk-tiers.yaml`](../policy/risk-tiers.yaml) first.

## Related

- [`../swarm`](../swarm) — `itsm-support.toolsets: confluence-read`
