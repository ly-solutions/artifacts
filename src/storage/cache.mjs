/**
 * Read cache in front of a storage driver.
 *
 * Some S3-compatible stores answer HEAD and listings in a fraction of a second but take
 * seconds to start sending an object (Selectel ru-3 measured about 4 s per GET in 2026,
 * whatever the size). The cache keeps recently read and written objects in memory:
 *
 * - immutable keys (version content) are served from memory without asking the store;
 * - other keys are revalidated with a HEAD and served from memory when the ETag matches.
 *
 * Writes and deletes through this process update the cache, so a page published here is
 * read back at once. Objects larger than an eighth of the budget are not cached.
 */
export class CachedStorage {
  constructor(inner, { maxBytes = 64 * 1024 * 1024, isImmutable = () => false } = {}) {
    this.inner = inner
    this.name = inner.name
    this.maxBytes = maxBytes
    this.isImmutable = isImmutable
    this.entries = new Map() // key -> { body, etag, contentType, modified }; Map order is LRU order
    this.bytes = 0
    this.stats = { hits: 0, revalidated: 0, misses: 0 }
  }

  remember(key, entry) {
    this.forget(key)
    if (!entry || !entry.etag || entry.body.length > this.maxBytes / 8) return
    this.entries.set(key, entry)
    this.bytes += entry.body.length
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      this.entries.delete(oldest)
      this.bytes -= value.body.length
    }
  }

  forget(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.body.length
  }

  touch(key, entry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    return { ...entry }
  }

  async get(key) {
    const cached = this.entries.get(key)
    if (cached && this.isImmutable(key)) {
      this.stats.hits += 1
      return this.touch(key, cached)
    }
    if (cached) {
      const head = await this.inner.head(key)
      if (!head) {
        this.forget(key)
        return null
      }
      if (head.etag === cached.etag) {
        this.stats.revalidated += 1
        return this.touch(key, cached)
      }
    }
    this.stats.misses += 1
    const found = await this.inner.get(key)
    if (found) this.remember(key, { body: found.body, etag: found.etag, contentType: found.contentType, modified: found.modified })
    else this.forget(key)
    return found
  }

  head(key) {
    return this.inner.head(key)
  }

  async put(key, body, options = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
    try {
      const result = await this.inner.put(key, data, options)
      if (result?.etag) this.remember(key, { body: data, etag: result.etag, contentType: options.contentType, modified: new Date() })
      else this.forget(key)
      return result
    } catch (error) {
      this.forget(key)
      throw error
    }
  }

  async delete(key) {
    this.forget(key)
    return this.inner.delete(key)
  }

  list(prefix) {
    return this.inner.list(prefix)
  }

  check() {
    return this.inner.check()
  }

  ensureBucket() {
    return this.inner.ensureBucket?.()
  }

  get locks() {
    return this.inner.locks
  }

  putNow(key, body, options) {
    this.forget(key)
    return (this.inner.putNow ?? this.inner.put).call(this.inner, key, body, options)
  }
}
