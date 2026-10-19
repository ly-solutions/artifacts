# Configuration

The server reads environment variables only. Every variable is optional unless marked **required**.
Durations accept `30s`, `15m`, `12h`, `7d` or plain seconds. Lists are comma-separated.

The server refuses to start with a configuration that would be insecure or broken (no token in token
mode, no bucket for S3, an invalid regular expression) and says which variable to fix.

## Server

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_PORT` | `8080` (or `PORT`) | Port to listen on. |
| `ARTIFACTS_HOST` | `0.0.0.0` | Address to bind. |
| `ARTIFACTS_PUBLIC_URL` | `http://localhost:<port>` | External base URL. Used for links in API answers, share links, cookie `Secure` flag (https) and the OIDC redirect. Set it in every real deployment. |
| `ARTIFACTS_SITE_NAME` | `artifacts` | Name shown in page titles. |
| `ARTIFACTS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `ARTIFACTS_LOG_FORMAT` | `json` | `json` (one object per line) or `text`. Share tokens and query strings are never logged. |
| `ARTIFACTS_INDEX_REFRESH` | `10s` | How often the in-memory catalog index checks storage for changes made by other replicas. Writes made by the same replica are visible at once. |
| `ARTIFACTS_MAX_DOCUMENT_BYTES` | `8388608` | Largest accepted version (HTML plus Markdown), in bytes. |

## Storage

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_STORAGE` | `s3` when `ARTIFACTS_S3_BUCKET` is set, else `fs` | `s3` or `fs`. Production installs use `s3`; `fs` is for development and single-replica installs. |
| `ARTIFACTS_DATA_DIR` | `./data` | Root directory of the `fs` driver. One replica only. |
| `ARTIFACTS_S3_BUCKET` | — | **Required for s3.** Bucket name. |
| `ARTIFACTS_S3_PREFIX` | empty | Key prefix inside the bucket, e.g. `artifacts/`, so one bucket can hold several installs. |
| `ARTIFACTS_S3_ENDPOINT` | empty (AWS) | Endpoint of an S3-compatible store, e.g. `http://minio:9000`, `https://<account>.r2.cloudflarestorage.com`. |
| `ARTIFACTS_S3_REGION` | `us-east-1` (or `AWS_REGION`) | Signing region. |
| `ARTIFACTS_S3_FORCE_PATH_STYLE` | `true` when an endpoint is set | Path-style (`endpoint/bucket/key`) instead of virtual-hosted addressing. |
| `ARTIFACTS_S3_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | **Required for s3.** Access key. |
| `ARTIFACTS_S3_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | **Required for s3.** Secret key. |
| `ARTIFACTS_S3_SESSION_TOKEN` | `AWS_SESSION_TOKEN` | Session token for temporary credentials. |
| `ARTIFACTS_S3_CREATE_BUCKET` | `false` | Create the bucket at start if it is missing (handy with MinIO in compose). |
| `ARTIFACTS_S3_CONDITIONAL_WRITES` | `auto` | `auto`/`on`: use `If-Match` / `If-None-Match` on PUT for safe concurrent writes. `off`: check the ETag before writing instead, for a store without conditional PUT; then run one replica. |

The bucket needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on the prefix.
See [storage.md](storage.md) for the layout.

## Authentication

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_AUTH` | `token` | `token`, `oidc`, `proxy` or `none`. See [auth](#authentication-modes). |
| `ARTIFACTS_TOKEN` | — | **Required in token mode.** Editor bearer token(s): publish, edit metadata, share. At least 16 characters; comma-separate several to rotate. Works in every mode, so agents can publish while people use OIDC or a proxy. |
| `ARTIFACTS_READ_TOKEN` | — | Viewer bearer token(s): read and search only. |
| `ARTIFACTS_SECRET` | generated | Key for signing session cookies and share links, at least 32 characters. When unset, a random secret is created once and kept in storage (`system/secret.json`), so every replica shares it. Changing it signs everyone out and invalidates every share link. |
| `ARTIFACTS_SESSION_TTL` | `12h` | Lifetime of a browser session. |
| `ARTIFACTS_COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`. `none` (https only) lets the embed view keep its session when framed by an app on another site; see [the harnessly integration](integrations/harnessly.md#signing-in-inside-the-pane). |
| `ARTIFACTS_EDITORS` | `*` | People (user names or emails) who get the editor role in `oidc` and `proxy` modes. `*` means everyone who signs in; set it empty to rely on groups only. |
| `ARTIFACTS_EDITOR_GROUPS` | empty | Groups whose members get the editor role. |
| `ARTIFACTS_OIDC_ISSUER` | — | **Required in oidc mode.** Issuer URL; discovery is read from `/.well-known/openid-configuration`. |
| `ARTIFACTS_OIDC_CLIENT_ID` | — | **Required in oidc mode.** |
| `ARTIFACTS_OIDC_CLIENT_SECRET` | empty | Client secret (confidential client). Without it the server acts as a public client with PKCE. |
| `ARTIFACTS_OIDC_SCOPES` | `openid profile email` | Requested scopes; add `groups` if your provider needs it. |
| `ARTIFACTS_OIDC_REDIRECT_URL` | `<public URL>/auth/callback` | Redirect URI registered at the provider. |
| `ARTIFACTS_OIDC_ALLOWED_DOMAINS` | empty | Only emails in these domains may sign in (verified emails only). |
| `ARTIFACTS_OIDC_ALLOWED_GROUPS` | empty | Only members of these groups may sign in. |
| `ARTIFACTS_OIDC_GROUPS_CLAIM` | `groups` | Claim that carries group names. |
| `ARTIFACTS_OIDC_ACCEPT_BEARER` | `false` | Also accept provider-issued JWTs (audience = client id) as bearer tokens on the API. |
| `ARTIFACTS_PROXY_USER_HEADER` | `X-Forwarded-User` | Header with the user name, set by the authenticating proxy. |
| `ARTIFACTS_PROXY_EMAIL_HEADER` | `X-Forwarded-Email` | Header with the email. |
| `ARTIFACTS_PROXY_GROUPS_HEADER` | `X-Forwarded-Groups` | Header with groups (comma or space separated). |
| `ARTIFACTS_PROXY_TRUSTED_CIDRS` | `127.0.0.1/32,::1/128` | The headers are trusted only from these addresses (the proxy). Requests from elsewhere are anonymous. |

### Authentication modes

- **token** (default): agents send `Authorization: Bearer <token>`. People open `/login`, paste a token and get
  an HTTP-only session cookie. Simple, no external system.
- **oidc**: people sign in with your identity provider (Keycloak, Authentik, Dex, Zitadel, Okta, Auth0, Google,
  Entra ID, GitLab…). Agents keep using `ARTIFACTS_TOKEN`, or provider JWTs with `ARTIFACTS_OIDC_ACCEPT_BEARER`.
- **proxy**: an authenticating proxy in front (oauth2-proxy, Pomerium, Authelia, Teleport application access,
  a service mesh) sets the user headers. Restrict `ARTIFACTS_PROXY_TRUSTED_CIDRS` to the proxy's addresses.
- **none**: no authentication. Only for a single-user laptop; the server logs a warning at start.

Share links work in every mode: they are signed with `ARTIFACTS_SECRET` and open one artifact read-only.

## Links and integrations

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_TASK_PATTERN` | `^[A-Za-z0-9][A-Za-z0-9_.#/-]{0,63}$` | Regular expression a `task` value must match, e.g. `^[A-Z]+-\d+$` for Jira or YouTrack keys, `^#\d+$` for GitHub issues. |
| `ARTIFACTS_TASK_URL` | empty | Link template for tasks, e.g. `https://tracker.example.com/issue/{task}`. Without it tasks show as plain labels. |
| `ARTIFACTS_SESSION_URL` | empty | Link template for the conversation an artifact came from, e.g. `https://workspace.example.com/sessions/{session}`. |
| `ARTIFACTS_FRAME_ANCESTORS` | empty | Origins allowed to frame the embed view and document content, e.g. `https://workspace.example.com`. Empty = only this server. |
| `ARTIFACTS_CORS_ORIGINS` | empty | Origins allowed to call the API from a browser (bearer tokens only, no cookies). |
| `ARTIFACTS_WEBHOOK_URL` | empty | URL that receives a POST for every publish, metadata change, share, unshare and delete. |
| `ARTIFACTS_WEBHOOK_SECRET` | empty | When set, each webhook carries `X-Artifacts-Signature: sha256=<HMAC of the body>`. |
| `ARTIFACTS_SHARE_TTL` | empty (no expiry) | Default lifetime of a share link when the request does not set one. |

## Content policy

Published HTML is untrusted. It is served with `Content-Security-Policy: sandbox …` without
`allow-same-origin`, so a document's scripts get a unique origin and cannot read cookies or call the API.

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_CONTENT_SCRIPT_SRC` | `https://cdnjs.cloudflare.com,https://cdn.jsdelivr.net` | Script origins documents may load (charts, diagram libraries). Inline scripts are always allowed inside the sandbox. |
| `ARTIFACTS_CONTENT_CONNECT_SRC` | empty (`'none'`) | Origins documents may fetch from. Keep it empty unless a document must call an API without cookie authentication. |

## Client (CLI)

| Variable | Description |
|---|---|
| `ARTIFACTS_URL` | Server address, default `http://localhost:8080`. |
| `ARTIFACTS_TOKEN` | Bearer token. |
| `ARTIFACTS_AUTHOR` | Author recorded on publish; defaults to `git config user.name`, then `$USER`. |
| `ARTIFACTS_SESSION` | Conversation or session id attached to every publish. Agent workspaces set it per conversation. |
| `ARTIFACTS_TASK` | Default `--task` for new artifacts. |

The `migrate` command reads the `ARTIFACTS_S3_*` variables above for the endpoint, region and credentials of an
`s3://` target.
