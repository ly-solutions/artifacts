/**
 * Storage drivers.
 *
 * Every driver is a small key-value object store with conditional writes. The
 * catalog is built on top of exactly five calls, so a new backend (GCS, Azure
 * Blob, a database) only has to implement this interface:
 *
 *   get(key)                -> { body, etag, contentType, modified } | null
 *   head(key)               -> { etag, size, modified } | null
 *   put(key, body, opts)    -> { etag }   opts: { contentType, ifMatch, ifNoneMatch: '*' }
 *   delete(key)             -> void (idempotent)
 *   list(prefix)            -> async iterator of { key, etag, size, modified }
 *   check()                 -> resolves when the backend is reachable
 *
 * A failed precondition throws ConflictError (S3 answers 412 or 409). Keys
 * are relative and use forward slashes; the driver applies its own prefix or
 * root directory. ly-solutions/boards builds on the same get/put/delete/list
 * surface, conditional-write semantics and ARTIFACTS_/BOARDS_ variable names.
 */
/** A conditional write lost: the object changed (or appeared) since it was read. */
export class ConflictError extends Error {
  constructor(message = 'the object changed since it was read') {
    super(message)
    this.name = 'ConflictError'
    this.code = 'CONFLICT'
  }
}

export class StorageError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause })
    this.name = 'StorageError'
    this.status = status
  }
}

const KEY_RE = /^[A-Za-z0-9._~@=+-]+(?:\/[A-Za-z0-9._~@=+-]+)*$/

/** Keys are built by the service, never taken verbatim from a request; this is the last line of defence. */
export function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new StorageError(`invalid storage key: ${JSON.stringify(key)}`)
  }
  return key
}

export async function createStorage(config) {
  if (config.storage === 'fs') {
    const { FsStorage } = await import('./fs.mjs')
    return new FsStorage({ dir: config.fsDir })
  }
  if (config.storage === 's3') {
    const { S3Storage } = await import('./s3.mjs')
    const storage = new S3Storage(config.s3)
    if (config.s3.createBucket) await storage.ensureBucket()
    if (!config.cacheMb) return storage
    const { CachedStorage } = await import('./cache.mjs')
    // content/… objects are written once per version (see store.mjs) and never change.
    return new CachedStorage(storage, { maxBytes: config.cacheMb * 1024 * 1024, isImmutable: (key) => key.startsWith('content/') })
  }
  throw new Error(`unknown storage driver "${config.storage}" (expected s3 or fs)`)
}

/** Parses `s3://bucket/prefix`, `file:///abs/dir` or a plain directory path into driver settings. */
export function parseStorageUrl(url) {
  if (url.startsWith('s3://')) {
    const rest = url.slice('s3://'.length)
    const slash = rest.indexOf('/')
    const bucket = slash === -1 ? rest : rest.slice(0, slash)
    let prefix = slash === -1 ? '' : rest.slice(slash + 1)
    if (prefix && !prefix.endsWith('/')) prefix += '/'
    if (!bucket) throw new Error(`no bucket in ${url}`)
    return { storage: 's3', bucket, prefix }
  }
  if (url.startsWith('file://')) return { storage: 'fs', dir: new URL(url).pathname }
  return { storage: 'fs', dir: url }
}
