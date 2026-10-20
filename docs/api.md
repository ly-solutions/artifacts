# HTTP API

All API routes live under `/api/v1`, take and return JSON, and authenticate with
`Authorization: Bearer <token>` (or the browser session cookie on the server's own pages).

| Role | Can |
|---|---|
| `viewer` | search, read metadata, versions and content |
| `editor` | everything a viewer can, plus publish, edit metadata, share, unshare, delete |

Errors share one shape, written so an agent can fix the request instead of retrying it:

```json
{ "error": "invalid", "problems": ["slug: lowercase latin letters, digits and dashes, 2 to 80 characters"] }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid`, `bad_json` | The body is wrong; `problems` lists every reason. |
| 401 | `unauthorized` | No token or a wrong one. |
| 403 | `forbidden`, `cross_site` | Read-only token, or a cookie-authenticated write from another site. |
| 404 | `not_found`, `version_not_found` | No such artifact or version. |
| 409 | `duplicate` | Publishing without a slug, and an artifact with the same title exists. `candidates` lists them. |
| 409 | `version_conflict` | `baseVersion` is older than the current version. |
| 409 | `version_exists` | `versionId` names a version the artifact already has. |
| 413 | `invalid` | The document is larger than `ARTIFACTS_MAX_DOCUMENT_BYTES`. |
| 415 | `unsupported_media_type` | Send `Content-Type: application/json`. |
| 503 | `unavailable`, `busy` | Storage did not answer, or too many concurrent writes to one artifact. Retry. |

## The artifact object

```json
{
  "slug": "checkout-latency-incident-14-march-vtto3m",
  "title": "Checkout latency incident, 14 March",
  "description": "A leaked connection pool slowed EU checkout for 38 minutes",
  "author": "Ada",
  "tags": ["incident", "payments", "postmortem"],
  "task": "PROJ-342",
  "taskUrl": "https://tracker.example.com/issue/PROJ-342",
  "link": "https://git.example.com/shop/payments/-/merge_requests/918",
  "session": "conv-31c7",
  "sessionUrl": "https://workspace.example.com/sessions/conv-31c7",
  "public": false,
  "createdAt": "2026-10-19T20:12:31Z",
  "updatedAt": "2026-10-19T20:12:32Z",
  "versionCount": 3,
  "currentVersion": { "n": 3, "id": "20261019T201232Z-9c41ab", "createdAt": "2026-10-19T20:12:32Z", "author": "Ada", "note": "timeline checked against the deploy log", "formats": ["html"], "bytes": 2817 },
  "viewUrl": "https://artifacts.example.com/a/checkout-latency-incident-14-march-vtto3m",
  "embedUrl": "https://artifacts.example.com/embed/checkout-latency-incident-14-march-vtto3m"
}
```

`taskUrl` and `sessionUrl` are filled from `ARTIFACTS_TASK_URL` and `ARTIFACTS_SESSION_URL`; `public` is true
while share links work. Single-artifact answers also carry `versions`, newest first.

## Routes

### `GET /api/v1/artifacts` — list and search

Query: `q` (words; all must match title, slug, tags, description, task, author or text), `tag` (repeatable;
all must be present), `task`, `session`, `author`, `limit` (default 50, larger values are lowered to 500),
`offset` (default 0).

```json
{ "total": 120, "offset": 0, "limit": 50, "nextOffset": 50,
  "items": [ { "...artifact": "...", "score": 21, "snippet": "…join one incident review as an observer…" } ] }
```

The answer is one page. `nextOffset` is where the next page starts, or `null` on the last page; the same address
is in a `Link: <…>; rel="next"` header. A client that needs everything loops until `nextOffset` is `null` rather
than assuming one request returns the whole catalog. The catalog page (`/`) shows 200 artifacts per page with
"Newer" and "Older" links (`?offset=`), and `artifacts find --all` follows the pages.

Results are ranked when `q` is set (title hits weigh most, then tags, then metadata, then text) and otherwise
ordered by last update.

### `POST /api/v1/artifacts` — publish

```json
{
  "title": "Checkout latency incident, 14 March",
  "html": "<h1>…</h1>…",
  "markdown": "# …",
  "slug": "checkout-latency-incident-14-march-vtto3m",
  "note": "added the timeline",
  "description": "…", "tags": ["incident"], "task": "PROJ-342", "link": "https://…", "session": "conv-31c7",
  "author": "Ada",
  "baseVersion": 2,
  "new": false,
  "versionId": null
}
```

- `html` or `markdown` (or both) is required. A fragment without `<html>` and a Markdown-only version are shown
  in the built-in typography; a full document is shown as published.
- `title` may be omitted when the document has a `<title>`, `<h1>` or `# Heading`.
- With `slug`: a new version of that artifact (created if the slug is free). Without it: a new artifact, unless one
  with the same normalised title (or the same task and a close title) exists — then `409 duplicate`. `new: true`
  skips that check.
- Fields that are not sent keep their previous values; `null` clears `description`, `task`, `link`, `session`.
- `baseVersion` makes the write conditional: `409 version_conflict` if someone published in between.
- `public` is refused here: publishing never changes who can read.
- `versionId` keeps an id from another system, e.g. a git sha when an importer replays history through the API
  (6 to 64 letters, digits and dashes, not only digits). An id the artifact already has is refused with
  `409 version_exists`; replaying the same content under an id whose manifest write was interrupted succeeds.
  Leave it out and the server assigns an id in the `ARTIFACTS_VERSION_ID` format.

Answer `201` (created) or `200` (new version):

```json
{ "created": false, "version": { "n": 3, "id": "20261019T201232Z-9c41ab", "...": "..." }, "artifact": { "...": "..." } }
```

### `GET /api/v1/artifacts/{slug}`

`{ "artifact": { …, "versions": [ …newest first… ] } }`

### `PATCH /api/v1/artifacts/{slug}` — metadata

Any of `title`, `description`, `tags`, `addTags`, `removeTags`, `task`, `link`, `session`, `public`. No new version
is created. `public: false` turns sharing off and revokes every share link issued so far; `public: true` turns it
on and the answer carries a `shareUrl`.

### `DELETE /api/v1/artifacts/{slug}`

Deletes the artifact and every version. `{ "deleted": "<slug>" }`.

### `GET /api/v1/artifacts/{slug}/versions`

`{ "slug": "…", "versions": [ { "n": 3, "id": "…", "createdAt": "…", "author": "…", "note": "…", "formats": ["html"], "bytes": 2817, "current": true }, … ] }`

Versions imported from git carry `"source": "git"` and keep the commit sha as `id`.

**Version ids are opaque.** New ids follow `ARTIFACTS_VERSION_ID` (`timestamp` by default, or `sha` for 40-hex
ids); an artifact can mix formats (imported shas, then new ids). Clients store and pass ids back as given, and
use `n` for ordering. Every `?v=`/`from`/`to` parameter takes a version number, a full id, or an unambiguous id
prefix of at least 7 characters.

### `GET /api/v1/artifacts/{slug}/content`

Query: `v` (version number, version id or an unambiguous id prefix of 7+ characters; default latest),
`format` = `html` (the published source, as `text/plain`), `markdown` (`text/markdown`) or `json`
(`{ slug, version, html, markdown }`). The `X-Artifact-Version` header carries the version number.

### `GET /api/v1/artifacts/{slug}/diff` — what changed between versions

Query: `from`, `to` (version number, id or id prefix; `to` defaults to the latest version, `from` to the one
before `to`), `source`, `format` = `json` (default) or `unified`, `context` (unchanged lines around each change in
the unified format, default 3).

`source` picks what is compared: `markdown` (the Markdown sources; `404 no_markdown` if a version has none),
`text` (the visible text of each page, HTML tags stripped, one block per line; a Markdown-only version as
written), or `auto` (default: Markdown when both versions have it, text otherwise). Styling and script changes
do not show up in `text`.

```json
{
  "slug": "api-rate-limits-proposal-4k2m9x",
  "from": { "n": 2, "id": "20261019T201231Z-1f0e2d" },
  "to": { "n": 3, "id": "20261019T201232Z-9c41ab" },
  "source": "markdown",
  "approximate": false,
  "stats": { "added": 1, "removed": 1, "same": 41 },
  "blocks": [ { "kind": "same", "text": "# API rate limits" }, { "kind": "removed", "text": "Burst: 20" }, { "kind": "added", "text": "Burst: 40" } ]
}
```

`blocks` lists every line of both versions in order (`same`, `removed`, `added`), so a client can show the whole
document with changes marked or keep only the changes. The diff is a minimal line diff (Myers). When more than
2000 lines differ it is `approximate`: the changed region comes back as one removed and one added run.
`format=unified` returns a `diff -u` style patch as `text/plain` (empty when nothing changed) with the
`X-Diff-Source` header, and `X-Diff-Approximate: true` when approximate.

### `POST /api/v1/artifacts/{slug}/share`

Body (optional): `{ "expiresIn": "7d", "rotate": false }`. Turns sharing on and returns a signed link:

```json
{ "url": "https://artifacts.example.com/s/eyJzIjoi….bAwLeu0N…", "expiresAt": "2026-10-26T20:12:32.000Z", "artifact": { "...": "..." } }
```

Every call issues a new link; earlier links keep working until they expire or sharing is turned off.
`rotate: true` revokes earlier links first.

### `DELETE /api/v1/artifacts/{slug}/share`

Turns sharing off; every link issued before stops working, including ones not yet expired.

### `GET /api/v1/tags`

`{ "tags": [ { "tag": "incident", "count": 4 }, … ] }`

### `GET /api/v1/whoami`

`{ "name": "token", "role": "editor", "via": "bearer", "auth": "token" }`

## Pages and content

| Path | What |
|---|---|
| `/` | Catalog with search and tag filters. `?q=`, `?tag=`, `?offset=` (200 per page). |
| `/a/{slug}` | Reader: metadata, version picker, share and edit dialogs, download. `?v=` picks a version. |
| `/embed/{slug}` | Reader without the catalog chrome, for framing in another app (`ARTIFACTS_FRAME_ANCESTORS`). Posts `{type: "artifacts:ready", slug, version}` to the parent. |
| `/a/{slug}/raw` | The rendered document alone, sandboxed. `?v=`, `?theme=light\|dark`, `?download=html\|markdown`. |
| `/s/{token}` | Shared, read-only reader; `/s/{token}/raw` the document. Refusals are indistinguishable 404s. |
| `/login`, `/logout`, `/auth/callback` | Sign-in for `token` and `oidc` modes. |
| `/healthz`, `/readyz` | Liveness, and readiness including a storage check. |

Documents served by `/raw` carry `Content-Security-Policy: sandbox allow-scripts allow-popups …` without
`allow-same-origin`: their scripts run in an opaque origin, cannot read cookies or call the API, and cannot
fetch anywhere unless `ARTIFACTS_CONTENT_CONNECT_SRC` allows it, nor frame anything unless
`ARTIFACTS_CONTENT_FRAME_SRC` allows it. A framed reader page can switch the theme of a
wrapped document with `postMessage({type: "artifacts:theme", theme: "light" | "dark" | "auto"}, "*")`.

## Webhooks

With `ARTIFACTS_WEBHOOK_URL` set, every change POSTs:

```json
{ "event": "artifact.updated", "at": "2026-10-19T20:12:32Z", "artifact": { "...artifact object...": "" } }
```

Events: `artifact.published`, `artifact.updated` (new version), `artifact.meta`, `artifact.shared`,
`artifact.unshared`, `artifact.deleted` (carries only `slug`). With `ARTIFACTS_WEBHOOK_SECRET`, the header
`X-Artifacts-Signature: sha256=<hex HMAC-SHA256 of the raw body>` authenticates the call. Delivery is
best-effort (one attempt, 5 s timeout); use the API to reconcile.

## Compatibility routes

Clients of the earlier internal service keep working:

| Route | Behaviour |
|---|---|
| `POST /a` | Same body as `POST /api/v1/artifacts`; `rotateKey: true` revokes the share links of a shared artifact. Answers `{slug, public, viewUrl, publicUrl?, version, versionInfo: {n, sha}, created}`. |
| `PATCH /a/{slug}` | Same body as the metadata `PATCH`. Answers `{ok, slug, title, description, task, tags, public, viewUrl, publicUrl?}`. |
| `GET /a/{slug}/diff?from=&to=` | `{from, to, fromVersion, toVersion, source, approximate, stats, blocks}` with version ids in `from`/`to`; same reading rights and parameters as `/api/v1/artifacts/{slug}/diff`. |
| `GET /a/{slug}/versions` | `{versions: [{n, id, sha, createdAt, author, note, current, …}]}`. `sha` repeats `id`; it is a git sha only for imported versions or with `ARTIFACTS_VERSION_ID=sha`. |
| `GET /a/{slug}?k=<key>` | Old share links of imported documents, while the document stays shared. |
