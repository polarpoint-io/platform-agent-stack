<p align="center">
  <img src="assets/hero.svg" alt="platform-agent-stack — agent topology, risk policy and pluggable backends in one repo" width="100%">
</p>

# platform-agent-stack

Agent topology, risk policy and the pluggable backends — in one repo.

## Layout

The Helm chart lives under `charts/platform-agent-stack/` — `Chart.yaml`
sits there (not at repo root) so the templates can read the config
directories directly with `.Files.Get`, and so the chart is cleanly
separate from the Dockerfile/CI that builds the Ruflo image below.
ArgoCD points at `path: charts/platform-agent-stack`.

```
platform-agent-stack/
├── Dockerfile              builds ghcr.io/polarpoint-io/ruflo — see "Ruflo image" below
├── charts/platform-agent-stack/
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── templates/          ConfigMaps, ExternalSecrets, Deployment
│   ├── swarm/               swarm.config.json — agents and wiring
│   ├── policy/               risk-tiers.yaml — 4 tiers, unlisted fails closed
│   ├── itsm-providers/
│   │   ├── providers/        jira-service-management.mcp.json — the MCP server
│   │   └── action-mappings/  jira-service-management.yaml — verbs to tool names
│   ├── llm-providers/        Foundry now, Modelplane later
│   ├── mcp/base.mcp.json     base MCP servers, merged with the provider at render
│   └── scripts/               config validation, run in CI
├── confluence-toolset/    read-only REST, no MCP required
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

Sync order matters: this chart publishes the merged `.mcp.json` as a
ConfigMap that `ruflo-bridge` mounts, so this Application has to be
healthy before the bridge pod can start.

Credentials come from External Secrets Operator. The chart names the
remote keys; it never holds a value. Set `externalSecrets.secretStoreRef`
to your real `ClusterSecretStore` before the first sync.

To render locally without a cluster:

```sh
helm template pas charts/platform-agent-stack --values charts/platform-agent-stack/values.yaml
./charts/platform-agent-stack/scripts/validate-config.sh
```

The chart refuses to render if `itsmProvider` has no provider file, or a
provider file but no action mapping, or an `image.tag` below the patched
Ruflo floor. Those are deliberate — see the failure message.

## Swapping the ITSM backend

`itsmProvider` selects the backend. Jira Service Management is the worked
example, via Atlassian's hosted MCP server. Adding another is two files
and no code:

```
charts/platform-agent-stack/itsm-providers/providers/<name>.mcp.json        the MCP server definition
charts/platform-agent-stack/itsm-providers/action-mappings/<name>.yaml      generic verbs to its tool names
```

then set `itsmProvider: <name>`. Neither `swarm/` nor `policy/` changes —
that separation is the point of the layout.

Get the tool names from the running server (`tools/list`), never from an
example. A verb mapped to the wrong tool doesn't error; it executes under
the wrong tier. See `charts/platform-agent-stack/itsm-providers/README.md`
for two cases where Jira's tool shapes don't fit the tiers cleanly.

## Ruflo image

No one ever published a Ruflo container image — `ghcr.io/ruvnet/ruflo`,
`ghcr.io/ruvnet/ruflo/cli` and `docker.io/ruflo/cli` were all checked
directly against their registries (authenticated, not just anonymous
pulls) and none exist. The real, verified artifact is the npm package
[`ruflo`](https://www.npmjs.com/package/ruflo). This repo's `Dockerfile`
installs it and `.github/workflows/build-ruflo-image.yml` publishes the
result to `ghcr.io/polarpoint-io/ruflo` on every push to `main`, tagged
with the installed npm version. Both `ruflo-bridge` and this chart's own
Deployment pull from there.

## Ruflo version

`charts/platform-agent-stack/values.yaml` pins `image.tag` (default
`3.34.0`) and the chart refuses to render below `3.16.3`. Versions
before that ship a docker-compose default which exposes the MCP
bridge's `POST /mcp` endpoints unauthenticated — CVE-2026-59726
("RufRoot", CVSS 10.0): unauthenticated RCE in the bridge container,
provider API key theft, and AgentDB memory poisoning. Advisory
GHSA-c4hm-4h84-2cf3.

The patch closes the *default* exposure. It does not authenticate a
bridge endpoint you publish on purpose — the NetworkPolicy check is
still yours to do.

**Known gap:** the real `ruflo` CLI has no concept of this repo's
`swarm.config.json` agent list, `policy/risk-tiers.yaml`, or the
ITSM action-mappings — those are this repo's own schema. Until custom
code exists to translate them into Ruflo's actual primitives
(`agent spawn`, `policy`, `providers`), the Deployment runs a generic
Ruflo orchestrator; it does not yet route ITSM tickets or wrap
HolmesGPT per `swarm.config.json`. See the comment on the Deployment's
`args` in `charts/platform-agent-stack/templates/deployment.yaml`.

## The stack

| Repo | Owns |
|---|---|
| [`platform-agent-stack`](https://github.com/polarpoint-io/platform-agent-stack) | Agent topology, risk policy, pluggable ITSM/LLM/Confluence backends |
| [`ruflo-bridge`](https://github.com/polarpoint-io/ruflo-bridge) | K8s + Helm + KEDA runtime for the Ruflo MCP bridge |
| [`mongostate-crossplane`](https://github.com/polarpoint-io/mongostate-crossplane) | Portable Mongo-compatible state across four platforms |
| [`holmesgpt-runbook-mcp`](https://github.com/polarpoint-io/holmesgpt-runbook-mcp) | Pre-existing — runbook search, RCA and drafting |
