{{- define "platform-agent-stack.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform-agent-stack.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "platform-agent-stack.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform-agent-stack.labels" -}}
app.kubernetes.io/name: {{ include "platform-agent-stack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: platform-agent-stack
{{- end -}}

{{- define "platform-agent-stack.selectorLabels" -}}
app.kubernetes.io/name: {{ include "platform-agent-stack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Refuses a non-semver image tag like "latest".
*/}}
{{- define "platform-agent-stack.assertVersion" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if not (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+" $tag) -}}
{{- fail (printf "image.tag %q is not a plain semver. Pin an explicit version, not \"latest\" - see .github/workflows/build-bridge-image.yml for how tags are cut." $tag) -}}
{{- end -}}
{{- end -}}

{{/*
The provider and its action mapping must both exist. A missing mapping
means the policy's generic verbs cannot resolve to real tool names, and
the action would reach the backend ungated — silently. Fail at render.
*/}}
{{- define "platform-agent-stack.assertProvider" -}}
{{- $p := .Values.itsmProvider -}}
{{- $prov := printf "itsm-providers/providers/%s.mcp.json" $p -}}
{{- $map  := printf "itsm-providers/action-mappings/%s.yaml" $p -}}
{{- if not (.Files.Get $prov) -}}
{{- fail (printf "itsmProvider=%q but %s is missing from the chart." $p $prov) -}}
{{- end -}}
{{- if not (.Files.Get $map) -}}
{{- fail (printf "itsmProvider=%q has a provider file but no action mapping at %s. policy/risk-tiers.yaml gates generic verbs; without the mapping they cannot resolve to tool names and would reach the backend ungated." $p $map) -}}
{{- end -}}
{{- end -}}

{{/*
Same idea as assertProvider, for the LLM backend file. A missing file
here is a straight render failure, not a silent gate bypass — but it
should still fail loudly at render rather than 404 deep in a pod's logs.
*/}}
{{- define "platform-agent-stack.assertLlmProvider" -}}
{{- $p := .Values.llmProvider -}}
{{- $f := printf "llm-providers/%s.yaml" $p -}}
{{- if not (.Files.Get $f) -}}
{{- fail (printf "llmProvider=%q but %s is missing from the chart. Rename llm-providers/modelplane.yaml.example to modelplane.yaml, or add a file for your backend." $p $f) -}}
{{- end -}}
{{- end -}}
