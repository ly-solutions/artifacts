/**
 * The documents in the harnessly hub's trash (HRN-1478, HRN-1479).
 *
 * The hub owns the records of an installation's documents and says "none" to everybody about a trashed one, but a person
 * who signed in here directly (single sign-on) is not asked to the hub, so the service keeps the flag itself:
 * `trash.json`, a map of slug → { at, by }. A trashed document answers 404 to everyone except a service token (the hub
 * itself, which restores it) and leaves the catalog. The flag is set when a trash goes through this service, and by the
 * hub with `POST /api/v1/artifacts/{slug}/trash` (a service token). Nothing is deleted: restoring clears the flag.
 */
import { ConflictError } from './storage/index.mjs'

const KEY = 'trash.json'
const CAS_ATTEMPTS = 8
const FRESH_MS = 10_000

export class TrashStore {
  constructor(storage, { now = () => Date.now() } = {}) {
    this.storage = storage
    this.now = now
    this.map = new Map()
    this.loadedAt = 0
    this.loading = null
  }

  async read() {
    const found = await this.storage.get(KEY)
    if (!found) return { doc: { schema: 1, items: {} }, etag: null }
    const doc = JSON.parse(found.body.toString('utf8'))
    if (!doc.items || typeof doc.items !== 'object') doc.items = {}
    return { doc, etag: found.etag }
  }

  /** The set of trashed slugs, read again when it is older than a few seconds (another replica may have changed it). */
  async slugs() {
    if (this.now() - this.loadedAt < FRESH_MS) return this.map
    if (!this.loading) {
      this.loading = this.read()
        .then(({ doc }) => {
          this.map = new Map(Object.entries(doc.items))
          this.loadedAt = this.now()
        })
        .finally(() => {
          this.loading = null
        })
    }
    await this.loading
    return this.map
  }

  async has(slug) {
    return (await this.slugs()).has(slug)
  }

  async set(slug, trashed, by = null) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const { doc, etag } = await this.read()
      if (trashed) doc.items[slug] = { at: new Date(this.now()).toISOString(), by }
      else delete doc.items[slug]
      const options = { contentType: 'application/json' }
      if (etag === null) options.ifNoneMatch = '*'
      else options.ifMatch = etag
      try {
        await this.storage.put(KEY, Buffer.from(JSON.stringify(doc)), options)
        this.map = new Map(Object.entries(doc.items))
        this.loadedAt = this.now()
        return
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
      }
    }
    throw new Error('the trash list is busy, try again')
  }
}
