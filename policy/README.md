# agent-risk-policy

Risk-tiered action gating — what an agent can do unattended vs. what
needs a human. Written in generic verbs, deliberately not tied to any
one tool's actual API, and deliberately its own repo: this is the kind
of thing worth reusing across every agent you build, not just this one,
and a policy change shouldn't require a code review of the swarm itself.

## What's here

- `risk-tiers.yaml` — four tiers, read-only through never-auto-executed,
  plus a `default_policy` block

## Fail closed

`default_policy.unlisted_action` decides what happens to a verb that
appears in none of the four tiers, and it defaults to `tier_4_draft_only`.
This matters more than it looks: the tier lists are static, but an MCP
server's tool list is not — upgrade a provider and you can acquire new
verbs without this file changing. Anything unrecognised gets drafted for
a human rather than run.

## Consumed by

[agent-swarm-topology](../agent-swarm-topology), via
`itsm-support.actionPolicy`. The actual verb names here need to match
whatever `action-mappings/` in [itsm-providers](../itsm-providers) maps
them to for your chosen tool.

## Changing this

This is the file to touch when the *policy* changes (e.g. "access grants
always need approval") — not when the *tool* changes. Tool swaps live in
`itsm-providers`, not here.
