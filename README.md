<p align="center">
  <img src="assets/hero.svg" alt="platform-agent-stack — composes the eight component repos into one runnable stack" width="100%">
</p>

# platform-agent-stack

**Not one of the components you asked to split out — this is the piece
that composes the other seven.** Worth calling out explicitly: splitting
a bundle into single-purpose repos is the right move, but it creates a
new problem the bundle didn't have — nothing tells you how they fit back
together, or in what order to bring them up. That's what this repo is
for. If you'd rather fold this into `agent-swarm-topology` instead of
keeping it separate, that's a reasonable call too — it's here as a
default, not a strong opinion.

## What's here

- `stack.yaml` — every component repo and what it owns, in one place
- `setup.sh` — clones any sibling repo not already checked out next to
  this one, writes `stack.env` with the `ITSM_PROVIDERS_REPO` /
  `RISK_POLICY_REPO` / `CONFLUENCE_TOOLSET_REPO` / `SWARM_TOPOLOGY_REPO`
  paths, merges the chosen ITSM provider into `ruflo-bridge`'s
  `.mcp.json` (backing up the original first), and runs swarm init
- `stack.env` — generated, git-ignored. `source` it, or add it to your
  `.envrc`. The script runs as a subprocess and so cannot set variables
  in your shell; this file is how they get there.

## Ruflo version

`setup.sh` pins `RUFLO_VERSION` (default `3.30.2`) and refuses to run
below `3.16.3`. Versions before that ship a docker-compose default which
exposes the MCP bridge's `POST /mcp` endpoints unauthenticated —
CVE-2026-59726 ("RufRoot", CVSS 10.0): unauthenticated RCE in the bridge
container, provider API key theft, and AgentDB memory poisoning.
Advisory GHSA-c4hm-4h84-2cf3.

The patch closes the *default* exposure. It does not authenticate a
bridge endpoint you publish on purpose — the NetworkPolicy check is
still yours to do.

## Assumed layout

```
polarpoint/
├── platform-agent-stack/   ← run setup.sh from here
├── ruflo-bridge/
├── agent-swarm-topology/
├── mongostate-crossplane/
├── llm-inference-providers/
├── itsm-providers/
├── confluence-toolset/
└── agent-risk-policy/
```

`BASE_DIR` in `setup.sh` defaults to `..` — override it if you check
these out somewhere else.
