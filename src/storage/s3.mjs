/**
 * S3 driver for AWS S3 and S3-compatible stores (MinIO, Ceph RGW, Cloudflare R2,
 * Garage, SeaweedFS, cloud providers' object storage).
 *
 * Concurrency relies on conditional PUT: `If-None-Match: *` to create a key only
 * once and `If-Match: <etag>` to replace it only if nobody else did. AWS S3 and
 * MinIO support both. For a store that does not, set
 * ARTIFACTS_S3_CONDITIONAL_WRITES=off: the driver then checks the ETag itself
 * right before writing, which is only safe with a single writer.
 *
 * Conditional writes to one key are also serialised inside the process: some stores
 * evaluate preconditions correctly only when requests do not overlap (see
 * docs/storage.md, "Stores without atomic preconditions").
 */
import { ConflictError, StorageError, assertKey } from './index.mjs'
import { KeyedLock } from './lock.mjs'
import { signRequest, uriEncode } from './sigv4.mjs'

const RETRIES = 3

const xmlText = (value) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')

const tag = (xml, name) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? xmlText(match[1]) : undefined
}

/**
 * S3 bucket naming rules: 3 to 63 characters, lowercase letters, digits, dots and dashes,
 * starting and ending with a letter or digit, not shaped like an IP address. A bad name
 * otherwise surfaces only as 400 InvalidBucketName from the first request.
 */
export function bucketNameProblem(name) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 63) return `bucket name "${name}" must be 3 to 63 characters long`
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return `bucket name "${name}" may contain only lowercase letters, digits, dots and dashes, and must start and end with a letter or digit`
  if (name.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(name)) return `bucket name "${name}" must not contain ".." or look like an IP address`
  return null
}

export class S3Storage {
  constructor({ bucket, prefix = '', endpoint, region = 'us-east-1', forcePathStyle, accessKeyId, secretAccessKey, sessionToken, conditionalWrites = true, fetchImpl = fetch }) {
    if (!bucket) throw new Error('s3 storage needs a bucket (ARTIFACTS_S3_BUCKET)')
    const problem = bucketNameProblem(bucket)
    if (problem) throw new Error(problem)
    if (!accessKeyId || !secretAccessKey) throw new Error('s3 storage needs credentials (ARTIFACTS_S3_ACCESS_KEY_ID / ARTIFACTS_S3_SECRET_ACCESS_KEY or AWS_*)')
    this.name = 's3'
    this.bucket = bucket
    this.prefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
    this.region = region
    this.credentials = { accessKeyId, secretAccessKey, sessionToken }
    this.conditionalWrites = conditionalWrites
    this.locks = new KeyedLock()
    this.fetch = fetchImpl
    const base = endpoint ? endpoint.replace(/\/$/, '') : `https://s3.${region}.amazonaws.com`
    this.pathStyle = forcePathStyle ?? Boolean(endpoint)
    if (this.pathStyle) {
      this.bucketUrl = `${base}/${uriEncode(bucket)}`
    } else {
      const url = new URL(base)
      this.bucketUrl = `${url.protocol}//${bucket}.${url.host}`
    }
  }

  url(key, query) {
    const path = key === undefined ? '/' : `/${uriEncode(this.prefix + assertKey(key), true)}`
    const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
    return `${this.bucketUrl}${this.pathStyle && path === '/' ? '' : path}${qs}`
  }

  async request(method, url, { headers = {}, body } = {}) {
    let lastError
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const signed = signRequest({ method, url, headers, body, region: this.region, ...this.credentials })
      try {
        const response = await this.fetch(url, { method, headers: signed, body })
        if (response.status >= 500 && attempt < RETRIES - 1) {
          lastError = new StorageError(`S3 ${method} answered ${response.status}`, { status: response.status })
          await response.arrayBuffer().catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
          continue
        }
        return response
      } catch (error) {
        lastError = new StorageError(`S3 ${method} failed: ${error.message}`, { cause: error })
        if (attempt < RETRIES - 1) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
    throw lastError
  }

  async fail(response, what) {
    const text = await response.text().catch(() => '')
    const code = tag(text, 'Code')
    throw new StorageError(`S3 ${what}: ${response.status}${code ? ` ${code}` : ''}`, { status: response.status })
  }

  async head(key) {
    const response = await this.request('HEAD', this.url(key))
    if (response.status === 404) return null
    if (!response.ok) await this.fail(response, `head ${key}`)
    return {
      etag: response.headers.get('etag'),
      size: Number(response.headers.get('content-length') ?? 0),
      modified: new Date(response.headers.get('last-modified') ?? 0),
    }
  }

  async get(key) {
    const response = await this.request('GET', this.url(key))
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => {})
      return null
    }
    if (!response.ok) await this.fail(response, `get ${key}`)
    const body = Buffer.from(await response.arrayBuffer())
    return {
      body,
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type') ?? undefined,
      modified: new Date(response.headers.get('last-modified') ?? 0),
    }
  }

  async put(key, body, options = {}) {
    if (options.ifMatch === undefined && options.ifNoneMatch === undefined) return this.putNow(key, body, options)
    return this.locks.run(key, () => this.putNow(key, body, options))
  }

  async putNow(key, body, { contentType = 'application/octet-stream', ifMatch, ifNoneMatch } = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const headers = { 'content-type': contentType }
    if (this.conditionalWrites) {
      if (ifMatch !== undefined) headers['if-match'] = ifMatch
      if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch
    } else if (ifMatch !== undefined || ifNoneMatch !== undefined) {
      const current = await this.head(key)
      if (ifNoneMatch === '*' && current) throw new ConflictError(`${key} already exists`)
      if (ifMatch !== undefined && (!current || current.etag !== ifMatch)) throw new ConflictError(`${key} changed`)
    }
    const response = await this.request('PUT', this.url(key), { headers, body: data })
    // 412 is the documented answer; AWS answers 409 when two conditional writes race, and
    // AWS and MinIO answer 404 NoSuchKey to If-Match on a key that does not exist.
    if (response.status === 412 || response.status === 409 || (response.status === 404 && headers['if-match'] !== undefined)) {
      await response.arrayBuffer().catch(() => {})
      throw new ConflictError(`${key} changed`)
    }
    if (!response.ok) await this.fail(response, `put ${key}`)
    await response.arrayBuffer().catch(() => {})
    return { etag: response.headers.get('etag') }
  }

  async delete(key) {
    const response = await this.request('DELETE', this.url(key))
    if (!response.ok && response.status !== 404) await this.fail(response, `delete ${key}`)
    await response.arrayBuffer().catch(() => {})
  }

  async *list(prefix = '') {
    let token
    do {
      const query = { 'list-type': '2', prefix: this.prefix + prefix, 'max-keys': '1000' }
      if (token) query['continuation-token'] = token
      const response = await this.request('GET', this.url(undefined, query))
      if (!response.ok) await this.fail(response, `list ${prefix}`)
      const xml = await response.text()
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(match[1], 'Key')
        if (!key?.startsWith(this.prefix)) continue
        yield {
          key: key.slice(this.prefix.length),
          etag: tag(match[1], 'ETag'),
          size: Number(tag(match[1], 'Size') ?? 0),
          modified: new Date(tag(match[1], 'LastModified') ?? 0),
        }
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined
    } while (token)
  }

  async check() {
    const response = await this.request('GET', this.url(undefined, { 'list-type': '2', 'max-keys': '1', prefix: this.prefix }))
    if (!response.ok) await this.fail(response, `bucket ${this.bucket}`)
    await response.arrayBuffer().catch(() => {})
  }

  async ensureBucket() {
    const head = await this.request('HEAD', this.bucketUrl)
    await head.arrayBuffer().catch(() => {})
    if (head.ok) return false
    const body =
      this.region === 'us-east-1'
        ? undefined
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.region}</LocationConstraint></CreateBucketConfiguration>`
    const response = await this.request('PUT', this.bucketUrl, { body })
    if (!response.ok && response.status !== 409) await this.fail(response, `create bucket ${this.bucket}`)
    await response.arrayBuffer().catch(() => {})
    return true
  }
}
