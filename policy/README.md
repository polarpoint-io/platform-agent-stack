# policy

Risk-tiered action gating — what an agent may do unattended versus what
needs a human. Written in generic verbs, deliberately not tied to any one
tool's API.

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

## Kept next to the mappings on purpose

This policy names generic verbs;
[`../itsm-providers/action-mappings/`](../itsm-providers/action-mappings)
binds them to a backend's real tool names. If the two disagree, an action
reaches the backend ungated — and it fails silently, which is the worst
way for a safety control to fail.

While these lived in separate repos that could not be one commit, one
review, or one check. Now `setup.sh` refuses to proceed on a missing
mapping and warns on any mapped verb that appears in no tier.

## Changing this

Touch this file when the *policy* changes ("access grants always need
approval"). Tool swaps live in [`../itsm-providers`](../itsm-providers).
