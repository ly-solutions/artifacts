# MCP endpoint

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP. An agent
connects to it with a bearer token and finds, reads and shares documents with four tools. It answers every
JSON-RPC request with a JSON body and opens no server-sent stream (`GET /mcp` is `405`).

```json
{ "mcpServers": { "docs": { "type": "http", "url": "https://docs.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

## Who sees what

| Caller | Documents |
|---|---|
| hub app token (`ARTIFACTS_AUTH=harnessly`) | only those the hub allows the person (`view`, `comment`, `edit`); see [the harnessly integration](integrations/harnessly.md#7-signing-in-with-a-hub-app-token) |
| editor or viewer token, OIDC bearer | every document, by role |
| no token, share token, browser session cookie | `401` |

Requests are JSON (`Content-Type: application/json`, otherwise `415`); a batch holds at most 20 messages, run
one after another. A request with an `Origin` header from a site other than this server (or one in `ARTIFACTS_CORS_ORIGINS`) is
refused, so a web page cannot drive the tools with a visitor's credentials.

For a hub person, `doc_find` looks among the best 2000 matches of the query; narrow the query to reach further.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `doc_find` | `query`, `tags`, `task`, `limit` (≤ 50, default 20), `offset` | `items` (slug, title, description, tags, author, updatedAt, versions, url, snippet), `total`, `nextOffset` |
| `doc_show` | `slug`, `version` (number or id; current by default), `format` (`markdown` default, `text`, `html`) | metadata, `version`, `format` and `content` (cut at 200 000 characters with `truncated: true`) |
| `doc_versions` | `slug` | `versions`, newest first |
| `doc_comments` | `slug`, `status` (`open` default, `resolved`, `all`), `thread` | `threads`: id, status, `anchor` (the quoted words or the page element), `messages` (author, text, `by` person or agent) |
| `doc_reply` | `slug`, `thread`, `text`, `resolve` | answers a thread as the agent (and closes it with `resolve: true`) |
| `doc_comment` | `slug`, `text`, `quote` | starts a thread, on the quoted words or on the document |
| `doc_edit` | `slug`, `find`, `replace`, `thread`, `reply`, `note` | replaces one fragment (it must occur exactly once in the Markdown or the HTML): a new version of the same document; the person sees it highlighted and can undo it. With `thread` the change and `reply` go into that thread. Needs the right to edit For an HTML page the result also has `look.url`: the address to open in a browser and take a picture of before and after the change. Edits made within three minutes of each other are one turn: the person sees one bar «Агент изменил N раздела» and undoes the whole turn at once. |
| `quick_read` | `object` (slug), `selection` | `{kind: "document", title, text, version}`: the source as stored (Markdown or HTML), `version` as a string. Needs the right to edit |
| `quick_apply` | `object`, `version`, `edits` (`[{old, new}]`), `confirmed` | one new version made by the person (note «Голосовая правка»): `{changed, version, hint}` (`hint`: the changed lines, ≤ 400 characters). Errors: `conflict` (the current version is not `version`), `not_unique` (an `old` is missing or occurs more than once), `needs_yes` (lines would be removed and `confirmed` is not `true`; nothing is saved) |
| `quick_undo` | `object`, `version` | when `version` is the current one, publishes the previous content as a new version: `{changed: true, version}`; `conflict` otherwise, `nothing_to_undo` for the first version |
| `doc_share` | `slug`, `public` (default `true`), `expiresIn` (`7d`, `12h`…) | `url` and `expiresAt` of a share link, or `public: false` after closing every link; needs the right to edit |

The `quick_*` tools serve a host's fast edit (the app declares them as `quickEdit` in `harnessly/app.json`). Their
errors are a tool result with `isError: true` whose text is JSON `{"code": "...", "message": "..."}`; besides the codes
above: `forbidden`, `not_found`, `invalid`.

A document the caller may not read and a missing one give the same tool error. When the hub does not answer the
rights request, tools return an error instead of guessing.

## Publishing is not here

There is no publishing tool. In harnessly, agents publish through the hub (`doc.publish`), which owns the rights
and writes here with its editor token; outside harnessly, publish with the `artifacts` CLI or `POST /api/v1/artifacts`.
