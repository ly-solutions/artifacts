/**
 * The documents app's own API (`/app/*`): what the site inside harnessly reads and writes by the person's session
 * cookie — the catalog, one document with its source, saving, creating, renaming, deleting, the threads of comments.
 *
 * Everything here acts for the person of the session and asks `docAccess` for each document, so a hub person sees and
 * changes only what the hub allows. Writes come from this server's own pages only (checkSameOrigin).
 */
import { canRead, canWrite } from './auth/index.mjs'
import { CommentError, mayComment, mentionsAgent, personId } from './comments.mjs'
import { ApiError } from './service.mjs'
import { isFullDocument, isValidSlug } from './text.mjs'

const TAB_BOARD = new Set(['board', 'доска', 'доски'])
const MAX_LIST = 50

/** 'text' (a Markdown source: edited by blocks) or 'html' (a page of its own: edited like in Sinopia). */
export function kindOfMeta(meta) {
  const version = meta.versions.at(-1)
  return version && version.markdown && version.html === false ? 'text' : 'html'
}

const personName = (principal) => principal.name || principal.email || 'Гость'

/** Whether `needle` occurs in `source` exactly once: an agent's fragment edit must say which place it means. */
export function replaceOnce(source, needle, replacement) {
  if (typeof needle !== 'string' || !needle.length) throw new ApiError(400, 'invalid', { problems: ['find: the fragment to replace, exactly as it is in the document'] })
  const first = source.indexOf(needle)
  if (first === -1) throw new ApiError(409, 'fragment_not_found', { hint: 'the fragment is not in the current version; read the document again (doc_show) and quote it exactly' })
  if (source.indexOf(needle, first + needle.length) !== -1) throw new ApiError(409, 'fragment_ambiguous', { hint: 'the fragment occurs more than once; quote more words around it' })
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

export function createAppApi({ config, service, comments, docAccess, searchFor, json, readJson, checkSameOrigin, issueViewTicket, ancestorsOrigin }) {
  const BODY = 64 * 1024
  const contentLimit = Math.ceil(config.content.maxBytes * 1.5) + 256 * 1024
  void ancestorsOrigin

  /** The person of the session: a bearer token is not one (the app is a site, it lives on the cookie). */
  function person(principal) {
    if (principal.via === 'bearer' || (!canRead(principal) && !principal.hub)) throw new ApiError(401, 'unauthorized', { hint: 'sign in: the session cookie is missing or expired' })
    return principal
  }

  const rightsOf = (access, principal) => ({
    write: access.write === true,
    comment: mayComment(access, principal),
    share: access.share === true,
  })

  const canCreate = (principal) => !principal.hub && canWrite(principal)

  function listItem(item, principal, access) {
    const entry = service.catalog.entries.get(item.slug)
    let text = (entry?.text ?? '').replace(/\s+/g, ' ').trim()
    // The text of a document usually starts with its own title: the list line shows what follows.
    if (text.toLowerCase().startsWith(item.title.toLowerCase())) text = text.slice(item.title.length).trim()
    const last = item.currentVersion
    return {
      slug: item.slug,
      title: item.title,
      description: item.description,
      tags: item.tags,
      author: item.author,
      updatedAt: item.updatedAt,
      createdAt: item.createdAt,
      updatedBy: last?.author ?? item.author,
      versions: item.versionCount,
      url: item.viewUrl,
      kind: entry ? kindOfMeta(entry.meta) : 'html',
      board: (item.tags ?? []).some((tag) => TAB_BOARD.has(String(tag).toLowerCase())),
      preview: item.description || text.slice(0, 200),
      mine: Boolean(item.author && (item.author === principal.name || (principal.email && item.author === principal.email))),
      canWrite: access ? access.write === true : undefined,
    }
  }

  async function docs(res, url, principal) {
    const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit') ?? MAX_LIST)) || MAX_LIST, 1), MAX_LIST)
    const offset = Math.max(Math.floor(Number(url.searchParams.get('offset') ?? 0)) || 0, 0)
    const result = await searchFor(principal, { q: url.searchParams.get('q') ?? '', tags: [], limit, offset })
    return json(res, 200, { total: result.total, nextOffset: result.nextOffset ?? null, canCreate: canCreate(principal), items: result.items.map((item) => listItem(item, principal)) })
  }

  async function doc(res, url, principal) {
    const slug = url.searchParams.get('slug') ?? ''
    if (!isValidSlug(slug)) return json(res, 404, { error: 'not_found' })
    const access = await docAccess(principal, slug)
    const { meta } = await service.get(slug)
    const artifact = service.present(meta, { versions: true })
    const asked = url.searchParams.get('v')
    const { version, n } = service.resolveVersion(meta, asked)
    const current = n === meta.versions.length
    const content = await service.store.readVersionContent(slug, version)
    const kind = kindOfMeta(meta)
    const theme = ['dark', 'light'].includes(url.searchParams.get('theme')) ? `&theme=${url.searchParams.get('theme')}` : ''
    const rights = rightsOf(access, principal)
    const out = {
      slug,
      title: artifact.title,
      description: artifact.description,
      tags: artifact.tags,
      author: artifact.author,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      url: artifact.viewUrl,
      public: artifact.public,
      kind,
      version: { n, of: meta.versions.length, id: version.id, current },
      versions: artifact.versions.map((v) => ({ n: v.n, id: v.id, createdAt: v.createdAt, author: v.author ?? null, note: v.note ?? null })),
      rights: { ...rights, write: rights.write && current, restore: rights.write && !current, create: canCreate(principal) },
      me: { name: personName(principal) },
      contentUrl: `/a/${slug}/raw?t=${encodeURIComponent(issueViewTicket(slug))}&v=${n}${theme}`,
      wrapped: kind === 'html' && typeof content.html === 'string' && !isFullDocument(content.html),
    }
    if (kind === 'text') out.markdown = content.markdown ?? ''
    // The page's own source is for the one who edits it; everybody else reads the sandboxed frame.
    else if (rights.write) out.html = content.html ?? ''
    return json(res, 200, out)
  }

  /** The cheap poll: has the document or its threads moved since the page last looked? */
  async function state(res, url, principal) {
    const slug = url.searchParams.get('slug') ?? ''
    if (!isValidSlug(slug)) return json(res, 404, { error: 'not_found' })
    await docAccess(principal, slug)
    const { meta } = await service.get(slug)
    const thread = await comments.list(slug)
    return json(res, 200, { version: meta.versions.length, title: meta.title, updatedAt: meta.updatedAt, commentsRev: thread.rev ?? 0, threads: thread.threads.length })
  }

  async function save(req, res, principal) {
    checkSameOrigin(req, principal)
    const body = await readJson(req, contentLimit)
    const slug = body.slug
    if (!isValidSlug(slug)) throw new ApiError(404, 'not_found')
    await docAccess(principal, slug, { need: 'write' })
    const { meta } = await service.get(slug)
    const kind = kindOfMeta(meta)
    const publish = { slug, author: personName(principal), baseVersion: Number.isInteger(body.baseVersion) ? body.baseVersion : undefined, note: typeof body.note === 'string' ? body.note.slice(0, 200).replace(/[\r\n]+/g, ' ') : undefined }
    if (kind === 'text') publish.markdown = String(body.markdown ?? '')
    else publish.html = String(body.html ?? '')
    if (typeof body.title === 'string' && body.title.trim()) publish.title = body.title.trim().slice(0, 200)
    const result = await service.publish(publish, { name: personName(principal), role: 'editor', via: principal.via })
    return json(res, 200, { version: result.version.n, id: result.version.id, updatedAt: result.meta.updatedAt })
  }

  async function create(req, res, principal) {
    checkSameOrigin(req, principal)
    if (!canCreate(principal)) throw new ApiError(403, 'forbidden', { hint: 'documents of a harnessly installation are published through the hub: ask the agent' })
    const body = await readJson(req, contentLimit)
    const title = String(body.title ?? '').trim().slice(0, 200) || 'Новый документ'
    const markdown = typeof body.markdown === 'string' && body.markdown.trim() ? body.markdown : `# ${title}\n\n`
    const result = await service.publish({ title, markdown, new: true, author: personName(principal), tags: Array.isArray(body.tags) ? body.tags : undefined }, { name: personName(principal), role: 'editor', via: principal.via })
    return json(res, 201, { slug: result.meta.slug })
  }

  async function rename(req, res, principal) {
    checkSameOrigin(req, principal)
    const body = await readJson(req, BODY)
    if (!isValidSlug(body.slug)) throw new ApiError(404, 'not_found')
    await docAccess(principal, body.slug, { need: 'write' })
    const title = String(body.title ?? '').trim()
    if (!title || title.length > 200) throw new ApiError(400, 'invalid', { problems: ['title: 1 to 200 characters'] })
    const { meta } = await service.updateMeta(body.slug, { title })
    return json(res, 200, { title: meta.title })
  }

  async function remove(req, res, url, principal) {
    checkSameOrigin(req, principal)
    const slug = url.searchParams.get('slug') ?? ''
    if (!isValidSlug(slug)) throw new ApiError(404, 'not_found')
    await docAccess(principal, slug, { need: 'write' })
    if (principal.hub) throw new ApiError(403, 'forbidden', { hint: 'a document of a harnessly installation is deleted through the hub' })
    await service.remove(slug)
    await comments.remove(slug)
    return json(res, 200, { deleted: true })
  }

  async function restore(req, res, principal) {
    checkSameOrigin(req, principal)
    const body = await readJson(req, BODY)
    if (!isValidSlug(body.slug)) throw new ApiError(404, 'not_found')
    await docAccess(principal, body.slug, { need: 'write' })
    const old = await service.readContent(body.slug, String(body.version))
    const publish = { slug: body.slug, note: `Возврат к версии ${old.n}`, author: personName(principal) }
    if (typeof old.html === 'string' && old.html) publish.html = old.html
    if (typeof old.markdown === 'string' && old.markdown) publish.markdown = old.markdown
    const result = await service.publish(publish, { name: personName(principal), role: 'editor', via: principal.via })
    return json(res, 200, { version: result.version.n })
  }

  // ---- threads ----

  const wrapComment = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof CommentError) throw new ApiError(error.status, error.code, { hint: error.hint })
      throw error
    }
  }

  async function threads(res, url, principal) {
    const slug = url.searchParams.get('slug') ?? ''
    if (!isValidSlug(slug)) throw new ApiError(404, 'not_found')
    await docAccess(principal, slug)
    return json(res, 200, await comments.list(slug))
  }

  async function commentAccess(principal, slug) {
    if (!isValidSlug(slug)) throw new ApiError(404, 'not_found')
    const access = await docAccess(principal, slug)
    if (!rightsOf(access, principal).comment) throw new ApiError(403, 'forbidden', { hint: 'you can read this document but not comment on it' })
    return access
  }

  const asPerson = (principal) => ({ name: personName(principal), kind: 'person', id: personId(principal) ?? undefined })

  const commentRoutes = wrapComment(async (req, res, principal, path) => {
    checkSameOrigin(req, principal)
    const body = await readJson(req, BODY)
    await commentAccess(principal, body.slug)
    if (path === '/app/comments') {
      const { result, rev } = await comments.newThread(body.slug, { anchor: body.anchor, text: body.text, author: asPerson(principal) })
      return json(res, 201, { thread: result, rev, agent: mentionsAgent(body.text) })
    }
    if (path === '/app/comments/reply') {
      const { result, rev } = await comments.reply(body.slug, String(body.thread), { text: body.text, author: asPerson(principal) })
      return json(res, 200, { thread: result.thread, message: result.message, rev, agent: mentionsAgent(body.text) })
    }
    if (path === '/app/comments/status') {
      const { result, rev } = await comments.setStatus(body.slug, String(body.thread), body.status, personName(principal))
      return json(res, 200, { thread: result, rev })
    }
    if (path === '/app/comments/react') {
      const { result, rev } = await comments.react(body.slug, String(body.thread), String(body.message), String(body.emoji), personName(principal))
      return json(res, 200, { message: result, rev })
    }
    if (path === '/app/comments/delete') {
      const mine = (await comments.list(body.slug)).threads.find((t) => t.id === body.thread)
      const me = personId(principal)
      const owner = !!me && mine?.messages[0]?.author?.id === me
      if (!owner) await docAccess(principal, body.slug, { need: 'write' })
      const { rev } = await comments.removeThread(body.slug, String(body.thread))
      return json(res, 200, { rev })
    }
    if (path === '/app/comments/undo') return undoEdit(res, principal, body)
    throw new ApiError(404, 'not_found')
  })

  /** «Отменить» on an agent's edit: the fragment it wrote goes back to what it was, as a new version. */
  async function undoEdit(res, principal, body) {
    await docAccess(principal, body.slug, { need: 'write' })
    const thread = (await comments.list(body.slug)).threads.find((t) => t.id === body.thread)
    const edit = thread?.edits?.find((e) => e.id === body.edit)
    if (!edit) throw new ApiError(404, 'edit_not_found')
    if (edit.undone) throw new ApiError(409, 'already_undone')
    const { meta } = await service.get(body.slug)
    const kind = kindOfMeta(meta)
    const content = await service.readContent(body.slug, null)
    const source = kind === 'text' ? (content.markdown ?? '') : (content.html ?? '')
    let next
    try {
      next = replaceOnce(source, edit.after, edit.before)
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(409, 'changed_since', { hint: 'the fragment has been changed again since; undo it by hand' })
      throw error
    }
    const publish = { slug: body.slug, note: 'Отмена правки агента', author: personName(principal) }
    if (kind === 'text') publish.markdown = next
    else publish.html = next
    const result = await service.publish(publish, { name: personName(principal), role: 'editor', via: principal.via })
    const { rev } = await comments.markUndone(body.slug, body.thread, body.edit)
    return json(res, 200, { version: result.version.n, rev })
  }

  /** Returns true when the request was one of ours. */
  return async function handleApp(req, res, url, principal, path, method) {
    if (!path.startsWith('/app/') || path === '/app/enter') return false
    person(principal)
    if (method === 'GET') {
      if (path === '/app/docs') return (await docs(res, url, principal), true)
      if (path === '/app/doc') return (await doc(res, url, principal), true)
      if (path === '/app/state') return (await state(res, url, principal), true)
      if (path === '/app/comments') return (await threads(res, url, principal), true)
      return false
    }
    if (method === 'PUT' && path === '/app/doc') return (await save(req, res, principal), true)
    if (method === 'POST' && path === '/app/docs') return (await create(req, res, principal), true)
    if (method === 'PATCH' && path === '/app/doc') return (await rename(req, res, principal), true)
    if (method === 'DELETE' && path === '/app/doc') return (await remove(req, res, url, principal), true)
    if (method === 'POST' && path === '/app/restore') return (await restore(req, res, principal), true)
    if (method === 'POST' && path.startsWith('/app/comments')) return (await commentRoutes(req, res, principal, path), true)
    return false
  }
}
