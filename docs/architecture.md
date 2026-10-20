# Architecture

```
            people (browser)                     agents (CLI, skill, HTTP)
                  │  session cookie / OIDC / proxy        │  Bearer token
                  ▼                                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ artifacts server (Node.js, one process, stateless)               │
   │                                                                  │
   │  UI pages ── catalog, reader, embed, shared view, sign-in        │
   │  /api/v1 ─── publish, versions, metadata, share, search          │
   │  /a/{slug}/raw ── the document, sandboxed by CSP                 │
   │                                                                  │
   │  service ── duplicate check, CAS on manifests, share tokens      │
   │  catalog index ── metadata + text in memory, refreshed by ETag   │
   │  auth ── token │ oidc │ proxy │ none                             │
   │  storage driver ── s3 (SigV4, conditional PUT) │ fs              │
   └──────────────────────────────────────────────────────────────────┘
                  │
                  ▼
   S3 bucket or directory:  meta/<slug>.json · content/<slug>/<version>/… · system/secret.json
```

## Principles

- **Storage is the only state.** Pods can be killed at any moment; nothing is lost and nothing needs a disk.
  The in-memory index is a cache rebuilt from storage.
- **Versions never change.** New content gets a new id. The manifest is the only mutable object and every write
  to it is a compare-and-swap.
- **Published HTML is untrusted.** It is served on its own path with a CSP sandbox and no `allow-same-origin`, so
  scripts inside a document cannot read cookies, call the API, or (by default) reach the network. The reader frames
  it; the UI itself runs with `script-src 'self'` and no inline code.
- **Agents are first-class clients.** Every error explains what to change. Publishing without a slug refuses
  near-duplicate titles, which keeps one document per topic with a history instead of "v2" copies.
- **Every integration is optional configuration.** Task links, conversation links, frame ancestors, CORS, webhooks
  and identity providers are environment variables; none is required to run.

## Request paths

**Publish** (`POST /api/v1/artifacts`)
1. Validate; derive the title from the document if missing.
2. Without a slug: check the index for duplicates (normalised title, or same task and ≥ 60 % shared title words).
3. Write `content/<slug>/<newId>/index.html` and/or `document.md` with `If-None-Match: *`.
4. Read the manifest, append the version, write it back with `If-Match: <etag>` (or `If-None-Match: *` for a new
   artifact). On a conflict, repeat step 4 (up to 8 times).
5. Update the local index, fire the webhook.

**Read** (`/a/{slug}`) reads the manifest from storage, renders the reader page and frames
`/a/{slug}/raw?v=N`, which loads the version's objects and either serves the full document or wraps a fragment
or Markdown in the typography.

**Share.** A share link is `base64url({s: slug, g: generation, e: expiry}).HMAC`. It opens the artifact only while
`public` is true and the manifest's `share.gen` equals `g`. Turning sharing off increments the generation,
revoking every link at once without a revocation list. A read link (from `/access`) has the same shape under a
different signing purpose, always expires within `ARTIFACTS_READ_LINK_TTL`, and opens the document whether or
not it is shared; it also dies with a generation bump. The signing key is `ARTIFACTS_SECRET`, or a random key
generated once and stored in `system/secret.json`, shared by all replicas.

**Search.** At start, the index lists `meta/`, loads every manifest and the visible text of each current
version. Afterwards it re-lists `meta/` at most every `ARTIFACTS_INDEX_REFRESH` and reloads only manifests whose
ETag changed. Ranking: title (10) > tags (6) > slug, description, task, author (3) > body text (1); every query
word must match.

## Code map

| Path | Role |
|---|---|
| `bin/artifacts.mjs`, `src/cli.mjs` | The `artifacts` command: `serve`, `migrate`, client commands |
| `src/server.mjs` | HTTP routing, CSP, CORS, auth gates, compatibility routes |
| `src/service.mjs` | Publish, metadata, versions, sharing, webhooks |
| `src/catalog.mjs` | In-memory index, search, duplicate detection |
| `src/store.mjs` | Storage layout on top of a driver |
| `src/storage/` | `fs` and `s3` drivers, SigV4 |
| `src/auth/` | Token, OIDC (code flow + PKCE, JWKS), trusted proxy, CIDR matching |
| `src/plugins.mjs` | Plugin loader and host: widgets, routes, publish and read hooks, events |
| `src/diff.mjs` | Line diff (Myers) and unified patches for version comparison |
| `src/signing.mjs` | Signed share links and session cookies |
| `src/render/` | Document typography, Markdown, widgets; server-rendered UI pages |
| `src/migrate/git.mjs` | Import from a git repository; copy between stores |
| `web/` | CSS, small progressive-enhancement scripts, fonts, icons |

Runtime dependencies: [`marked`](https://github.com/markedjs/marked) (MIT) for Markdown and
[`yaml`](https://github.com/eemeli/yaml) (ISC) for importing `meta.yaml`. Everything else is the Node.js standard
library.

## Limits and non-goals

- Documents are single pages up to 8 MB (configurable); images are inlined by the CLI. There is no attachment store.
- Search is in-memory and fits tens of thousands of documents per replica. A larger catalog wants an external index.
- There are no comments or real-time co-editing; a workspace that embeds the reader (see
  [harnessly integration](integrations/harnessly.md)) can add them around it.
