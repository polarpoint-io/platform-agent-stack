# itsm-providers

Pluggable ITSM MCP backends. Freshservice today, swappable without
touching the swarm or the risk policy.

## Layout

```
providers/        <name>.mcp.json — the MCP server definition
action-mappings/  <name>.yaml — generic policy verbs to real tool names
```

`setup.sh` reads both, selected by `ITSM_PROVIDER`.

## Open items — resolve before this is used in anger

- **ServiceNow and Jira Service Management are unverified templates, not
  real config.** Several community MCP servers exist for each, with
  different install commands. Treat them as a starting shape.
- **Action mappings must not be guessed.** The generic verbs in
  [`../policy/risk-tiers.yaml`](../policy/risk-tiers.yaml) need mapping to
  whatever tool names your MCP server actually exposes. Connect first,
  read the live tool list, then write the mapping. A wrong mapping doesn't
  fail loudly — it silently ungates an action.

`setup.sh` catches part of that for you: it fails on a missing mapping,
and warns on any mapped verb that appears in no tier. It cannot tell you
that a verb is mapped to the *wrong* tool — only you can.

## Related

- [`../policy`](../policy) — the tiers these verbs are gated by
- [`../swarm`](../swarm) — resolves `action-mappings/${ITSM_PROVIDER}.yaml`
