/**
 * The catalog's operations: publish, versions, metadata, sharing, search.
 * HTTP-agnostic; the server and the tests call it directly.
 */
import { createHash, createHmac } from 'node:crypto'

import { Catalog, contentText } from './catalog.mjs'
import { Signer, safeEqual } from './signing.mjs'
import { ConflictError } from './storage/index.mjs'
import { ArtifactStore, SCHEMA, newVersionId } from './store.mjs'
import { isValidSlug, makeSlug, normalizeTags, titleFromHtml, titleFromMarkdown } from './text.mjs'

export class ApiError extends Error {
  constructor(status, code, { problems, hint, extra } = {}) {
    super(hint ?? problems?.join('; ') ?? code)
    this.status = status
    this.code = code
    this.problems = problems
    this.hint = hint
    this.extra = extra
  }

  toJSON() {
    return { error: this.code, ...(this.hint ? { hint: this.hint } : {}), ...(this.problems ? { problems: this.problems } : {}), ...this.extra }
  }
}

const NOTE_MAX = 200
const TITLE_MAX = 200
const DESCRIPTION_MAX = 1000
const CAS_ATTEMPTS = 8
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/

const stamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
const isUrl = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
const fill = (template, name, value) => (template && value ? template.replaceAll(`{${name}}`, encodeURIComponent(value)) : null)

export class ArtifactService {
  constructor({ storage, config, log = () => {}, fetchImpl = fetch }) {
    this.config = config
    this.storage = storage
    this.store = new ArtifactStore(storage)
    this.catalog = new Catalog({ store: this.store, refreshSeconds: config.index.refreshSeconds, log })
    this.log = log
    this.fetch = fetchImpl
    this.taskRe = new RegExp(config.links.taskPattern)
  }

  async init() {
    this.signer = new Signer(await this.store.signingSecret(this.config.auth.secret))
    await this.catalog.refresh()
    return this
  }

  // ---- links -----------------------------------------------------------------

  viewUrl(slug) {
    return `${this.config.publicUrl}/a/${slug}`
  }

  embedUrl(slug) {
    return `${this.config.publicUrl}/embed/${slug}`
  }

  shareUrl(token) {
    return `${this.config.publicUrl}/s/${token}`
  }

  /** What clients see: the manifest without share internals, plus resolved links. */
  present(meta, { versions = false } = {}) {
    const current = meta.versions.at(-1)
    const out = {
      slug: meta.slug,
      title: meta.title,
      description: meta.description ?? '',
      author: meta.author ?? null,
      tags: meta.tags ?? [],
      task: meta.task ?? null,
      taskUrl: fill(this.config.links.taskUrl, 'task', meta.task),
      link: meta.link ?? null,
      session: meta.session ?? null,
      sessionUrl: fill(this.config.links.sessionUrl, 'session', meta.session),
      public: meta.public === true,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      versionCount: meta.versions.length,
      currentVersion: current ? presentVersion(current, meta.versions.length) : null,
      viewUrl: this.viewUrl(meta.slug),
      embedUrl: this.embedUrl(meta.slug),
    }
    if (versions) out.versions = this.versionsOf(meta)
    return out
  }

  versionsOf(meta) {
    const total = meta.versions.length
    return meta.versions.map((version, index) => ({ ...presentVersion(version, index + 1), current: index === total - 1 })).reverse()
  }

  // ---- reads -----------------------------------------------------------------

  async get(slug) {
    const found = await this.store.getManifest(slug)
    if (!found) throw new ApiError(404, 'not_found', { hint: `no artifact "${slug}"` })
    return found
  }

  /** `ref`: version number, version id (or an unambiguous prefix of at least 7 characters), or empty for the latest. */
  resolveVersion(meta, ref) {
    if (ref === undefined || ref === null || ref === '' || ref === 'latest') {
      const version = meta.versions.at(-1)
      if (!version) throw new ApiError(404, 'not_found', { hint: 'artifact has no versions' })
      return { version, n: meta.versions.length }
    }
    const text = String(ref)
    if (/^\d{1,6}$/.test(text)) {
      const n = Number(text)
      if (n >= 1 && n <= meta.versions.length) return { version: meta.versions[n - 1], n }
      throw new ApiError(404, 'version_not_found', { hint: `version ${n} does not exist (1..${meta.versions.length})` })
    }
    const matches = meta.versions
      .map((version, index) => ({ version, n: index + 1 }))
      .filter(({ version }) => version.id === text || (text.length >= 7 && version.id.startsWith(text)))
    if (matches.length === 1) return matches[0]
    throw new ApiError(404, 'version_not_found', { hint: `no single version matches "${text}"` })
  }

  async readContent(slug, ref) {
    const { meta } = await this.get(slug)
    const { version, n } = this.resolveVersion(meta, ref)
    const content = await this.store.readVersionContent(slug, version)
    return { meta, version, n, ...content }
  }

  async search(query) {
    await this.catalog.ensureFresh()
    const result = this.catalog.search(query)
    return {
      total: result.total,
      items: result.items.map(({ meta, score, snippet }) => ({ ...this.present(meta), ...(snippet ? { snippet } : {}), ...(query.q ? { score } : {}) })),
    }
  }

  async tags() {
    await this.catalog.ensureFresh()
    return this.catalog.tagCounts()
  }

  // ---- writes ----------------------------------------------------------------

  validateLinks(body, problems) {
    if (body.task !== undefined && body.task !== null && (typeof body.task !== 'string' || !this.taskRe.test(body.task))) {
      problems.push(`task: must match ${this.config.links.taskPattern}, or null to clear`)
    }
    if (body.link !== undefined && body.link !== null && (typeof body.link !== 'string' || body.link.length > 2048 || !isUrl(body.link))) {
      problems.push('link: an http(s) URL, or null to clear')
    }
    if (body.session !== undefined && body.session !== null && (typeof body.session !== 'string' || !SESSION_RE.test(body.session))) {
      problems.push('session: a conversation or session id (letters, digits, . _ : @ / + -, up to 200 characters), or null to clear')
    }
    if (body.description !== undefined && body.description !== null && (typeof body.description !== 'string' || body.description.length > DESCRIPTION_MAX)) {
      problems.push(`description: a string up to ${DESCRIPTION_MAX} characters`)
    }
    for (const field of ['tags', 'addTags', 'removeTags']) {
      if (body[field] !== undefined && body[field] !== null && !Array.isArray(body[field]) && typeof body[field] !== 'string') {
        problems.push(`${field}: a list of strings or a comma-separated string`)
      }
    }
  }

  validatePublish(body) {
    const problems = []
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be a JSON object']
    const hasHtml = typeof body.html === 'string' && body.html.trim().length > 0
    const hasMarkdown = typeof body.markdown === 'string' && body.markdown.trim().length > 0
    if (!hasHtml && !hasMarkdown) problems.push('html or markdown: the document itself (at least one of them)')
    if (body.html !== undefined && body.html !== null && typeof body.html !== 'string') problems.push('html: a string')
    if (body.markdown !== undefined && body.markdown !== null && typeof body.markdown !== 'string') problems.push('markdown: a string')
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length < 1 || body.title.length > TITLE_MAX)) {
      problems.push(`title: 1 to ${TITLE_MAX} characters`)
    }
    if (body.slug !== undefined && body.slug !== null && !isValidSlug(body.slug)) problems.push('slug: lowercase latin letters, digits and dashes, 2 to 80 characters')
    if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX || /[\r\n]/.test(body.note))) {
      problems.push(`note: what changed in this version, one line up to ${NOTE_MAX} characters`)
    }
    if (body.author !== undefined && body.author !== null && (typeof body.author !== 'string' || body.author.length > 120)) problems.push('author: a string up to 120 characters')
    if (body.baseVersion !== undefined && body.baseVersion !== null && !Number.isInteger(body.baseVersion)) problems.push('baseVersion: the version number your edit is based on')
    if (body.public !== undefined) problems.push('public: publishing never changes access; use PATCH /api/v1/artifacts/{slug} or the share endpoints')
    this.validateLinks(body, problems)
    const bytes = Buffer.byteLength(body.html ?? '') + Buffer.byteLength(body.markdown ?? '')
    if (bytes > this.config.content.maxBytes) problems.push(`document is ${bytes} bytes, the limit is ${this.config.content.maxBytes} (ARTIFACTS_MAX_DOCUMENT_BYTES)`)
    return problems
  }

  /**
   * Publish a new artifact, or a new version of an existing one when `slug` is given.
   *
   * Content is written first under a fresh version id (immutable), then the
   * manifest is replaced with a compare-and-swap on its ETag. A concurrent
   * publisher makes the swap fail; we re-read and append again, so two agents
   * updating the same slug at once both get their version, numbered in order.
   */
  async publish(body, principal = {}) {
    const problems = this.validatePublish(body)
    if (problems.length) throw new ApiError(problems.some((p) => p.startsWith('document is')) ? 413 : 400, 'invalid', { problems })

    const html = typeof body.html === 'string' && body.html.trim() ? body.html : undefined
    const markdown = typeof body.markdown === 'string' && body.markdown.trim() ? body.markdown : undefined
    const title = (body.title ?? titleFromMarkdown(markdown) ?? titleFromHtml(html) ?? '').trim()
    if (!title) throw new ApiError(400, 'invalid', { problems: ['title: required (or put a <title>, <h1> or "# Heading" in the document)'] })

    let slug = body.slug ?? null
    if (!slug && body.new !== true) {
      await this.catalog.ensureFresh()
      const duplicates = this.catalog.duplicates(title, body.task)
      if (duplicates.length) {
        throw new ApiError(409, 'duplicate', {
          hint: 'an artifact with this title (or the same task and a close title) exists: publish a new version with its slug, or pass "new": true if this really is a different document',
          extra: { candidates: duplicates.map((meta) => ({ slug: meta.slug, title: meta.title, task: meta.task ?? null, viewUrl: this.viewUrl(meta.slug) })) },
        })
      }
    }
    if (!slug) slug = makeSlug(title)

    const versionId = newVersionId()
    await this.store.putVersionContent(slug, versionId, { html, markdown })
    const author = body.author ?? principal.name ?? null
    const version = {
      id: versionId,
      createdAt: stamp(),
      author,
      note: body.note?.trim() || null,
      html: Boolean(html),
      markdown: Boolean(markdown),
      bytes: Buffer.byteLength(html ?? '') + Buffer.byteLength(markdown ?? ''),
      sha256: createHash('sha256').update(html ?? '').update('\0').update(markdown ?? '').digest('hex'),
    }

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const found = await this.store.getManifest(slug)
      const existing = found?.meta
      if (existing && Number.isInteger(body.baseVersion) && body.baseVersion !== existing.versions.length) {
        throw new ApiError(409, 'version_conflict', {
          hint: `your edit is based on version ${body.baseVersion}, the artifact is at version ${existing.versions.length}; read it again and merge`,
          extra: { currentVersion: existing.versions.length },
        })
      }
      // What the publisher did not send stays as it was: updating the text must not drop the task or tags.
      const kept = (field) => (body[field] === undefined ? (existing?.[field] ?? null) : body[field])
      const now = stamp()
      const meta = {
        schema: SCHEMA,
        slug,
        title,
        description: kept('description') ?? '',
        author: existing?.author ?? author,
        tags: normalizeTags(kept('tags') ?? []),
        task: kept('task'),
        link: kept('link'),
        session: kept('session'),
        public: existing?.public === true,
        share: existing?.share ?? { gen: 1 },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        versions: [...(existing?.versions ?? []), version],
      }
      try {
        const { etag } = await this.store.putManifest(meta, found ? found.etag : null)
        this.catalog.put(meta, etag, contentText({ html, markdown }))
        const n = meta.versions.length
        this.notify(existing ? 'artifact.updated' : 'artifact.published', meta)
        return { created: !existing, meta, version: presentVersion(version, n) }
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
      }
    }
    throw new ApiError(503, 'busy', { hint: 'too many concurrent updates of this artifact; retry' })
  }

  /** Apply `mutate(meta)` with a compare-and-swap loop; `mutate` returns false to skip writing. */
  async mutate(slug, mutate) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const { meta, etag } = await this.get(slug)
      const next = structuredClone(meta)
      if ((await mutate(next)) === false) return meta
      next.updatedAt = stamp()
      try {
        const written = await this.store.putManifest(next, etag)
        this.catalog.put(next, written.etag)
        return next
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
      }
    }
    throw new ApiError(503, 'busy', { hint: 'too many concurrent updates of this artifact; retry' })
  }

  validateMetaPatch(body) {
    const problems = []
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be a JSON object']
    const fields = ['title', 'description', 'tags', 'addTags', 'removeTags', 'task', 'link', 'session', 'public']
    const unknown = Object.keys(body).filter((key) => !fields.includes(key))
    if (unknown.length) problems.push(`unknown fields: ${unknown.join(', ')} (allowed: ${fields.join(', ')})`)
    if (!fields.some((field) => body[field] !== undefined)) problems.push(`nothing to change: send any of ${fields.join(', ')}`)
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > TITLE_MAX)) problems.push(`title: 1 to ${TITLE_MAX} characters`)
    if (body.public !== undefined && typeof body.public !== 'boolean') problems.push('public: true opens the share link, false closes it and revokes every link issued before')
    this.validateLinks(body, problems)
    return problems
  }

  /** Metadata only: no new version. `public: false` revokes every share link issued so far. */
  async updateMeta(slug, body) {
    const problems = this.validateMetaPatch(body)
    if (problems.length) throw new ApiError(400, 'invalid', { problems })
    let shareToken = null
    const meta = await this.mutate(slug, (next) => {
      if (body.title !== undefined) next.title = body.title.trim()
      if (body.description !== undefined) next.description = body.description ?? ''
      for (const field of ['task', 'link', 'session']) if (body[field] !== undefined) next[field] = body[field]
      let tags = body.tags !== undefined ? normalizeTags(body.tags ?? []) : normalizeTags(next.tags ?? [])
      if (body.addTags) tags = normalizeTags([...tags, ...normalizeTags(body.addTags)])
      if (body.removeTags) {
        const drop = new Set(normalizeTags(body.removeTags).map((tag) => tag.toLowerCase()))
        tags = tags.filter((tag) => !drop.has(tag.toLowerCase()))
      }
      next.tags = tags
      if (body.public === true) next.public = true
      if (body.public === false) revoke(next)
    })
    if (meta.public) shareToken = this.issueShareToken(meta)
    this.notify('artifact.meta', meta)
    return { meta, shareToken }
  }

  // ---- sharing ---------------------------------------------------------------

  issueShareToken(meta, ttlSeconds = this.config.share.defaultTtl) {
    const payload = { s: meta.slug, g: meta.share?.gen ?? 1 }
    if (ttlSeconds) payload.e = Math.floor(Date.now() / 1000) + ttlSeconds
    return this.signer.sign('share', payload)
  }

  /** Opens read-only access by link. `rotate` revokes earlier links first. */
  async share(slug, { ttlSeconds, rotate = false } = {}) {
    const meta = await this.mutate(slug, (next) => {
      if (next.public === true && !rotate) return false
      if (rotate) revoke(next)
      next.public = true
    })
    const ttl = ttlSeconds ?? this.config.share.defaultTtl
    const token = this.issueShareToken(meta, ttl)
    this.notify('artifact.shared', meta)
    return { meta, token, url: this.shareUrl(token), expiresAt: ttl ? new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString() : null }
  }

  async unshare(slug) {
    const meta = await this.mutate(slug, (next) => {
      revoke(next)
    })
    this.notify('artifact.unshared', meta)
    return { meta }
  }

  /** The artifact a share token opens, or null; every refusal looks the same to the caller. */
  async resolveShareToken(token) {
    const payload = this.signer.verify('share', token)
    if (!payload || !isValidSlug(payload.s)) return null
    const found = await this.store.getManifest(payload.s)
    if (!found || found.meta.public !== true || (found.meta.share?.gen ?? 1) !== payload.g) return null
    return found.meta
  }

  /** Links issued by the previous system (`?k=`), honoured while the artifact stays public. */
  legacyKeyMatches(meta, key) {
    return meta.public === true && Boolean(meta.share?.legacyKey) && safeEqual(key, meta.share.legacyKey)
  }

  async remove(slug) {
    await this.get(slug)
    await this.store.deleteArtifact(slug)
    this.catalog.remove(slug)
    this.notify('artifact.deleted', { slug })
  }

  // ---- webhooks --------------------------------------------------------------

  notify(event, meta) {
    const { url, secret } = this.config.webhook
    if (!url) return
    const body = JSON.stringify({ event, at: stamp(), artifact: meta.versions ? this.present(meta) : { slug: meta.slug } })
    const headers = { 'content-type': 'application/json', 'user-agent': 'artifacts-webhook' }
    if (secret) headers['x-artifacts-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    this.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
      .then((response) => {
        if (!response.ok) this.log('warn', 'webhook answered with an error', { event, status: response.status })
      })
      .catch((error) => this.log('warn', 'webhook failed', { event, error: error.message }))
  }
}

function revoke(meta) {
  meta.public = false
  meta.share = { gen: (meta.share?.gen ?? 1) + 1 }
}

function presentVersion(version, n) {
  const formats = []
  if (version.html !== false) formats.push('html')
  if (version.markdown) formats.push('markdown')
  return {
    n,
    id: version.id,
    createdAt: version.createdAt,
    author: version.author ?? null,
    note: version.note ?? null,
    formats,
    bytes: version.bytes ?? null,
    ...(version.source ? { source: version.source } : {}),
  }
}
