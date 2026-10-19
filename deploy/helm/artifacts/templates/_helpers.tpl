{{- define "artifacts.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "artifacts.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "artifacts.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "artifacts.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "artifacts.selectorLabels" -}}
app.kubernetes.io/name: {{ include "artifacts.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "artifacts.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "artifacts.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Name of the Secret with tokens and keys: an existing one, or the one this chart renders. */}}
{{- define "artifacts.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- include "artifacts.fullname" . }}
{{- end }}
{{- end }}

{{- define "artifacts.publicUrl" -}}
{{- if .Values.config.publicUrl }}
{{- .Values.config.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (index .Values.ingress.hosts 0).host }}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) $host }}
{{- else }}
{{- printf "http://%s.%s.svc" (include "artifacts.fullname" .) .Release.Namespace }}
{{- end }}
{{- end }}

{{- define "artifacts.validate" -}}
{{- if and (eq .Values.storage.driver "fs") (gt (int .Values.replicaCount) 1) }}
{{- fail "storage.driver=fs keeps data on one volume and supports a single replica: set replicaCount=1 or use storage.driver=s3" }}
{{- end }}
{{- if and (eq .Values.storage.driver "s3") (not .Values.storage.s3.bucket) }}
{{- fail "storage.s3.bucket is required with storage.driver=s3" }}
{{- end }}
{{- if not (has .Values.auth.mode (list "token" "oidc" "proxy" "none")) }}
{{- fail "auth.mode must be one of token, oidc, proxy, none" }}
{{- end }}
{{- if and (eq .Values.auth.mode "oidc") (or (not .Values.auth.oidc.issuer) (not .Values.auth.oidc.clientId)) }}
{{- fail "auth.oidc.issuer and auth.oidc.clientId are required with auth.mode=oidc" }}
{{- end }}
{{- if and (not .Values.existingSecret) (eq .Values.auth.mode "token") (not .Values.secrets.token) }}
{{- fail "auth.mode=token needs a token: set existingSecret (with key ARTIFACTS_TOKEN) or secrets.token" }}
{{- end }}
{{- end }}
