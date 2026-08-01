<p align="center">
  <img src="assets/hero.svg" alt="platform-agent-stack — agent topology, risk policy and pluggable backends in one repo" width="100%">
</p>

# platform-agent-stack

Agent topology, risk policy and the pluggable backends — in one repo.

## Layout

This repo is itself a Helm chart — `Chart.yaml` sits at the root so the
templates can read the config directories directly with `.Files.Get`.
ArgoCD points at `path: .`.

```
platform-agent-stack/
├── Chart.yaml             the repo IS the chart
├── values.yaml
├── templates/             ConfigMaps, ExternalSecrets, Deployment
├── swarm/                 swarm.config.json — agents and wiring
├── policy/                risk-tiers.yaml — 4 tiers, unlisted fails closed
├── itsm-providers/
│   ├── providers/         jira-service-management.mcp.json — the MCP server
│   └── action-mappings/   jira-service-management.yaml — verbs to tool names
├── llm-providers/         Foundry now, Modelplane later
├── confluence-toolset/    read-only REST, no MCP required
├── mcp/base.mcp.json      base MCP servers, merged with the provider at render
├── argocd/                app definition for argocd-tooling-applications
├── scripts/               config validation, run in CI
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

Sync order matters: this chart publishes the merged `.mcp.json` as a
ConfigMap that `ruflo-bridge` mounts, so this Application has to be
healthy before the bridge pod can start.

Credentials come from External Secrets Operator. The chart names the
remote keys; it never holds a value. Set `externalSecrets.secretStoreRef`
to your real `ClusterSecretStore` before the first sync.

To render locally without a cluster:

```sh
helm template pas . --values values.yaml
./scripts/validate-config.sh
```

The chart refuses to render if `itsmProvider` has no provider file, or a
provider file but no action mapping, or an `image.tag` below the patched
Ruflo floor. Those are deliberate — see the failure message.

## Swapping the ITSM backend

`itsmProvider` selects the backend. Jira Service Management is the worked
example, via Atlassian's hosted MCP server. Adding another is two files
and no code:

```
itsm-providers/providers/<name>.mcp.json        the MCP server definition
itsm-providers/action-mappings/<name>.yaml      generic verbs to its tool names
```

then set `itsmProvider: <name>`. Neither `swarm/` nor `policy/` changes —
that separation is the point of the layout.

Get the tool names from the running server (`tools/list`), never from an
example. A verb mapped to the wrong tool doesn't error; it executes under
the wrong tier. See `itsm-providers/README.md` for two cases where Jira's
tool shapes don't fit the tiers cleanly.

## Ruflo version

`values.yaml` pins `image.tag` (default `3.30.2`) and the chart refuses
to render below `3.16.3`. Versions before that ship a docker-compose default which
exposes the MCP bridge's `POST /mcp` endpoints unauthenticated —
CVE-2026-59726 ("RufRoot", CVSS 10.0): unauthenticated RCE in the bridge
container, provider API key theft, and AgentDB memory poisoning.
Advisory GHSA-c4hm-4h84-2cf3.

The patch closes the *default* exposure. It does not authenticate a
bridge endpoint you publish on purpose — the NetworkPolicy check is
still yours to do.

## The stack

| Repo | Owns |
|---|---|
| [`platform-agent-stack`](https://github.com/polarpoint-io/platform-agent-stack) | Agent topology, risk policy, pluggable ITSM/LLM/Confluence backends |
| [`ruflo-bridge`](https://github.com/polarpoint-io/ruflo-bridge) | K8s + Helm + KEDA runtime for the Ruflo MCP bridge |
| [`mongostate-crossplane`](https://github.com/polarpoint-io/mongostate-crossplane) | Portable Mongo-compatible state across four platforms |
| [`holmesgpt-runbook-mcp`](https://github.com/polarpoint-io/holmesgpt-runbook-mcp) | Pre-existing — runbook search, RCA and drafting |
