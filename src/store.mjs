/**
 * The storage layout, on top of any driver:
 *
 *   meta/<slug>.json                       manifest: metadata + the list of versions (mutable, ETag-guarded)
 *   content/<slug>/<versionId>/index.html  a version's page (immutable)
 *   content/<slug>/<versionId>/document.md a version's Markdown source (immutable, optional)
 *   system/secret.json                     generated signing secret when ARTIFACTS_SECRET is not set
 *
 * Why manifests live in one flat folder: listing `meta/` returns every
 * artifact with its ETag in one request per thousand documents, which keeps
 * the incremental index refresh cheap. Version content never changes once
 * written, so it can be cached, replicated and backed up like any static file.
 *
 * Why not S3 bucket versioning: it is not available on every S3-compatible
 * store, not at all on a filesystem, and deleting a document would leave its
 * history behind as delete markers. Explicit version objects behave the same
 * on every backend.
 */
import { randomBytes } from 'node:crypto'

import { ConflictError } from './storage/index.mjs'
import { isValidSlug } from './text.mjs'

export const SCHEMA = 1
const MANIFEST_RE = /^meta\/([a-z0-9][a-z0-9-]*)\.json$/
const VERSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/

export const manifestKey = (slug) => `meta/${slug}.json`
export const contentKey = (slug, versionId, file) => `content/${slug}/${versionId}/${file}`

/** Sortable, unique version id: 20261019T120000Z-a1b2c3. */
export function newVersionId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(3).toString('hex')}`
}

export const isValidVersionId = (id) => typeof id === 'string' && VERSION_ID_RE.test(id)

export class ArtifactStore {
  constructor(storage) {
    this.storage = storage
  }

  async *listManifests() {
    for await (const item of this.storage.list('meta/')) {
      const match = MANIFEST_RE.exec(item.key)
      if (match) yield { slug: match[1], etag: item.etag }
    }
  }

  async getManifest(slug) {
    if (!isValidSlug(slug)) return null
    const found = await this.storage.get(manifestKey(slug))
    if (!found) return null
    const meta = JSON.parse(found.body.toString('utf8'))
    if (!Array.isArray(meta.versions)) meta.versions = []
    return { meta, etag: found.etag }
  }

  /** etag: the one read before (replace only if unchanged); null: create only. */
  async putManifest(meta, etag) {
    const body = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`)
    const options = { contentType: 'application/json' }
    if (etag === null) options.ifNoneMatch = '*'
    else options.ifMatch = etag
    return this.storage.put(manifestKey(meta.slug), body, options)
  }

  async putVersionContent(slug, versionId, { html, markdown }) {
    // Version objects are written once; If-None-Match keeps a retry from replacing a different upload.
    const write = (file, text, type) =>
      this.storage
        .put(contentKey(slug, versionId, file), Buffer.from(text, 'utf8'), { contentType: type, ifNoneMatch: '*' })
        .catch((error) => {
          if (error instanceof ConflictError) throw new Error(`version ${versionId} of ${slug} already exists`)
          throw error
        })
    if (typeof html === 'string') await write('index.html', html, 'text/html; charset=utf-8')
    if (typeof markdown === 'string') await write('document.md', markdown, 'text/markdown; charset=utf-8')
  }

  async readVersionContent(slug, version) {
    const out = {}
    if (version.html !== false) {
      const found = await this.storage.get(contentKey(slug, version.id, 'index.html'))
      if (found) out.html = found.body.toString('utf8')
    }
    if (version.markdown) {
      const found = await this.storage.get(contentKey(slug, version.id, 'document.md'))
      if (found) out.markdown = found.body.toString('utf8')
    }
    return out
  }

  async deleteArtifact(slug) {
    // Manifest first: from that moment the artifact is gone for every reader, and
    // leftover content objects are unreachable garbage rather than a half-deleted document.
    await this.storage.delete(manifestKey(slug))
    const keys = []
    for await (const item of this.storage.list(`content/${slug}/`)) keys.push(item.key)
    for (const key of keys) await this.storage.delete(key)
  }

  /** The signing secret: explicit, or generated once and shared by all replicas through storage. */
  async signingSecret(explicit) {
    if (explicit) return explicit
    const key = 'system/secret.json'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await this.storage.get(key)
      if (found) return JSON.parse(found.body.toString('utf8')).secret
      try {
        const secret = randomBytes(32).toString('base64url')
        await this.storage.put(key, Buffer.from(JSON.stringify({ secret, createdAt: new Date().toISOString() })), {
          contentType: 'application/json',
          ifNoneMatch: '*',
        })
        return secret
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
      }
    }
    throw new Error('could not read or create the signing secret')
  }
}
