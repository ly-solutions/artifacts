# Integration contract: harnessly

[harnessly](https://github.com/ly-solutions/harnessly) is a workspace where people and coding agents work side by
side. Agents in it write reports, plans and reviews; artifacts is where those documents live. This page is the
contract between the two: what harnessly sets and calls, what artifacts guarantees. Nothing here requires
changes to artifacts beyond configuration, and harnessly can adopt the pieces one at a time.

```
 harnessly UI ─── iframe ───────────────▶ artifacts /embed/{slug}            (people read in a pane)
 harnessly backend ── Bearer read token ─▶ artifacts /api/v1/artifacts?session=…  (list a conversation's documents)
 agent in a harnessly tab ── artifacts CLI (ARTIFACTS_URL/TOKEN/SESSION) ─▶ /api/v1/artifacts  (publish)
 artifacts ── webhook (signed) ─────────▶ harnessly backend                  (a document appeared or changed)
```

## 1. How an agent in harnessly publishes

harnessly provides the agent's environment. For every agent tab (Claude Code, Codex, a shell), the runtime adds:

| Variable | Value | Why |
|---|---|---|
| `ARTIFACTS_URL` | the catalog, e.g. `https://artifacts.example.com` | where the CLI talks to |
| `ARTIFACTS_TOKEN` | an editor token (see [tokens](#5-tokens)) | permission to publish |
| `ARTIFACTS_SESSION` | the conversation id of this tab | links every document to the conversation that produced it |
| `ARTIFACTS_AUTHOR` | the person who owns the tab, e.g. `Ada (agent)` | the catalog shows who asked for the document |

and makes two things available:

- the CLI: `npm install -g @ly-solutions/artifacts` on the machine image, or the container image
  `ghcr.io/ly-solutions/artifacts` used as a command;
- the agent skill [`skills/artifacts/SKILL.md`](../../skills/artifacts/SKILL.md), installed as a Claude Code plugin
  or copied into the agent's skills folder. It tells the agent to search before writing, to publish new versions
  under the same slug, and to share only on request.

The agent then runs, for example:

```bash
artifacts find "rate limits"
artifacts publish --file proposal.md --title "API rate limits proposal" --tags api,proposal
artifacts publish --slug api-rate-limits-proposal-4k2m9x --file proposal.md --note "added the burst column"
```

The CLI sends `session: $ARTIFACTS_SESSION` with every publish. Nothing else is needed; the CLI never reads
harnessly's files or sockets.

## 2. How artifacts link to conversations

Every artifact has a `session` field: an opaque id of up to 200 characters (`[A-Za-z0-9._:@/+-]`). artifacts
stores it, filters by it and turns it into a link; it never interprets it.

- **From a conversation to its documents:** `GET /api/v1/artifacts?session=<conversation id>` returns every
  artifact that conversation published, newest first. harnessly shows them in the conversation's side panel.
- **From a document to its conversation:** set `ARTIFACTS_SESSION_URL` on the artifacts server to harnessly's
  conversation URL, e.g. `https://harnessly.example.com/conversations/{session}`. The catalog and the reader then
  show a "conversation" chip that opens it, and the API returns `sessionUrl`.
- **Re-linking:** `PATCH /api/v1/artifacts/{slug}` with `{"session": "<id>"}` (or `null`) moves a document to
  another conversation, e.g. after a conversation was forked.

Use the conversation id harnessly already shows in its URLs, so the link template is a plain substitution.

## 3. How harnessly shows an artifacts pane

### URLs

| URL | Use |
|---|---|
| `{ARTIFACTS_URL}/embed/{slug}` | the pane: title, version, an "Open" button, the document; no catalog chrome |
| `{ARTIFACTS_URL}/embed/{slug}?v={n}` | a specific version (number or version id) |
| `{ARTIFACTS_URL}/embed/{slug}?theme=dark` | start in a theme; later changes go through `postMessage` (below) |
| `{ARTIFACTS_URL}/a/{slug}` | the full reader, for "open in a new tab" |
| `viewUrl`, `embedUrl` in API answers | the same, already resolved |

Frame it like this:

```html
<iframe src="https://artifacts.example.com/embed/api-rate-limits-proposal-4k2m9x?theme=dark"
        title="API rate limits proposal"
        style="border:0;width:100%;height:100%"></iframe>
```

No `sandbox` attribute is needed on harnessly's side: the embed page is artifacts' own UI, and the document inside
it is already sandboxed by artifacts (a CSP `sandbox` without `allow-same-origin`).

### Server configuration

On the artifacts server:

```bash
ARTIFACTS_FRAME_ANCESTORS=https://harnessly.example.com    # who may frame /embed and the document
ARTIFACTS_SESSION_URL=https://harnessly.example.com/conversations/{session}
```

`ARTIFACTS_FRAME_ANCESTORS` sets `Content-Security-Policy: frame-ancestors 'self' <origins>` on `/embed/*`, on
`/a/{slug}/raw` (the document, which the embed page frames, so the whole chain must allow harnessly) and on the
shared view. Every other page keeps `frame-ancestors 'none'`.

### Messages between the pane and harnessly

The embed page talks to its parent with `window.postMessage`. Check `event.origin` against `ARTIFACTS_URL` on
harnessly's side.

| Direction | Message | Meaning |
|---|---|---|
| artifacts → harnessly | `{type: "artifacts:ready", slug, version}` | the pane loaded this version |
| artifacts → harnessly | `{type: "artifacts:auth-required", loginUrl}` | the person is not signed in to artifacts; open `loginUrl` in a new window, then reload the iframe |
| harnessly → artifacts | `{type: "artifacts:theme", theme: "light" \| "dark" \| "auto"}` | follow harnessly's theme |

### Signing in inside the pane

The pane uses the person's artifacts session (a cookie on the artifacts host). Pick one deployment:

1. **Same site, same identity provider (recommended).** Run artifacts on a sibling host of harnessly, e.g.
   `harnessly.example.com` and `artifacts.example.com`, with `ARTIFACTS_AUTH=oidc` against the provider harnessly
   uses. Cookies with `SameSite=Lax` are sent to same-site frames, so a person signed in once sees documents
   everywhere. The first time, the pane shows "Sign in" and sends `artifacts:auth-required`; the sign-in opens in a
   new window because identity providers refuse to be framed.
2. **Behind the same authenticating proxy.** If harnessly already sits behind oauth2-proxy, Pomerium or similar,
   put artifacts behind it too with `ARTIFACTS_AUTH=proxy` and the proxy's addresses in
   `ARTIFACTS_PROXY_TRUSTED_CIDRS`.
3. **Different sites.** Set `ARTIFACTS_COOKIE_SAMESITE=none` (requires https) so the session cookie is sent to the
   frame. Browsers that block third-party cookies (Safari, and Chrome with that setting) will still ask the person
   to sign in; prefer option 1.

Changes from the pane (share, metadata) are only possible from artifacts' own pages, which check `Origin`; the
embed view itself is read-only.

### Reading in harnessly instead of artifacts

If harnessly has its own document page (with comments, say), make it the place every link opens:

```bash
ARTIFACTS_READER_URL=https://harnessly.example.com/docs/{slug}?v={version}
```

`viewUrl` in API answers and webhooks then points at harnessly, and old `/a/{slug}` links pasted in chats and
trackers redirect there (`302`) for anyone without an artifacts session. harnessly's page reads the document
server-side (`GET /a/{slug}/raw?v=…` or `/api/v1/artifacts/{slug}/content` with a viewer token) and can show
changes with `GET /api/v1/artifacts/{slug}/diff`.

## 4. Live updates

Point artifacts' webhook at harnessly:

```bash
ARTIFACTS_WEBHOOK_URL=https://harnessly.example.com/hooks/artifacts
ARTIFACTS_WEBHOOK_SECRET=<shared secret>
```

Each publish, new version, metadata change, share, unshare and delete POSTs
`{"event": "artifact.updated", "at": "…", "artifact": {…, "session": "<conversation id>", "embedUrl": "…"}}` with
`X-Artifacts-Signature: sha256=<HMAC-SHA256 of the body>`. harnessly verifies the signature, routes the event by
`artifact.session` to the conversation, and can open the pane on `artifact.published` or show "updated to v3" on
`artifact.updated`. Delivery is best-effort; on reconnect, re-list with `?session=`.

## 5. Tokens

| Token | Held by | Used for |
|---|---|---|
| editor (`ARTIFACTS_TOKEN`) | agent environments | publishing, metadata |
| viewer (`ARTIFACTS_READ_TOKEN`) | harnessly backend | listing a conversation's documents, reading versions |
| editor | harnessly backend, optional | share and unshare buttons in harnessly's UI |

Keep tokens on servers and in agent environments, never in browser code. `ARTIFACTS_TOKEN` accepts a
comma-separated list, so each machine or person can get its own token and lose it without affecting others.
With `ARTIFACTS_AUTH=oidc` and `ARTIFACTS_OIDC_ACCEPT_BEARER=true`, harnessly can instead forward the person's
access token from the shared identity provider, and artifacts applies that person's role.

## 6. What harnessly implements (checklist)

- [ ] inject `ARTIFACTS_URL`, `ARTIFACTS_TOKEN`, `ARTIFACTS_SESSION`, `ARTIFACTS_AUTHOR` into agent tabs;
- [ ] ship the `artifacts` CLI and the `artifacts` skill with agent images;
- [ ] a pane that frames `/embed/{slug}`, follows `artifacts:auth-required` and sends `artifacts:theme`;
- [ ] a conversation panel fed by `GET /api/v1/artifacts?session=…` (viewer token, server-side);
- [ ] optionally, a webhook receiver that verifies `X-Artifacts-Signature` and routes by `artifact.session`.

On the artifacts side, the whole integration is configuration: `ARTIFACTS_FRAME_ANCESTORS`,
`ARTIFACTS_SESSION_URL`, `ARTIFACTS_WEBHOOK_URL` / `_SECRET`, and an auth mode shared with harnessly.

The sibling project [ly-solutions/boards](https://github.com/ly-solutions/boards) (whiteboards agents can read and
draw) follows the same pattern for its own pane.
