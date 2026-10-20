# Plugins

A plugin is an ES module the server imports at start. It can render widgets into documents, add HTTP routes,
change or refuse what is published, transform pages as they are read, and react to changes. It is the way to add
what only your team needs (chips for your tracker, a status page for your tools, a check on what agents publish)
while running the published image unchanged.

```bash
ARTIFACTS_PLUGINS=/plugins/acme/index.mjs,@acme/artifacts-widgets artifacts serve
```

- `ARTIFACTS_PLUGINS` is a comma-separated list. A path (starting with `/`, `./`, `../` or `file:`) is resolved
  against the working directory; anything else is a package name resolved from the server's `node_modules`.
- Plugins load in order, before the server listens. A plugin that cannot be imported or whose `register` throws
  stops the start with exit code 2: running without a plugin the documents rely on would be worse.
- Plugins run in the server process with its rights (storage credentials, tokens). Load only code you trust.

A working example lives in [`examples/plugins/github-issue`](../examples/plugins/github-issue/index.mjs): an issue
chip widget and one route, no network calls.

## The module

```js
export const name = 'acme'      // optional; used in logs and errors (default: the module path)
export const apiVersion = 1     // optional; the server refuses to load a plugin written for another version

export default async function register(api) {
  api.addWidget('ticket', { phase: 'publish', render: ({ ref }) => `<a class="artifact-chip" href="https://tracker.example.com/${api.html.escape(ref)}">${api.html.escape(ref)}</a>` })
}
```

The default export may also be an object with a `register(api)` method, or the module may export `register`.
`register` may be async; the server waits for it.

## The `api` object

| Member | What |
|---|---|
| `version` | Plugin API version, `1`. It changes only when the contract below breaks. |
| `name` | The plugin's name. |
| `config` | The server configuration as loaded from the environment (read-only). Plugins read their own settings from `process.env`; prefix them with the plugin name. |
| `log(level, msg, extra?)` | The server's logger; entries carry `plugin: <name>`. Levels: `debug`, `info`, `warn`, `error`. |
| `artifacts` | Read access to the catalog, see [below](#reading-the-catalog). |
| `html.escape(text)` | HTML-escapes text for attribute values and content. |
| `html.parseAttributes(text)` | Parses `a="1" b='2' c` into `{a: '1', b: '2', c: ''}`. |
| `error(status, code, hint?)` | An error that becomes the HTTP answer `{"error": code, "hint": hint}` with `status` when thrown from a route or a publish hook. |
| `addWidget(type, spec)` | Registers a widget renderer. |
| `addRoute(method, path, handler, options?)` | Registers an HTTP route. |
| `onPublish(hook)` | Runs before a version is stored. |
| `onRead(hook)` | Runs when a page is served. |
| `on(event, listener)` | Runs after a change. |
| `service` | The internal service object. Not part of the stable contract; prefer `artifacts`. |

### Widgets

Documents carry placeholders:

```html
<artifact-widget type="github-issue" ref="ly-solutions/artifacts#12" title="Pagination"></artifact-widget>
<artifact-widget type="status" ref="checkout-api">Status of checkout-api</artifact-widget>
<artifact-widget type="status" ref="search-api"/>
```

`addWidget(type, { phase, render })` (or `addWidget(type, render)`, phase `read`):

- `type`: lowercase letters, digits and dashes. `kpi` is built in; one plugin per type.
- `phase: 'publish'`: rendered once when a version is published and stored in that version's HTML — a snapshot
  that reads the same forever and costs nothing at read time. Placeholders a publish widget could not render, or
  that sit in a Markdown-only version, render at read time instead.
- `phase: 'read'`: rendered every time the page is served (`/a/{slug}/raw`, `/s/{token}/raw`), so it can show live
  data. Keep it fast and cache what you fetch.
- `render(ctx)` returns the HTML that replaces the placeholder, or `null`/`undefined` to leave it in place (an
  unknown element to browsers, so its body shows as written). It may be async. A render that throws or takes
  longer than `ARTIFACTS_WIDGET_TIMEOUT` (default 5s) is logged and leaves the placeholder.

`ctx` holds:

| Field | |
|---|---|
| `type`, `ref` | the placeholder's `type` and `ref` attributes (`ref` is `null` when missing) |
| `attrs` | every attribute, entity-decoded |
| `body` | the raw HTML between the tags (`""` for the self-closing form) |
| `phase` | `publish` or `read` |
| `slug`, `title` | the document |
| `version` | `{n, id}` at read time, `null` at publish (the id is not assigned yet) |
| `shared` | `true` when the reader holds only a share link or a `?k=` key, not a team account or token. Leave out internal details (assignees, private links) when it is set. |

The output lands inside the published document, which is served in a sandbox without `allow-same-origin` and with
the content security policy of [configuration.md](configuration.md#content-policy). Escape everything that comes
from the reference or an external system with `api.html.escape`. Wrapped documents (fragments and Markdown) style
`<a class="artifact-chip">` as an inline chip. Placeholders are matched in the HTML text; one document renders at
most 200 widgets.

Only the rendered pages change: `/api/v1/artifacts/{slug}/content` keeps returning the source as published (with
publish-phase widgets already rendered, since they are part of the stored version), and the search index reads the
stored version.

### Routes

```js
api.addRoute('GET', '/api/v1/x/acme/status/:service', async (ctx) => {
  return { service: ctx.params.service, ok: true } // a returned value is sent as JSON 200
}, { auth: 'read' })
```

- `method`: `GET` (also answers `HEAD`), `POST`, `PUT`, `PATCH` or `DELETE`.
- `path` must start with `/x/`, `/api/v1/x/` or `/a/:slug/x/`, so a plugin can never shadow a built-in route,
  today or in a later release. Segments starting with `:` are parameters. Under `/a/:slug/x/`, `slug` is checked to
  be a valid slug (it may still name no artifact; `ctx.artifacts.get` tells). CORS (`ARTIFACTS_CORS_ORIGINS`)
  applies to routes under `/api/`.
- `auth`: `read` (default; viewers and editors; a browser without a session is sent to sign in), `write`
  (editors), `share` (editors and sharers), or `none` (anyone, e.g. a webhook receiver that checks its own
  signature). Cookie-authenticated `write`/`share` requests must come from this server's pages, like the built-in
  API.

The handler receives `ctx`:

| Field | |
|---|---|
| `req`, `res` | Node's request and response, for streaming or anything else |
| `method`, `url`, `params`, `query` | the request; `query` is a `URLSearchParams` |
| `principal` | `{name, email, role, via}` of the caller (`role`: `editor`, `viewer`, `sharer` or `none`) |
| `artifacts` | read access to the catalog |
| `readJson(limit?)`, `readBody(limit?)` | the request body (JSON needs `Content-Type: application/json`; default limit 1 MiB) |
| `json(status, body, headers?)`, `html(status, body, headers?)`, `send(status, body, headers?)`, `redirect(location)` | answers; `html` sets this server's UI content security policy unless `headers` override it |

Return a value to answer it as JSON, return nothing after answering yourself (or get `204`), or throw
`api.error(status, code, hint)`. Any other error is logged and answered `500 {"error": "plugin_error"}`.

### Publish hooks

```js
api.onPublish(async (draft, ctx) => {
  if (draft.html?.includes('BEGIN PRIVATE KEY')) throw api.error(422, 'secret_in_document', 'remove the key and publish again')
  draft.note ??= 'published by an agent'
})
```

`draft` is `{slug, title, html, markdown, note}`; change `html`, `markdown`, `title` or `note` in place. `ctx` is
`{principal, existing, body}`: who publishes, the artifact as it is now (`null` for a new one), and the request body
as sent. Hooks run in plugin order, after the request is validated and before publish-phase widgets render; the
result is validated again (size, title). Throwing `api.error(...)` refuses the publish with that answer; any other
error refuses it with `500 plugin_error`.

### Read hooks

```js
api.onRead((page, ctx) => page.html.replace('</body>', '<footer>Internal</footer></body>'))
```

Called for every rendered page after read-phase widgets, with `page = {html}` and
`ctx = {slug, title, version: {n, id}, shared, artifact}`. Return the new HTML, or nothing to keep it. A hook that
throws is logged and skipped.

### Events

```js
api.on('artifact.published', (event) => { /* { event, at, artifact } */ })
api.on('*', (event) => {})
```

The same events and payloads as [webhooks](api.md#webhooks): `artifact.published`, `artifact.updated`,
`artifact.meta`, `artifact.shared`, `artifact.unshared`, `artifact.deleted`. Listeners run after the change is
stored, are not awaited, and a failing listener only logs. Changes made by another replica do not reach this
replica's listeners; use the webhook for a single delivery point.

### Reading the catalog

`api.artifacts` (and `ctx.artifacts` in routes):

| Method | Returns |
|---|---|
| `get(slug)` | the artifact object with `versions`, as `GET /api/v1/artifacts/{slug}` answers it, or `null` |
| `list(query)` | the same as `GET /api/v1/artifacts`: `{total, offset, limit, nextOffset, items}`; query `{q, tags, task, session, author, limit, offset}` |
| `content(slug, ref?)` | `{n, id, html, markdown}` of a version (latest by default) |
| `diff(slug, {from, to, source})` | the same as `GET /api/v1/artifacts/{slug}/diff` |
| `viewUrl(slug)` | where people read the document |

## Packaging

The simplest deployment mounts a single file and points `ARTIFACTS_PLUGINS` at it. Everything a plugin needs is on
`api`, so it does not have to import anything from the server.

With Docker:

```bash
docker run -v "$PWD/plugins:/plugins:ro" -e ARTIFACTS_PLUGINS=/plugins/acme/index.mjs ghcr.io/ly-solutions/artifacts
```

With the Helm chart, put the plugin in a ConfigMap or an image, mount it with `extraVolumes`/`extraVolumeMounts`,
and set `plugins.modules`.

A plugin with dependencies can be built into an image on top of the server's:

```dockerfile
FROM ghcr.io/ly-solutions/artifacts:<version>
COPY --chown=node:node acme-plugin /app/node_modules/@acme/artifacts-plugin
ENV ARTIFACTS_PLUGINS=@acme/artifacts-plugin
```
