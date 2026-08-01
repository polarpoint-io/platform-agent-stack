# agent-swarm-topology

The orchestration definition: which agents exist, what each wraps or
owns, and how they're wired. This is the one repo that references every
other component — everything else is a leaf.

## What's here

- `swarm.config.json` — hierarchical topology:
  - `triage-router` — classifies incoming requests, routes them
  - `sre-investigator` — wraps existing HolmesGPT, read-only, untouched
  - `itsm-support` — new; ITSM backend and risk policy resolved from
    sibling repos at deploy time, not hardcoded here

## Why the paths look like `$ITSM_PROVIDERS_REPO/...`

This repo doesn't hardcode where `itsm-providers` or `agent-risk-policy`
live on disk — those are sibling repos, cloned separately, potentially at
different paths on different machines. `platform-agent-stack` is what
resolves those env vars before this config gets used; this repo alone is
not deployable without it.

## Depends on

[itsm-providers](../itsm-providers), [agent-risk-policy](../agent-risk-policy),
[confluence-toolset](../confluence-toolset) — all three referenced by
name/env-var, none of them vendored in.
