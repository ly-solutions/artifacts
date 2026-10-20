# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- List pagination you can follow: `GET /api/v1/artifacts` answers with `offset`, `limit` and `nextOffset`
  (`null` on the last page) plus a `Link: rel="next"` header; the catalog page pages by 200 with Newer/Older
  links instead of silently showing only the first 200; `artifacts find` takes `--offset` and `--all`.

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
