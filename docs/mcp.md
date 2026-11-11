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
| editor or viewer token, OIDC bearer, session | every document, by role |
| no token, share token | `401` |

A request with an `Origin` header from a site other than this server (or one in `ARTIFACTS_CORS_ORIGINS`) is
refused, so a web page cannot drive the tools with a visitor's credentials.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `doc_find` | `query`, `tags`, `task`, `limit` (≤ 50, default 20), `offset` | `items` (slug, title, description, tags, author, updatedAt, versions, url, snippet), `total`, `nextOffset` |
| `doc_show` | `slug`, `version` (number or id; current by default), `format` (`markdown` default, `text`, `html`) | metadata, `version`, `format` and `content` (cut at 200 000 characters with `truncated: true`) |
| `doc_versions` | `slug` | `versions`, newest first |
| `doc_share` | `slug`, `public` (default `true`), `expiresIn` (`7d`, `12h`…) | `url` and `expiresAt` of a share link, or `public: false` after closing every link; needs the right to edit |

A document the caller may not read and a missing one give the same tool error. When the hub does not answer the
rights request, tools return an error instead of guessing.

## Publishing is not here

There is no publishing tool. In harnessly, agents publish through the hub (`doc.publish`), which owns the rights
and writes here with its editor token; outside harnessly, publish with the `artifacts` CLI or `POST /api/v1/artifacts`.
