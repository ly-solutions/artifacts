# Ways to run it

| Option | Storage | Good for |
|---|---|---|
| [`npx` / Node.js](#nodejs) | fs or S3 | a laptop, trying it, a single VM with systemd |
| [Docker](#docker) | fs volume or S3 | one container anywhere |
| [Docker Compose](#docker-compose) | MinIO | a self-contained stack on one host |
| [Helm](#kubernetes-helm) | S3 (or fs on a PVC) | Kubernetes, several replicas |
| [Argo CD](#argo-cd) | S3 | GitOps |

Whatever you choose, set `ARTIFACTS_PUBLIC_URL` to the address people use, and keep `ARTIFACTS_TOKEN`
(and `ARTIFACTS_SECRET` if you set it) in your secret store.

## Node.js

Node.js 22 or newer.

```bash
# a throwaway local catalog: files in ./data, no authentication
ARTIFACTS_AUTH=none npx @ly-solutions/artifacts serve

# from a clone
npm ci
ARTIFACTS_TOKEN=$(openssl rand -hex 32) ARTIFACTS_DATA_DIR=./data npm start
```

Against S3:

```bash
export ARTIFACTS_S3_BUCKET=my-artifacts ARTIFACTS_S3_REGION=eu-central-1
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
export ARTIFACTS_TOKEN=$(openssl rand -hex 32) ARTIFACTS_PUBLIC_URL=https://artifacts.example.com
npx @ly-solutions/artifacts serve
```

A systemd unit for a VM, after `npm install -g @ly-solutions/artifacts@0.1.0`:

```ini
[Unit]
Description=artifacts
After=network-online.target

[Service]
User=artifacts
EnvironmentFile=/etc/artifacts.env
ExecStart=/usr/local/bin/artifacts serve
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/artifacts

[Install]
WantedBy=multi-user.target
```

## Docker

The image is `ghcr.io/ly-solutions/artifacts` (multi-stage build, runs as the unprivileged `node` user,
with a `HEALTHCHECK` on `/healthz`).

```bash
# filesystem driver on a named volume
docker run -d --name artifacts -p 8080:8080 \
  -e ARTIFACTS_TOKEN="$(openssl rand -hex 32)" \
  -v artifacts-data:/data \
  ghcr.io/ly-solutions/artifacts:0.1.0

# S3
docker run -d --name artifacts -p 8080:8080 \
  -e ARTIFACTS_S3_BUCKET=my-artifacts -e ARTIFACTS_S3_ENDPOINT=https://s3.example.com \
  -e ARTIFACTS_S3_ACCESS_KEY_ID=… -e ARTIFACTS_S3_SECRET_ACCESS_KEY=… \
  -e ARTIFACTS_TOKEN=… -e ARTIFACTS_PUBLIC_URL=https://artifacts.example.com \
  ghcr.io/ly-solutions/artifacts:0.1.0
```

The same image runs the importer: `docker run --rm -e ARTIFACTS_S3_… ghcr.io/ly-solutions/artifacts migrate --from-git … --to s3://…`.

## Docker Compose

[`compose.yaml`](../compose.yaml) runs the server with MinIO; the bucket is created on start.

```bash
docker compose up --build
# open http://localhost:8080/login and paste: local-demo-token-change-me
```

Override `ARTIFACTS_TOKEN`, `ARTIFACTS_HOST_PORT` (default 8080) or `MINIO_CONSOLE_PORT` (default 9001) in the
environment or an `.env` file. Fill it with examples:
`ARTIFACTS_URL=http://localhost:8080 ARTIFACTS_TOKEN=local-demo-token-change-me node scripts/demo-seed.mjs`.

## Kubernetes (Helm)

The chart is in [`deploy/helm/artifacts`](../deploy/helm/artifacts); its README has every value.

```bash
helm upgrade --install artifacts ./deploy/helm/artifacts -n artifacts --create-namespace \
  --set storage.s3.bucket=my-artifacts \
  --set existingSecret=artifacts-secrets \
  --set ingress.enabled=true --set ingress.hosts[0].host=artifacts.example.com \
  --set ingress.hosts[0].paths[0].path=/ --set ingress.hosts[0].paths[0].pathType=Prefix
```

It ships probes on `/healthz` and `/readyz`, resource requests, a PodDisruptionBudget, a restricted security
context (non-root, read-only root filesystem, no capabilities, RuntimeDefault seccomp), optional OIDC and proxy
auth, and refuses the `fs` driver with more than one replica.

## Argo CD

[`deploy/argocd/application.yaml`](../deploy/argocd/application.yaml) deploys the chart from this repository at a
tag, with values inline. Keep the Secret with tokens next to it through External Secrets or Sealed Secrets.

## Behind a proxy or a CDN

- Raise the request body limit to at least 16 MB on the path `/api/v1/artifacts` and `/a`.
- Pass `X-Forwarded-*` headers only if you use `ARTIFACTS_AUTH=proxy`; the server builds links from
  `ARTIFACTS_PUBLIC_URL`, never from request headers.
- Do not cache `/a/`, `/s/` or `/api/`: answers are `Cache-Control: no-store`. `/static/` is cacheable.
