<p align="center">
  <img src="assets/hero.svg" alt="platform-agent-stack — agent topology, risk policy and pluggable backends in one repo" width="100%">
</p>

# platform-agent-stack

Agent topology, risk policy and the pluggable backends — in one repo,
fronted by a custom MCP bridge that enforces the policy.

## Layout

The Helm chart lives under `charts/platform-agent-stack/` — `Chart.yaml`
sits there (not at repo root) so the templates can read the config
directories directly with `.Files.Get`, and so the chart is cleanly
separate from `bridge/`, the service it deploys. ArgoCD points at
`path: charts/platform-agent-stack`.

```
platform-agent-stack/
├── bridge/                  the MCP bridge itself — see bridge/README.md
│   ├── src/                 Express + @modelcontextprotocol/sdk
│   └── Dockerfile           builds ghcr.io/polarpoint-io/platform-agent-bridge
├── charts/platform-agent-stack/
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── templates/          ConfigMaps, ExternalSecrets, Deployment, Service, NetworkPolicy
│   ├── swarm/               swarm.config.json — agents and wiring
│   ├── policy/               risk-tiers.yaml — 4 tiers, unlisted fails closed
│   ├── itsm-providers/
│   │   ├── providers/        jira-service-management.mcp.json — the MCP server
│   │   └── action-mappings/  jira-service-management.yaml — verbs to tool names
│   ├── llm-providers/        anthropic.yaml — the LLM backend the bridge calls
│   ├── mcp/base.mcp.json     base MCP servers, merged with the provider at render
│   └── scripts/               config validation, run in CI
├── confluence-toolset/    read-only REST, no MCP required (not yet implemented)
├── argocd/                app definition for argocd-tooling-applications
├── docs/diagrams/         C4 model — .puml source
└── images/external/       rendered PNGs, committed by CI
```

## Architecture

C4 model, using PlantUML's bundled C4 standard library (`!include
<C4/C4_Context>`) so there's nothing to vendor or fetch.

Source is `docs/diagrams/*.puml`; rendered PNGs land in
`images/external/`. GitHub can't render PlantUML in markdown, so the
images are committed — but you don't render them yourself. Push a
`.puml` change and the `diagrams` workflow renders and commits the PNG,
the same `plantuml/plantuml` container `markdown-pol-docs` uses.
`docs/diagrams/render.sh` runs the identical thing locally if you want a
preview first; it needs only docker.

### Level 1 — system context

![System context](images/external/c4-context.png)

### Level 2 — containers

Boundaries are git repos. Everything inside `platform-agent-stack` is a
directory within it.

![Container view](images/external/c4-container.png)

## Deploying

ArgoCD owns this. Register the Application by copying
`argocd/non-prod.yaml` into
`argocd-tooling-applications/releases/apps/platform/platform-agent-stack/`
— the children template there globs `**/<env>.yaml` and generates the
Application from it.

Credentials come from External Secrets Operator. The chart names the
remote keys; it never holds a value. Set `externalSecrets.secretStoreRef`
to your real `ClusterSecretStore` before the first sync.

To render locally without a cluster:

```sh
helm template pas charts/platform-agent-stack --values charts/platform-agent-stack/values.yaml
./charts/platform-agent-stack/scripts/validate-config.sh
```

The chart refuses to render if `itsmProvider` has no provider file, a
provider file but no action mapping, `image.tag` isn't a plain semver,
or `networkPolicy.enabled=false`/`service.type` isn't `ClusterIP`.

## Swapping the ITSM backend

`itsmProvider` selects the backend. Jira Service Management and
Freshservice are both implemented. Adding another is two files and no
code:

```
charts/platform-agent-stack/itsm-providers/providers/<name>.mcp.json        the MCP server definition
charts/platform-agent-stack/itsm-providers/action-mappings/<name>.yaml      generic verbs to its tool names
```

then set `itsmProvider: <name>`. Neither `swarm/` nor `policy/` changes,
and `bridge/` reads the mapping at startup rather than having it baked in.

Get the tool names from the running server (`tools/list`), never from an
example. A verb mapped to the wrong tool doesn't error; it executes under
the wrong tier — `bridge/src/policy.js` enforces the tier, but it can
only enforce what the mapping says. See
`charts/platform-agent-stack/itsm-providers/README.md` for two cases
(Jira and Freshservice) where a provider's tool shapes don't fit the
tiers cleanly.

## The bridge

`bridge/` connects to the ITSM MCP server and `holmesgpt-runbook-mcp`,
resolves every requested action through `policy/risk-tiers.yaml` +
`itsm-providers/action-mappings/`, and routes inbound requests between
HolmesGPT (infra) and the ITSM backend (tickets). See `bridge/README.md`
for endpoints and known gaps.

## The stack

| Repo | Owns |
|---|---|
| [`platform-agent-stack`](https://github.com/polarpoint-io/platform-agent-stack) | Agent topology, risk policy, pluggable ITSM/LLM/Confluence backends, and the bridge that enforces all of it |
| [`mongostate-crossplane`](https://github.com/polarpoint-io/mongostate-crossplane) | Portable Mongo-compatible state across four platforms — not currently wired into the bridge (pending approvals are in-memory; see bridge/README.md) |
| [`holmesgpt-runbook-mcp`](https://github.com/polarpoint-io/holmesgpt-runbook-mcp) | Pre-existing — runbook search, RCA and drafting |
