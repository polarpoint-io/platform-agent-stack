# confluence-toolset

Read-only Confluence access over REST, for environments where the
Confluence MCP isn't available or wanted. Reuses the service-account
approach from the existing docs-as-code publish pipeline.

## What will live here

- REST client for Confluence page and search reads
- Service-account credential handling
- No write path — by design

## Open items

- **Read-only is a design constraint, not a default.** If a write path is
  ever added it needs tiering in
  [`../policy/risk-tiers.yaml`](../policy/risk-tiers.yaml) first.

## Related

- [`../swarm`](../swarm) — `itsm-support.toolsets: confluence-read`
