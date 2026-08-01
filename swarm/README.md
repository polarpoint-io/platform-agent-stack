# swarm

The orchestration definition: which agents exist, what each wraps or
owns, and how they're wired.

## What's here

- `swarm.config.json` — hierarchical topology:
  - `triage-router` — classifies incoming requests, routes them
  - `sre-investigator` — wraps existing HolmesGPT, read-only, untouched
  - `itsm-support` — ITSM backend and risk policy resolved by relative
    path within this repo

`maxAgents` is 4 against 3 defined agents — deliberate headroom for a
fourth specialist. `setup.sh` reads the value from here rather than
hardcoding it, so the two cannot drift.

## Paths

`actionPolicy` and `actionMapping` are relative to this directory:

```
actionPolicy   ../policy/risk-tiers.yaml
actionMapping  ../itsm-providers/action-mappings/${ITSM_PROVIDER}.yaml
```

## Related

- [`../policy`](../policy) — the tiers these agents are gated by
- [`../itsm-providers`](../itsm-providers) — backends and action mappings
- [`https://github.com/polarpoint-io/ruflo-bridge`](https://github.com/polarpoint-io/ruflo-bridge) — the runtime this runs on
