# artifacts Helm chart

Deploys [artifacts](https://github.com/ly-solutions/artifacts): a catalog of versioned HTML and Markdown
documents that people and coding agents publish, find and share.

## Install

The chart is published from this repository. Point it at a bucket and give it a token:

```bash
kubectl create namespace artifacts
kubectl -n artifacts create secret generic artifacts-secrets \
  --from-literal=ARTIFACTS_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ARTIFACTS_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ARTIFACTS_S3_ACCESS_KEY_ID=... \
  --from-literal=ARTIFACTS_S3_SECRET_ACCESS_KEY=...

helm upgrade --install artifacts ./deploy/helm/artifacts -n artifacts \
  --set storage.s3.bucket=my-artifacts \
  --set storage.s3.endpoint=https://s3.example.com \
  --set existingSecret=artifacts-secrets \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=artifacts.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix
```

Ready-made value sets live in [`ci/`](ci): S3 behind an ingress, the filesystem driver on a volume,
and OIDC with workload identity (IRSA) instead of static S3 keys.

## Notes

- **Storage.** `s3` (default) supports any number of replicas on a store whose conditional PUTs are atomic
  (AWS S3, MinIO); check yours with `artifacts storage-check`. On a store that fails it, set `replicaCount: 1`
  and `strategy.type: Recreate` (see docs/storage.md, "Stores without atomic preconditions").
  `fs` stores data on one PersistentVolumeClaim and the chart refuses `replicaCount > 1` with it.
- **Secrets.** Put tokens and keys in a Secret you manage (`existingSecret`), for example through External
  Secrets, Sealed Secrets or SOPS. The `secrets.*` values render a Secret from plain values, which is fine
  for a trial but stores them in the Helm release.
- **Workload identity.** On EKS or GKE leave the S3 keys out and annotate the service account; the driver
  reads `AWS_*` variables injected by the platform (static or session credentials).
- **Body size.** Documents can be several megabytes; raise your ingress body limit
  (`nginx.ingress.kubernetes.io/proxy-body-size: 16m` for ingress-nginx).
- **Security.** Pods run as a non-root user with a read-only root filesystem, no capabilities, the
  RuntimeDefault seccomp profile and no service account token.
- **Embedding.** To show documents inside another app (an agent workspace), set `embed.frameAncestors` to its origin.

## Values

| Key | Default | Description |
|---|---|---|
| `replicaCount` | `2` | Number of pods. Must be 1 with storage.driver=fs. |
| `strategy` | `{}` | Deployment strategy. Empty uses RollingUpdate (Recreate with storage.driver=fs). Set `type: Recreate` on a store that fails `artifacts storage-check`. |
| `image.repository` | `"ghcr.io/ly-solutions/artifacts"` | Image repository. |
| `image.tag` | `""` | Image tag; defaults to the chart's appVersion. |
| `image.pullPolicy` | `"IfNotPresent"` | Image pull policy. |
| `imagePullSecrets` | `[]` | Secrets for pulling the image from a private registry. |
| `nameOverride` | `""` | Override the chart name. |
| `fullnameOverride` | `""` | Override the full resource name. |
| `serviceAccount.create` | `true` | Create a service account. |
| `serviceAccount.annotations` | `{}` | Annotations, e.g. eks.amazonaws.com/role-arn for IRSA or iam.gke.io/gcp-service-account. |
| `serviceAccount.name` | `""` | Name of the service account; generated when empty. |
| `config.publicUrl` | `""` | External URL of the server (links, share URLs, cookies, OIDC redirect). Defaults to the first ingress host. |
| `config.siteName` | `"artifacts"` | Name shown in page titles. |
| `config.logLevel` | `"info"` | Log level: debug, info, warn, error. |
| `config.logFormat` | `"json"` | Log format: json or text. |
| `config.indexRefresh` | `"10s"` | How often replicas look for each other's writes. |
| `config.indexConcurrency` | `16` | How many documents the index reads at once when it starts or catches up. |
| `config.cacheMb` | `128` | In-memory read cache for the s3 driver, in MiB (0 turns it off). Keep it below the memory limit. |
| `config.maxDocumentBytes` | `8388608` | Largest accepted version, in bytes. |
| `storage.driver` | `"s3"` | Storage driver: s3 or fs. |
| `storage.s3.bucket` | `""` | Bucket name (required for s3). |
| `storage.s3.prefix` | `""` | Key prefix inside the bucket. |
| `storage.s3.endpoint` | `""` | Endpoint of an S3-compatible store; empty for AWS. |
| `storage.s3.region` | `"us-east-1"` | Signing region. |
| `storage.s3.forcePathStyle` | `""` | Path-style addressing; empty = automatic (on when an endpoint is set). |
| `storage.s3.createBucket` | `false` | Create the bucket at start if missing. |
| `storage.s3.conditionalWrites` | `"auto"` | Conditional PUT (If-Match / If-None-Match): auto, on or off. Use off only for stores without it, with one replica. |
| `storage.fs.persistence.enabled` | `true` | Keep fs data on a PersistentVolumeClaim (otherwise an emptyDir, lost with the pod). |
| `storage.fs.persistence.existingClaim` | `""` | Use an existing claim instead of creating one. |
| `storage.fs.persistence.storageClass` | `""` | Storage class of the created claim. |
| `storage.fs.persistence.size` | `"5Gi"` | Size of the created claim. |
| `storage.fs.persistence.accessModes` | `["ReadWriteOnce"]` | Access modes of the created claim. |
| `auth.mode` | `"token"` | token, oidc, proxy or none. |
| `auth.editors` | `"*"` | People who get the editor role in oidc/proxy modes ("*" = everyone who signs in). |
| `auth.editorGroups` | `""` | Groups whose members get the editor role. |
| `auth.sessionTtl` | `"12h"` | Browser session lifetime. |
| `auth.oidc.issuer` | `""` | Issuer URL. |
| `auth.oidc.clientId` | `""` | Client id. |
| `auth.oidc.scopes` | `"openid profile email"` | Scopes. |
| `auth.oidc.redirectUrl` | `""` | Redirect URL; defaults to <publicUrl>/auth/callback. |
| `auth.oidc.allowedDomains` | `""` | Only emails in these domains (comma-separated). |
| `auth.oidc.allowedGroups` | `""` | Only members of these groups (comma-separated). |
| `auth.oidc.groupsClaim` | `"groups"` | Claim with group names. |
| `auth.oidc.acceptBearer` | `false` | Accept provider-issued JWTs as API bearer tokens. |
| `auth.proxy.userHeader` | `"X-Forwarded-User"` | Header with the user name. |
| `auth.proxy.emailHeader` | `"X-Forwarded-Email"` | Header with the email. |
| `auth.proxy.groupsHeader` | `"X-Forwarded-Groups"` | Header with groups. |
| `auth.proxy.trustedCidrs` | `"127.0.0.1/32,::1/128"` | Addresses the headers are trusted from (your proxy or ingress pods). |
| `links.taskPattern` | `""` | Regular expression for task values. |
| `links.taskUrl` | `""` | Task link template, e.g. https://tracker.example.com/issue/{task}. |
| `links.sessionUrl` | `""` | Conversation link template, e.g. https://workspace.example.com/sessions/{session}. |
| `embed.frameAncestors` | `""` | Origins allowed to frame the embed view (comma-separated), e.g. your agent workspace. |
| `embed.corsOrigins` | `""` | Origins allowed to call the API from a browser (comma-separated). |
| `content.scriptSrc` | `"https://cdnjs.cloudflare.com,https://cdn.jsdelivr.net"` | Script origins published documents may load. |
| `content.connectSrc` | `""` | Origins published documents may fetch from (empty = none). |
| `reader.url` | `""` | External reader template, e.g. `https://reader.example.com/docs/{slug}?v={version}` (empty = this server). |
| `reader.redirect` | `anonymous` | Who is redirected to it: `anonymous` or `browsers`. |
| `versions.idFormat` | `timestamp` | Format of new version ids: `timestamp` or `sha` (40 hex characters). |
| `content.frameSrc` | `""` | Origins published documents may frame, e.g. a whiteboard service (empty = none). |
| `share.ttl` | `""` | Default share link lifetime when a request sets none (empty = no expiry). |
| `webhook.url` | `""` | URL notified on publish, metadata change, share, unshare and delete. |
| `existingSecret` | `""` | Name of an existing Secret with any of: ARTIFACTS_TOKEN, ARTIFACTS_READ_TOKEN, ARTIFACTS_SECRET, ARTIFACTS_S3_ACCESS_KEY_ID, ARTIFACTS_S3_SECRET_ACCESS_KEY, ARTIFACTS_OIDC_CLIENT_SECRET, ARTIFACTS_WEBHOOK_SECRET. When set, the values under `secrets` are ignored. |
| `secrets.token` | `""` | Editor token(s). |
| `secrets.readToken` | `""` | Viewer token(s). |
| `secrets.shareToken` | `""` | Sharer token(s): only turn sharing on and off. |
| `secrets.signingSecret` | `""` | Signing key for sessions and share links (generated and kept in storage when empty). |
| `secrets.s3AccessKeyId` | `""` | S3 access key id (leave empty with IRSA / workload identity). |
| `secrets.s3SecretAccessKey` | `""` | S3 secret access key. |
| `secrets.oidcClientSecret` | `""` | OIDC client secret. |
| `secrets.webhookSecret` | `""` | Webhook HMAC secret. |
| `plugins.modules` | `""` | Plugin modules (`ARTIFACTS_PLUGINS`), e.g. `/plugins/acme/index.mjs`. |
| `extraVolumes` | `[]` | Extra volumes, e.g. a ConfigMap holding a plugin. |
| `extraVolumeMounts` | `[]` | Extra volume mounts for the server container. |
| `extraEnv` | `[]` | Extra environment variables, e.g. AWS_REGION or proxy settings. |
| `extraEnvFrom` | `[]` | Extra env sources (ConfigMaps / Secrets). |
| `service.type` | `"ClusterIP"` | Service type. |
| `service.port` | `80` | Service port. |
| `service.annotations` | `{}` | Service annotations. |
| `ingress.enabled` | `false` | Expose through an Ingress. |
| `ingress.className` | `""` | Ingress class. |
| `ingress.annotations` | `{}` | Ingress annotations (body size: documents can be several MB). |
| `ingress.hosts` | `see values.yaml` | Hosts and paths. |
| `ingress.tls` | `[]` | TLS settings. |
| `resources` | `see values.yaml` | Resource requests and limits. |
| `podSecurityContext` | `see values.yaml` | Pod security context. |
| `securityContext` | `see values.yaml` | Container security context. |
| `podDisruptionBudget.enabled` | `true` | Create a PodDisruptionBudget (only when replicaCount > 1). |
| `podDisruptionBudget.minAvailable` | `1` | Minimum available pods. |
| `podAnnotations` | `{}` | Pod annotations. |
| `podLabels` | `{}` | Pod labels. |
| `nodeSelector` | `{}` | Node selector. |
| `tolerations` | `[]` | Tolerations. |
| `affinity` | `{}` | Affinity. |
| `topologySpreadConstraints` | `[]` | Topology spread constraints. |
| `livenessProbe` | `GET /healthz` | Liveness probe. |
| `readinessProbe` | `GET /readyz` | Readiness probe; fails while storage is unreachable. |
| `startupProbe` | `GET /healthz`, up to 2 min | Startup probe. |

Every server option is documented in [docs/configuration.md](../../../docs/configuration.md); options without a
chart value can be passed through `extraEnv`.
