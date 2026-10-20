# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- List pagination you can follow: `GET /api/v1/artifacts` answers with `offset`, `limit` and `nextOffset`
  (`null` on the last page) plus a `Link: rel="next"` header; the catalog page pages by 200 with Newer/Older
  links instead of silently showing only the first 200; `artifacts find` takes `--offset` and `--all`.
- `ARTIFACTS_READER_URL` (with `ARTIFACTS_READER_REDIRECT`): hand the document page to an external reader.
  `viewUrl` points there, and `GET /a/{slug}` from browsers without a session (or all browsers) answers `302`
  to the template, with `{slug}`, `{version}` (resolved id) and `{n}`. Off by default.
- Plugins (`ARTIFACTS_PLUGINS`): modules loaded at start that render `<artifact-widget type=… ref=…>`
  placeholders at publish or read time, add routes under `/x/`, `/api/v1/x/` and `/a/{slug}/x/`, change or refuse
  publishes, transform served pages and listen to change events. Documented in `docs/plugins.md`, with an example
  issue-chip plugin in `examples/plugins/github-issue`. `ARTIFACTS_WIDGET_TIMEOUT` bounds one widget render.
- Wrapped documents style `<a class="artifact-chip">` as an inline chip.
- Package entry points (`exports`): `@ly-solutions/artifacts` (server, config, service, storage, plugin host, diff
  and text helpers), `@ly-solutions/artifacts/plugin` (helpers for plugin packages, `definePlugin`),
  `@ly-solutions/artifacts/diff` and `@ly-solutions/artifacts/text`.
- `GET|PUT /api/v1/artifacts/{slug}/access` (and `/a/{slug}/access`): whether the caller may read, write or
  share a document, with a short-lived read link (`ARTIFACTS_READ_LINK_TTL`, default 15m) for anyone who may
  read, including someone who holds only a share link (`X-Artifacts-Share`). `PUT {"public": bool}` turns
  sharing on or off.
- `sharer` role (`ARTIFACTS_SHARE_TOKEN`): may only turn sharing on and off, cannot read or publish.
- Version diff: `GET /api/v1/artifacts/{slug}/diff?from=&to=` (JSON line blocks or a unified patch), comparing
  the Markdown sources or the visible text; `GET /a/{slug}/diff` in the earlier service's shape;
  `artifacts diff SLUG [FROM] [TO]`.
- `ARTIFACTS_VERSION_ID=sha`: new versions get 40-hex ids (SHA-1 over slug, creation time and content hash) for
  clients that expect git-shaped ids; the default stays `timestamp`, and every stored id keeps resolving.
- Publishing accepts `versionId` to keep an id from another system (e.g. a git sha) when replaying history through
  the API; `409 version_exists` for an id the artifact already has.
- `ARTIFACTS_CONTENT_FRAME_SRC`: origins published documents may frame (a whiteboard, a video), instead of the
  fixed `frame-src 'none'`. Content source lists are checked at start for entries that would break the policy.

### Changed

- Files under `src/` can no longer be imported from outside the package; use the entry points above. The
  `artifacts` command is unchanged.

### Fixed

- Invalid S3 bucket names are refused at start with the naming rule, instead of failing on the first request
  with `400 InvalidBucketName`.
- CI: the MinIO job used the bucket name `ci`, which S3 rejects, so the test suites' setup failed and every test
  was reported as cancelled. It now uses `artifacts-ci`, waits for `/minio/health/ready` and for a real bucket
  round trip (`scripts/wait-for-s3.mjs`), and the suites fail fast with a clear message on a bad test bucket.

## [0.1.0] - 2026-10-19

First public release.

### Added

- Publish HTML or Markdown documents; publishing again under the same slug adds a version.
- Refusal of near-duplicate titles without a slug (`"new": true` overrides), with the candidates listed.
- Versions list, read any version by number or id, optimistic concurrency with `baseVersion`.
- Metadata edits without a new version: title, description, tags, task, link, conversation (`session`), sharing.
- Search over titles, tags, metadata and text, with tag, task, session and author filters.
- Reader with light and dark typography for fragments and Markdown, KPI widgets, sandboxed full HTML pages,
  version picker, share and edit dialogs; embed view for other apps.
- Signed, expiring, revocable share links.
- Storage drivers: S3 (AWS and S3-compatible, conditional writes, no SDK) and filesystem.
- Authentication: static editor/viewer tokens, OpenID Connect (code flow with PKCE), trusted proxy headers, none.
- Webhooks with HMAC signatures; task and conversation link templates; CORS and frame-ancestor settings.
- `artifacts` CLI: find, publish, versions, get, meta, share, unshare, delete, serve, migrate.
- Import from a git repository with full history (`migrate --from-git`), copy between stores (`migrate --from`).
- Compatibility with the earlier publish contract (`POST /a`, `PATCH /a/{slug}`, `?k=` links).
- Dockerfile, Docker Compose with MinIO, Helm chart, Argo CD example.
- Claude Code skill and plugin marketplace entry for agents.

[Unreleased]: https://github.com/ly-solutions/artifacts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ly-solutions/artifacts/releases/tag/v0.1.0
