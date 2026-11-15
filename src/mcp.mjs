/**
 * MCP endpoint (Streamable HTTP, JSON responses, no server-sent stream) at /mcp.
 *
 * Tools read the catalog as the caller sees it: with a harnessly app token only the documents
 * the hub allows that person. There is no publishing tool on purpose: agents publish through
 * the hub (`doc.publish`), which owns the rights. See docs/mcp.md.
 */
import { readFileSync } from 'node:fs'

import { kindOfMeta, replaceOnce } from './app-api.mjs'
import { canRead } from './auth/index.mjs'
import { sendCommentEvent } from './hub-events.mjs'
import { CommentError, MAX_TEXT, mayComment } from './comments.mjs'
import { HubRightsError } from './auth/harnessly.mjs'
import { parseDuration } from './config.mjs'
import { ApiError } from './service.mjs'
import { htmlToText, isValidSlug, normalizeTags } from './text.mjs'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024
const MAX_BATCH = 20
const MAX_CONTENT_CHARS = 200_000
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const INSTRUCTIONS =
  'A catalog of versioned documents. doc_find searches the documents you may read, doc_show reads one, ' +
  'doc_versions lists its versions, doc_share opens or closes a share link. ' +
  'Comments: doc_comments reads the threads of a document, doc_reply answers one, doc_comment starts one, doc_edit changes a fragment of the text. ' +
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
    name: 'doc_signin',
    title: 'Sign the app view in',
    description: 'For the app view only, not for an agent: a one-time pass (a minute) that signs the person of the token in to the documents site inside the view, so the view reads its catalog and opens documents by itself.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_open',
    title: 'Open a document in the app view',
    description: 'The address of a document\'s content for the harnessly app view, good for a few minutes. Needs the right to read the document; only where the app view is on.',
    inputSchema: {
      type: 'object',
      properties: { slug: slugProp, theme: { type: 'string', enum: ['light', 'dark'] } },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_comments',
    title: 'Comments of a document',
    description: 'The threads of comments on a document: where each is anchored (the quoted words, or the page element), who said what and whether it is open. A person who writes @агент in a thread is asking you; answer with doc_reply, and change the text with doc_edit when they ask for a change.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: slugProp,
        thread: { type: 'string', description: 'Only this thread (its id from an earlier answer).' },
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'open (default), resolved or all.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_reply',
    title: 'Answer a thread',
    description: 'Answer a thread of comments as the agent; it shows in the thread under «Агент». With resolve: true the thread is closed after the answer. Needs the right to comment.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: slugProp,
        thread: { type: 'string', description: 'The thread id from doc_comments.' },
        text: { type: 'string', description: `The answer, up to ${MAX_TEXT} characters; short, in the thread's language.` },
        resolve: { type: 'boolean', description: 'Close the thread after the answer.' },
      },
      required: ['slug', 'thread', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'doc_comment',
    title: 'Comment on a fragment',
    description: 'Start a thread as the agent on a fragment of the text (quote: the exact words) or on the whole document. Needs the right to comment.',
    inputSchema: {
      type: 'object',
      properties: { slug: slugProp, text: { type: 'string' }, quote: { type: 'string', description: 'The exact words of the fragment the comment is about; omit for the whole document.' } },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'doc_edit',
    title: 'Change a fragment of a document',
    description:
      'Replace one fragment of the current version with other text: a new version of the same document, the change is highlighted for the person and they can undo it. `find` must occur exactly once in the source (Markdown, or the HTML of a page), so quote enough words. With thread, the change and your reply are recorded in that thread. `note` is the one short line the person reads next to the change in the document chat (what you changed and why); one turn of several doc_edit calls is shown to them as one change they can undo at once. For an HTML page look at it before and after the change (the result gives the address to open in your browser and take a picture of) and undo your own change if the page broke. Needs the right to edit. For a whole new text publish through the hub instead.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: slugProp,
        find: { type: 'string', description: 'The exact fragment to replace, as doc_show gives it.' },
        replace: { type: 'string', description: 'What stands there instead (may be empty to delete).' },
        thread: { type: 'string', description: 'The thread this change answers.' },
        reply: { type: 'string', description: 'What to say in the thread about the change (required with thread).' },
        note: { type: 'string', description: 'A line for the version history.' },
      },
      required: ['slug', 'find', 'replace'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'quick_read',
    title: 'Read a document for a quick edit',
    description: 'The document as text for a fast voice edit: its title, its source as stored (Markdown, or the HTML of a page) and the current version. Needs the right to edit.',
    inputSchema: {
      type: 'object',
      properties: { object: slugProp, selection: { type: 'string', description: 'What the person has selected, if anything (not needed to read).' } },
      required: ['object'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'quick_apply',
    title: 'Apply exact replacements',
    description:
      'Replace exact fragments of the current source in one new version. `version` is the one quick_read gave: another current version is a `conflict`; every `old` must occur exactly once (`not_unique`); an edit that removes a whole line needs confirmed: true (`needs_yes`). Errors are JSON {code, message}. Needs the right to edit.',
    inputSchema: {
      type: 'object',
      properties: {
        object: slugProp,
        version: { type: 'string', description: 'The version the edits were made against.' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'], additionalProperties: false } },
        confirmed: { type: 'boolean', description: 'The person agreed to removing lines.' },
      },
      required: ['object', 'version', 'edits'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'quick_undo',
    title: 'Undo a quick edit',
    description: 'When the current version is `version` (the one quick_apply returned), publish the previous content as a new version. Another current version is a `conflict`; the first version has `nothing_to_undo`. Needs the right to edit.',
    inputSchema: {
      type: 'object',
      properties: { object: slugProp, version: { type: 'string' } },
      required: ['object', 'version'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
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
/** A failure of a quick_* tool: the host reads `code` from the JSON text of the result. */
class QuickError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sameLines = (text) => text.split('\n').length
/** The line(s) of `text` around the span [from, to), as written. */
function linesAround(text, from, to) {
  const start = text.lastIndexOf('\n', from - 1) + 1
  const end = text.indexOf('\n', to)
  return text.slice(start, end === -1 ? text.length : end)
}
/** Whether the span [from, to) of `source` is made of whole lines. */
const wholeLines = (source, from, to) => (from === 0 || source[from - 1] === '\n') && (to === source.length || source[to] === '\n' || source[to - 1] === '\n')

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export function createMcpHandler({ config, service, comments, searchFor, docAccess, viewTicket, enterPass }) {
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

  /** Read access is not enough to speak in a document: the hub's comment or edit right is. */
  async function commentAccess(principal, slug) {
    const access = await docAccess(principal, slug)
    if (!mayComment(access, principal)) throw new ToolError('you can read this document but not comment on it')
    return access
  }

  const quickSource = (content, kind) => (kind === 'text' ? (content.markdown ?? '') : (content.html ?? ''))

  /** The document of a quick_* call, for someone who may edit it: its current content and kind. */
  async function quickDoc(principal, args) {
    if (!isValidSlug(args.object)) throw new QuickError('invalid', 'нужен адрес документа')
    const slug = args.object
    try {
      await docAccess(principal, slug, { need: 'write' })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'forbidden') throw new QuickError('forbidden', 'нет права править документ')
      if (error instanceof ApiError && error.code === 'not_found') throw new QuickError('not_found', 'документ не найден')
      throw error
    }
    const { meta } = await service.get(slug)
    const content = await service.readContent(slug, null)
    return { slug, content, kind: kindOfMeta(meta) }
  }

  async function quickPublish(principal, slug, kind, text, baseVersion, note) {
    const name = principal.name || principal.email || 'Голос'
    const publish = { slug, author: name, baseVersion, note }
    if (kind === 'text') publish.markdown = text
    else publish.html = text
    try {
      return await service.publish(publish, { name, role: 'editor', via: 'bearer' })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') throw new QuickError('conflict', 'документ уже изменился')
      throw error
    }
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
        mine: Boolean(item.author && (item.author === principal.name || (principal.email && item.author === principal.email))),
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

    async doc_open(principal, args) {
      if (!config.appView?.enabled || !viewTicket) throw new ToolError('the app view is off on this server')
      const slug = slugOf(args)
      await docAccess(principal, slug)
      const { meta } = await service.get(slug)
      const artifact = service.present(meta)
      const theme = args.theme === 'dark' || args.theme === 'light' ? `&theme=${args.theme}` : ''
      return {
        slug,
        title: artifact.title,
        url: artifact.viewUrl,
        contentUrl: `/a/${slug}/raw?t=${encodeURIComponent(viewTicket(slug))}${theme}`,
      }
    },

    async doc_signin(principal) {
      if (!config.appView?.enabled || !enterPass) throw new ToolError('the app view is off on this server')
      if (!principal.hub || !principal.sub) throw new ToolError('sign-in needs a harnessly app token: it names the person')
      return { pass: enterPass(principal) }
    },

    async doc_versions(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug)
      const { meta } = await service.get(slug)
      return { slug, versions: service.versionsOf(meta) }
    },

    async doc_comments(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug)
      const doc = await comments.list(slug)
      const status = args.status ?? 'open'
      const threads = doc.threads
        .filter((t) => (typeof args.thread === 'string' ? t.id === args.thread : status === 'all' || t.status === status))
        .map((t) => ({
          id: t.id,
          status: t.status,
          anchor: t.anchor,
          messages: t.messages.map((m) => ({ id: m.id, author: m.author.name, by: m.author.kind, at: m.at, text: m.text })),
        }))
      return { slug, threads }
    },

    async doc_reply(principal, args) {
      const slug = slugOf(args)
      await commentAccess(principal, slug)
      const { result } = await comments.reply(slug, String(args.thread ?? ''), { text: args.text, author: { name: 'Агент', kind: 'agent' } })
      sendCommentEvent(service, { event: 'thread.replied', slug, thread: result.thread, message: result.message, principal: null })
      if (args.resolve === true) await comments.setStatus(slug, result.thread.id, 'resolved', 'Агент')
      return { slug, thread: result.thread.id, message: result.message.id, resolved: args.resolve === true }
    },

    async doc_comment(principal, args) {
      const slug = slugOf(args)
      await commentAccess(principal, slug)
      const quote = typeof args.quote === 'string' ? args.quote : ''
      const { result } = await comments.newThread(slug, { anchor: quote ? { kind: 'text', quote } : { kind: 'doc' }, text: args.text, author: { name: 'Агент', kind: 'agent' } })
      sendCommentEvent(service, { event: 'thread.created', slug, thread: result, message: result.messages[0], principal: null })
      return { slug, thread: result.id }
    },

    async doc_edit(principal, args) {
      const slug = slugOf(args)
      await docAccess(principal, slug, { need: 'write' })
      if (typeof args.replace !== 'string') throw new ToolError('replace: the new text of the fragment (may be empty)')
      if (typeof args.thread === 'string' && !(typeof args.reply === 'string' && args.reply.trim())) throw new ToolError('reply: say in the thread what you changed')
      const { meta } = await service.get(slug)
      const kind = kindOfMeta(meta)
      const content = await service.readContent(slug, null)
      const source = kind === 'text' ? (content.markdown ?? '') : (content.html ?? '')
      const next = replaceOnce(source, args.find, args.replace)
      const publish = { slug, author: 'Агент', baseVersion: content.n, note: typeof args.note === 'string' ? args.note.slice(0, 200).replace(/[\r\n]+/g, ' ') : 'Правка агента' }
      if (kind === 'text') publish.markdown = next
      else {
        publish.html = next
        // A page with no <title> or heading of its own keeps the title it has.
        publish.title = meta.title
      }
      const result = await service.publish(publish, { name: 'Агент', role: 'editor', via: 'bearer' })
      let edit = null
      if (typeof args.thread === 'string') {
        const { result: made } = await comments.reply(slug, args.thread, { text: args.reply, author: { name: 'Агент', kind: 'agent' }, edit: { from: content.n, to: result.version.n, before: args.find, after: args.replace } })
        edit = made.message.edit ?? null
        sendCommentEvent(service, { event: 'thread.replied', slug, thread: made.thread, message: made.message, principal: null })
      }
      const out = { slug, version: result.version.n, edit }
      if (kind === 'html') {
        // The service draws no pictures: the agent looks at the page itself, before and after, in the browser it has.
        out.look = { url: service.present(meta).viewUrl, how: 'Open this address in your browser, take a picture of the page and compare it with the one from before the change; if the page broke, put the old fragment back with doc_edit.' }
      }
      return out
    },

    async quick_read(principal, args) {
      const { content, kind } = await quickDoc(principal, args)
      const artifact = service.present(content.meta)
      return { kind: 'document', title: artifact.title, text: quickSource(content, kind), version: String(content.n) }
    },

    async quick_apply(principal, args) {
      const { slug, content, kind } = await quickDoc(principal, args)
      if (String(args.version) !== String(content.n)) throw new QuickError('conflict', 'документ уже изменился')
      if (!Array.isArray(args.edits) || !args.edits.length || args.edits.some((e) => !e || typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old.length)) {
        throw new QuickError('invalid', 'нужны правки: old и new')
      }
      const source = quickSource(content, kind)
      const spans = args.edits.map((edit) => {
        const from = source.indexOf(edit.old)
        if (from === -1 || source.indexOf(edit.old, from + edit.old.length) !== -1) throw new QuickError('not_unique', 'фрагмент не найден или встречается не один раз')
        return { from, to: from + edit.old.length, old: edit.old, next: edit.new }
      })
      spans.sort((a, b) => a.from - b.from)
      for (let i = 1; i < spans.length; i += 1) if (spans[i].from < spans[i - 1].to) throw new QuickError('not_unique', 'правки пересекаются')
      const removes = spans.some((s) => sameLines(s.next) < sameLines(s.old) || (s.next === '' && wholeLines(source, s.from, s.to)))
      if (removes && args.confirmed !== true) throw new QuickError('needs_yes', 'правка удаляет строки: нужно подтверждение')
      let text = ''
      let at = 0
      for (const s of spans) {
        text += source.slice(at, s.from)
        s.start = text.length
        text += s.next
        s.end = text.length
        at = s.to
      }
      text += source.slice(at)
      if (text === source) return { changed: false, version: String(content.n), hint: '' }
      const hint = [...new Set(spans.map((s) => linesAround(text, s.start, s.end).trim()).filter(Boolean))].join('\n').slice(0, 400)
      const result = await quickPublish(principal, slug, kind, text, content.n, 'Голосовая правка')
      return { changed: true, version: String(result.version.n), hint }
    },

    async quick_undo(principal, args) {
      const { slug, content, kind } = await quickDoc(principal, args)
      if (String(args.version) !== String(content.n)) throw new QuickError('conflict', 'документ уже изменился')
      if (content.n <= 1) throw new QuickError('nothing_to_undo', 'отменять нечего')
      const before = await service.readContent(slug, String(content.n - 1))
      const result = await quickPublish(principal, slug, kind, quickSource(before, kind), content.n, 'Отмена голосовой правки')
      return { changed: true, version: String(result.version.n) }
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
      if (String(params?.name).startsWith('quick_')) {
        const code = error instanceof QuickError ? error.code : error instanceof ApiError ? error.code : error instanceof HubRightsError ? 'unavailable' : null
        if (!code) throw error
        const message = error instanceof QuickError ? error.message : error instanceof HubRightsError ? 'права пока не получены, повторите' : 'не получилось сохранить'
        return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true }
      }
      let message
      if (error instanceof ToolError) message = error.message
      else if (error instanceof HubRightsError) message = 'the hub did not answer who may read this document; try again in a minute'
      else if (error instanceof CommentError) message = error.hint ?? error.code
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
    // Bearer tokens only: a browser session cookie would let another page act through a signed-in person.
    if (principal.via !== 'bearer' && principal.via !== 'none') {
      return write(res, 401, rpcError(null, -32001, 'unauthorized: send Authorization: Bearer <token>'), { 'www-authenticate': 'Bearer' })
    }
    if (!principal.hub && !canRead(principal)) {
      return write(res, 401, rpcError(null, -32001, 'unauthorized: send Authorization: Bearer <token>'), { 'www-authenticate': 'Bearer' })
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return write(res, 415, rpcError(null, -32600, 'send Content-Type: application/json'))
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
      if (message.length > MAX_BATCH) return write(res, 400, rpcError(null, -32600, `at most ${MAX_BATCH} messages in a batch`))
      const replies = []
      for (const one of message) {
        const reply = await dispatch(principal, one)
        if (reply) replies.push(reply)
      }
      return replies.length ? write(res, 200, replies) : write(res, 202)
    }
    const reply = await dispatch(principal, message)
    return reply ? write(res, 200, reply) : write(res, 202)
  }
}
