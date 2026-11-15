# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The agent's edits are shown as one turn: the changed places stay lit, a bar says «Агент изменил N раздела · Показать ·
  Отменить», one «Отменить» returns the document to how it was before the turn (several `doc_edit` within three minutes
  are one turn). The same line, with the agent's one-line `note` and the chips «Показать в документе» / «Отменить»,
  is in the chat of the document. In an HTML page the changed elements are outlined in the frame.
- `doc_edit` on an HTML page answers with `look.url`: the address to open and take a picture of before and after.
- Comment threads in the new look: the quoted words on top, the resolve tick in the first message, reactions, a one-line
  reply with «@», the agent's answers with «Показать в документе» / «Отменить»; «Открытые · Решённые · Мне» as a segment.
- The chat of the document: the person's questions as bubbles, the agent's turns, «агент печатает» while it works.
- Callouts take the colour of their kind (`note`, `tip`, `important`, `warning`, `caution`) and keep it on a dark page;
  the colours of words follow the theme (the file keeps what was written).
- A document's byline sits under its title: who has worked on it, who changed it last, when.
- The list shows who has worked on each document and a `⌘K` hint on the search.

### Fixed

- A list line no longer shows callout markers or colour tags; the `<style>` of an HTML page no longer makes a console
  error when the page is opened for editing.

### Added

- In a harnessly installation a person makes, copies, renames and trashes documents from the list and from the open
  document: the requests go to the hub (`/api/platform/docs`) as that person, with the documents' access token and the
  person's own app token (`X-Harnessly-Token`, kept in the session at sign-in, never given to the page). A trash is
  quiet: «В корзину» with «Отменить», and «Корзина» in the list's «⋯» to take things out again.
- The trash is respected here: a document in it answers 404 to everyone but a service token, leaves the lists and the
  public links. The flag is kept in `trash.json` and set by `POST /api/v1/artifacts/{slug}/trash` (`{trashed: bool}`,
  service token) or by a trash made through this service.

### Fixed

- A document in the hub's trash no longer opens by its address for a person who signed in directly (single sign-on).

### Added

- Text documents: underline and colour of words and of their background from the selection bar. They are kept in the
  Markdown as inline HTML (`<u>`, `<span style="color:…;background-color:…">`); the view lets only those two
  properties through, and only real colours (no `url()`, no `var()`).

### Fixed

- Editing an HTML page no longer reports a Content-Security-Policy error for every `style="…"` of the source.

### Added

- The app view is redesigned after the Sinopia prototype «Документы 2.0» (`web/docs/`): a list with search, tabs and
  groups; a text document you edit in place (blocks, «/» menu, selection bar, Markdown stays the source); an HTML page
  you edit visually (select an element, Style island, «у всех таких же», page CSS, text in place, undo/redo, device
  preview); comments on words and on page elements with threads, reactions and `@агент`; versions, conflict banner
  and autosave; light and dark themes and a phone layout.
- Comments live here (`comments/<slug>.json`, `GET/POST /app/comments…`), with MCP tools `doc_comments`, `doc_reply`,
  `doc_comment` and `doc_edit`: the agent answers a thread and changes one fragment as a new version the person can
  undo. See docs/mcp.md.
- The app package is 0.5.0.

### Fixed

- The app view follows a document harnessly asks for later in the same window (`context` event): harnessly keeps the
  window alive between boards, documents and their lists (HRN-1469). Only a new ask moves the view.

### Changed

- The harnessly app view (`/app`) is a site of its own: it reads the catalog (`GET /app/docs`) and a document
  (`GET /app/doc`) by the session cookie, opens a document in the same frame (`?doc=<slug>`) with a way back, and no
  longer waits for the harnessly bridge or the machine. The first sign-in goes through the new MCP tool `doc_signin`
  (a one-time pass the page posts to `/app/enter`); the session is the hub person's, with rights still asked of the hub. The «Что
  напишем?» field and its starters are gone. The app package (0.3.0) has one view, for the app and the pane.

### Added

- `harnessly-app/`: the harnessly app package «Документы» (manifest, `.mcp.json` with the installation's address
  and platform sign-in, the agent's instructions and skill, a home view, an eval). Kept out of the image.
- `ARTIFACTS_AUTH=harnessly` (off by default): agents come with app tokens a harnessly hub signs for a person
  (EdDSA, discovery or the hub's well-known JWKS), and see, read and share only the documents the hub allows that
  person (`POST <hub>/api/platform/docs/_rights`, cached up to 10 s). Static tokens and share links keep working.
  See docs/integrations/harnessly.md, section 7.
- MCP endpoint `/mcp` (Streamable HTTP) with `doc_find`, `doc_show`, `doc_versions` and `doc_share`. There is no
  publishing tool: in harnessly agents publish through the hub. See docs/mcp.md.

### Fixed

- Lost versions on S3-compatible stores whose preconditions are not atomic under concurrency (seen on Selectel
  ru-3). Two simultaneous publishes of one document both answered `created` and one version vanished. The S3
  driver now serialises conditional writes per key inside the process. See docs/storage.md, "Stores without
  atomic preconditions".

### Added

- `artifacts storage-check`: measures whether the store refuses overlapping conflicting writes, so operators know
  whether more than one replica is safe.
- Helm `strategy` value (set `type: Recreate` on a store that fails `storage-check`).
- In-memory read cache for the s3 driver (`ARTIFACTS_CACHE_MB`, 128 MiB by default): version content is served from
  memory and manifests are revalidated with a HEAD, for stores whose GETs are slow while HEAD is fast (seen on
  Selectel ru-3, about 4 s per GET). `ARTIFACTS_INDEX_CONCURRENCY` (16, was a fixed 8) shortens the start.
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
