/**
 * MCP endpoint (Streamable HTTP, JSON responses, no server-sent stream) at /mcp.
 *
 * Tools read the catalog as the caller sees it: with a harnessly app token only the documents
 * the hub allows that person. There is no publishing tool on purpose: agents publish through
 * the hub (`doc.publish`), which owns the rights. See docs/mcp.md.
 */
import { readFileSync } from 'node:fs'

import { canRead } from './auth/index.mjs'
import { HubRightsError } from './auth/harnessly.mjs'
import { parseDuration } from './config.mjs'
import { ApiError } from './service.mjs'
import { htmlToText, isValidSlug, normalizeTags } from './text.mjs'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024
const MAX_CONTENT_CHARS = 200_000
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const INSTRUCTIONS =
  'A catalog of versioned documents. doc_find searches the documents you may read, doc_show reads one, ' +
  'doc_versions lists its versions, doc_share opens or closes a share link. ' +
  'There is no publishing here: publish and update documents through the harnessly hub (doc.publish).'

const slugProp = { type: 'string', description: 'Document slug, e.g. release-notes-a1b2c3 (the last part of its /a/<slug> address).' }

export const TOOLS = [
  {
    name: 'doc_find',
    title: 'Find documents',
    description: 'Search the documents you may read, newest and best matches first. Empty query lists recent documents. Publishing is not here: it goes through the hub (doc.publish).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in titles, tags, descriptions and text.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only documents with all of these tags.' },
        task: { type: 'string', description: 'Only documents linked to this task id.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return (default 20).' },
        offset: { type: 'integer', minimum: 0, description: 'Where to continue: nextOffset of the previous call.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_show',
    title: 'Read a document',
    description: 'Read a document: its title, description, tags, version and content as Markdown (or as text taken from its HTML).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: slugProp,
        version: { type: 'string', description: 'Version number (1, 2, …) or id; the current one when omitted.' },
        format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'markdown (default; text when the version has no Markdown), text, or the raw html.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_versions',
    title: 'Document versions',
    description: 'List the versions of a document, newest first, with their numbers, ids, dates and notes.',
    inputSchema: { type: 'object', properties: { slug: slugProp }, required: ['slug'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_share',
    title: 'Share a document',
    description: 'Open a document by link (public: true, the default) and get the link, or close it and revoke every link (public: false). Needs the right to edit the document.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: slugProp,
        public: { type: 'boolean', description: 'true opens by link, false closes and revokes every link.' },
        expiresIn: { type: 'string', description: 'Lifetime of the new link, e.g. 7d or 12h; the server default when omitted.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
]

class ToolError extends Error {}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export function createMcpHandler({ config, service, searchFor, docAccess }) {
  const publicOrigin = new URL(config.publicUrl).origin

  const write = (res, status, body, headers = {}) => {
    if (res.headersSent) return
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers })
    res.end(text)
  }

  const slugOf = (args) => {
    if (!isValidSlug(args.slug)) throw new ToolError('slug: a document slug such as release-notes-a1b2c3')
    return args.slug
  }

  const tools = {
    async doc_find(principal, args) {
      const limit = Math.min(Math.max(Math.floor(Number(args.limit ?? 20)) || 20, 1), 50)
      const offset = Math.max(Math.floor(Number(args.offset ?? 0)) || 0, 0)
      const tags = Array.isArray(args.tags) ? args.tags.flatMap((tag) => normalizeTags(String(tag))) : []
      const result = await searchFor(principal, { q: String(args.query ?? ''), tags, task: args.task ? String(args.task) : undefined, limit, offset })
      const items = result.items.map((item) => ({
        slug: item.slug,
        title: item.title,
        description: item.description,
        tags: item.tags,
        author: item.author,
        updatedAt: item.updatedAt,
        versions: item.versionCount,
        url: item.viewUrl,
        ...(item.snippet ? { snippet: item.snippet } : {}),
      }))
      return { total: result.total, nextOffset: result.nextOffset, items }
    },

    async doc_show(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug)
      const format = args.format ?? 'markdown'
      if (!['markdown', 'text', 'html'].includes(format)) throw new ToolError('format: markdown, text or html')
      const content = await service.readContent(slug, args.version === undefined ? null : String(args.version))
      let body
      let as = format
      if (format === 'html' && content.html !== undefined) body = content.html
      else if (format !== 'text' && content.markdown !== undefined) {
        body = content.markdown
        as = 'markdown'
      } else {
        body = content.html !== undefined ? htmlToText(content.html) : content.markdown
        as = 'text'
      }
      const truncated = body.length > MAX_CONTENT_CHARS
      const artifact = service.present(content.meta)
      return {
        slug,
        title: artifact.title,
        description: artifact.description,
        tags: artifact.tags,
        author: artifact.author,
        url: artifact.viewUrl,
        version: { n: content.n, id: content.version.id, of: artifact.versionCount },
        format: as,
        ...(truncated ? { truncated: true } : {}),
        content: truncated ? body.slice(0, MAX_CONTENT_CHARS) : body,
      }
    },

    async doc_versions(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug)
      const { meta } = await service.get(slug)
      return { slug, versions: service.versionsOf(meta) }
    },

    async doc_share(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug, { need: 'share' })
      if (args.public === false) {
        await service.unshare(slug)
        return { slug, public: false }
      }
      let ttlSeconds
      try {
        ttlSeconds = args.expiresIn ? parseDuration(String(args.expiresIn), 'expiresIn') : undefined
      } catch (error) {
        throw new ToolError(error.message)
      }
      const result = await service.share(slug, { ttlSeconds })
      return { slug, public: true, url: result.url, expiresAt: result.expiresAt ?? null }
    },
  }

  async function callTool(principal, params) {
    const tool = tools[params?.name]
    if (!tool) return null
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    try {
      const data = await tool(principal, args)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data }
    } catch (error) {
      let message
      if (error instanceof ToolError) message = error.message
      else if (error instanceof HubRightsError) message = 'the hub did not answer who may read this document; try again in a minute'
      else if (error instanceof ApiError && error.code === 'not_found') message = 'no such document, or you may not read it'
      else if (error instanceof ApiError) message = error.hint ?? error.code
      else throw error
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  }

  async function dispatch(principal, message) {
    const { id, method, params } = message ?? {}
    const notification = id === undefined
    if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return notification ? null : rpcError(id, -32600, 'invalid request')
    if (notification) return null
    if (method === 'initialize') {
      const asked = params?.protocolVersion
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'artifacts', title: config.siteName, version: VERSION },
          instructions: INSTRUCTIONS,
        },
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    if (method === 'tools/call') {
      const result = await callTool(principal, params)
      return result ? { jsonrpc: '2.0', id, result } : rpcError(id, -32602, `unknown tool ${params?.name}`)
    }
    return rpcError(id, -32601, `method not found: ${method}`)
  }

  return async function handleMcp(req, res, principal) {
    // A browser page on another site must not drive the tools with someone's credentials.
    const origin = req.headers.origin
    if (origin && origin !== publicOrigin && !config.embed.corsOrigins.includes(origin)) return write(res, 403, rpcError(null, -32600, 'origin not allowed'))
    if (req.method !== 'POST') return write(res, 405, rpcError(null, -32600, 'POST JSON-RPC messages to this endpoint'), { allow: 'POST' })
    if (!principal.hub && !canRead(principal)) {
      return write(res, 401, rpcError(null, -32001, 'unauthorized: send Authorization: Bearer <token>'), { 'www-authenticate': 'Bearer' })
    }
    let raw = ''
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) return write(res, 413, rpcError(null, -32600, 'request too large'))
      raw += chunk
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return write(res, 400, rpcError(null, -32700, 'parse error'))
    }
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map((one) => dispatch(principal, one)))).filter(Boolean)
      return replies.length ? write(res, 200, replies) : write(res, 202)
    }
    const reply = await dispatch(principal, message)
    return reply ? write(res, 200, reply) : write(res, 202)
  }
}
