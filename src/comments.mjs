/**
 * Comments on a document: threads anchored to a fragment of the text or to an element of an HTML page.
 *
 * One object per document, `comments/<slug>.json`, replaced with a compare-and-swap on its ETag like a manifest, so two
 * people (or a person and an agent) answering at the same moment both land. The threads belong to the document, not to a
 * version: an anchor keeps the words it was made on (`quote`) so a thread can find its place again after the text moved.
 *
 * Agent edits made in answer to a thread are kept on the thread (`edits`): what was there, what is there now and the
 * versions around it, so the page can highlight the change and offer «Отменить».
 */
import { randomBytes } from 'node:crypto'

import { ConflictError } from './storage/index.mjs'

const SCHEMA = 1
const CAS_ATTEMPTS = 8
export const MAX_TEXT = 4000
const MAX_THREADS = 500
const MAX_MESSAGES = 200
const MAX_QUOTE = 600
const EMOJI = new Set(['👍', '👎', '❤️', '🎉', '👀', '✅'])

export class CommentError extends Error {
  constructor(status, code, hint) {
    super(hint ?? code)
    this.status = status
    this.code = code
    this.hint = hint
  }
}

export const commentsKey = (slug) => `comments/${slug}.json`

const id = (prefix) => `${prefix}_${randomBytes(5).toString('base64url')}`
const now = () => new Date().toISOString()

const clip = (value, max) => String(value ?? '').slice(0, max)

/** An anchor as stored: only the known fields, all bounded. */
export function cleanAnchor(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  if (a.kind === 'element') {
    const path = Array.isArray(a.path) ? a.path.filter((n) => Number.isInteger(n) && n >= 0).slice(0, 64) : []
    return { kind: 'element', path, label: clip(a.label, 80), text: clip(a.text, 160) }
  }
  if (a.kind === 'text') {
    return {
      kind: 'text',
      quote: clip(a.quote, MAX_QUOTE),
      block: Number.isInteger(a.block) && a.block >= 0 ? a.block : null,
    }
  }
  return { kind: 'doc' }
}

export function cleanAuthor(author) {
  const kind = author?.kind === 'agent' ? 'agent' : 'person'
  const entry = { name: clip(author?.name || (kind === 'agent' ? 'Агент' : 'Гость'), 120), kind }
  // A stable id of the person (never shown): who owns a thread is decided by it, not by a name anyone may carry.
  if (kind === 'person' && typeof author?.id === 'string' && author.id) entry.id = clip(author.id, 200)
  return entry
}

/** The stable id of a signed-in person, or null when the caller has none (a static token). */
export const personId = (principal) => (typeof principal?.sub === 'string' && principal.sub ? principal.sub : typeof principal?.email === 'string' && principal.email ? principal.email.toLowerCase() : null)

/** Whether the caller may comment: in the hub by the right the hub gave, otherwise by being able to read. */
export const mayComment = (access, principal) =>
  principal.hub ? access.right === 'comment' || access.right === 'edit' || access.write === true : access.read === true

/** Whether a text calls the agent: «@агент», «@agent», «@harnessly». */
export const mentionsAgent = (text) => /(^|[\s(,.;:!?])@(агент|agent|harnessly)(?![\p{L}\p{N}_])/iu.test(String(text ?? ''))

export class CommentStore {
  constructor(storage) {
    this.storage = storage
  }

  async read(slug) {
    const found = await this.storage.get(commentsKey(slug))
    if (!found) return { doc: { schema: SCHEMA, rev: 0, threads: [] }, etag: null }
    const doc = JSON.parse(found.body.toString('utf8'))
    if (!Array.isArray(doc.threads)) doc.threads = []
    return { doc, etag: found.etag }
  }

  async list(slug) {
    const { doc } = await this.read(slug)
    return doc
  }

  async remove(slug) {
    await this.storage.delete(commentsKey(slug))
  }

  /** `change(doc)` edits a copy and returns the value to answer with; it throws a CommentError to refuse. */
  async mutate(slug, change) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const { doc, etag } = await this.read(slug)
      const next = structuredClone(doc)
      const result = change(next)
      next.rev = (doc.rev ?? 0) + 1
      const options = { contentType: 'application/json' }
      if (etag === null) options.ifNoneMatch = '*'
      else options.ifMatch = etag
      try {
        await this.storage.put(commentsKey(slug), Buffer.from(JSON.stringify(next)), options)
        return { result, rev: next.rev }
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
      }
    }
    throw new CommentError(503, 'busy', 'too many concurrent changes of the comments; retry')
  }

  newThread(slug, { anchor, text, author }) {
    const body = clip(text, MAX_TEXT).trim()
    if (!body) throw new CommentError(400, 'invalid', 'text: the comment')
    return this.mutate(slug, (doc) => {
      if (doc.threads.length >= MAX_THREADS) throw new CommentError(409, 'too_many_threads', 'this document has too many threads; resolve or remove some')
      const at = now()
      const thread = {
        id: id('t'),
        anchor: cleanAnchor(anchor),
        status: 'open',
        createdAt: at,
        messages: [{ id: id('m'), author: cleanAuthor(author), text: body, at, reactions: {} }],
        edits: [],
      }
      doc.threads.push(thread)
      return thread
    })
  }

  reply(slug, threadId, { text, author, edit }) {
    const body = clip(text, MAX_TEXT).trim()
    if (!body) throw new CommentError(400, 'invalid', 'text: the answer')
    return this.mutate(slug, (doc) => {
      const thread = doc.threads.find((t) => t.id === threadId)
      if (!thread) throw new CommentError(404, 'thread_not_found')
      if (thread.messages.length >= MAX_MESSAGES) throw new CommentError(409, 'thread_full', 'this thread is too long; start a new one')
      const message = { id: id('m'), author: cleanAuthor(author), text: body, at: now(), reactions: {} }
      thread.messages.push(message)
      if (edit) {
        const entry = { id: id('e'), at: message.at, message: message.id, from: edit.from, to: edit.to, before: clip(edit.before, 20000), after: clip(edit.after, 20000), undone: false }
        thread.edits = [...(thread.edits ?? []), entry]
        message.edit = entry.id
      }
      // An answer reopens a thread somebody had closed.
      if (thread.status === 'resolved') thread.status = 'open'
      return { thread, message }
    })
  }

  setStatus(slug, threadId, status, by) {
    if (status !== 'open' && status !== 'resolved') throw new CommentError(400, 'invalid', 'status: open or resolved')
    return this.mutate(slug, (doc) => {
      const thread = doc.threads.find((t) => t.id === threadId)
      if (!thread) throw new CommentError(404, 'thread_not_found')
      thread.status = status
      thread.statusBy = clip(by, 120)
      return thread
    })
  }

  react(slug, threadId, messageId, emoji, who) {
    if (!EMOJI.has(emoji)) throw new CommentError(400, 'invalid', `emoji: one of ${[...EMOJI].join(' ')}`)
    return this.mutate(slug, (doc) => {
      const thread = doc.threads.find((t) => t.id === threadId)
      const message = thread?.messages.find((m) => m.id === messageId)
      if (!message) throw new CommentError(404, 'message_not_found')
      const name = clip(who, 120)
      const list = new Set(message.reactions?.[emoji] ?? [])
      if (list.has(name)) list.delete(name)
      else list.add(name)
      message.reactions = { ...message.reactions, [emoji]: [...list] }
      if (!message.reactions[emoji].length) delete message.reactions[emoji]
      return message
    })
  }

  removeThread(slug, threadId) {
    return this.mutate(slug, (doc) => {
      const at = doc.threads.findIndex((t) => t.id === threadId)
      if (at === -1) throw new CommentError(404, 'thread_not_found')
      doc.threads.splice(at, 1)
      return true
    })
  }

  markUndone(slug, threadId, editId) {
    return this.mutate(slug, (doc) => {
      const edit = doc.threads.find((t) => t.id === threadId)?.edits?.find((e) => e.id === editId)
      if (!edit) throw new CommentError(404, 'edit_not_found')
      edit.undone = true
      return edit
    })
  }
}
