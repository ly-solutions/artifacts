/**
 * In-process S3 stand-in for tests: path-style GET/PUT/HEAD/DELETE, ListObjectsV2
 * with pagination, conditional PUT (If-Match / If-None-Match) and SigV4
 * verification of every request. racyPreconditionsMs imitates a store whose
 * preconditions are not atomic under concurrency. Real-endpoint coverage comes from the MinIO
 * job (ARTIFACTS_TEST_S3_ENDPOINT).
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { signRequest } from '../../src/storage/sigv4.mjs'

const xml = (value) => String(value).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch])

export async function startFakeS3({ accessKeyId = 'test-access-key', secretAccessKey = 'fake'.repeat(8), region = 'us-east-1', pageSize = 1000, buckets = ['test-bucket'], racyPreconditionsMs = 0 } = {}) {
  const objects = new Map() // "bucket/key" -> { body, etag, contentType, modified }
  const known = new Set(buckets)
  const stats = { requests: 0, rejectedSignatures: 0, preconditionFailures: 0 }

  const server = createServer(async (req, res) => {
    stats.requests += 1
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)

    // Recompute the signature from what arrived.
    const auth = req.headers.authorization ?? ''
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? []
    const headers = {}
    for (const name of signed) if (!['host', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token'].includes(name)) headers[name] = req.headers[name]
    const date = req.headers['x-amz-date'] ?? ''
    const now = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
    const expected = signRequest({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers, body: body.length ? body : undefined, region, accessKeyId, secretAccessKey, now }).authorization
    if (auth !== expected || createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) {
      stats.rejectedSignatures += 1
      res.writeHead(403, { 'content-type': 'application/xml' })
      return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
    }

    const url = new URL(req.url, 'http://fake')
    const [, bucket, ...rest] = url.pathname.split('/')
    const key = rest.map(decodeURIComponent).join('/')
    const id = `${bucket}/${key}`

    if (!key) {
      if (req.method === 'HEAD') {
        res.writeHead(known.has(bucket) ? 200 : 404)
        return res.end()
      }
      if (req.method === 'PUT') {
        known.add(bucket)
        res.writeHead(200)
        return res.end()
      }
      if (!known.has(bucket)) {
        res.writeHead(404, { 'content-type': 'application/xml' })
        return res.end('<Error><Code>NoSuchBucket</Code></Error>')
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const max = Math.min(Number(url.searchParams.get('max-keys') ?? 1000), pageSize)
        const after = url.searchParams.get('continuation-token') ?? ''
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/`))
          .map((k) => k.slice(bucket.length + 1))
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort()
        const page = keys.slice(0, max)
        const truncated = keys.length > max
        const contents = page
          .map((k) => {
            const o = objects.get(`${bucket}/${k}`)
            return `<Contents><Key>${xml(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>${xml(o.etag)}</ETag><Size>${o.body.length}</Size></Contents>`
          })
          .join('')
        res.writeHead(200, { 'content-type': 'application/xml' })
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${
            truncated ? `<NextContinuationToken>${xml(page.at(-1))}</NextContinuationToken>` : ''
          }${contents}</ListBucketResult>`,
        )
      }
    }

    const current = objects.get(id)
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!current) {
        res.writeHead(404, { 'content-type': 'application/xml' })
        return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>')
      }
      res.writeHead(200, { etag: current.etag, 'content-type': current.contentType, 'content-length': current.body.length, 'last-modified': current.modified.toUTCString() })
      return res.end(req.method === 'HEAD' ? undefined : current.body)
    }
    if (req.method === 'PUT') {
      const ifNoneMatch = req.headers['if-none-match']
      const ifMatch = req.headers['if-match']
      if ((ifNoneMatch === '*' && current) || (ifMatch !== undefined && (!current || current.etag !== ifMatch))) {
        stats.preconditionFailures += 1
        res.writeHead(412, { 'content-type': 'application/xml' })
        return res.end('<Error><Code>PreconditionFailed</Code></Error>')
      }
      // Like a store that checks preconditions on arrival but commits later: overlapping writes all pass.
      if (racyPreconditionsMs) await new Promise((resolve) => setTimeout(resolve, racyPreconditionsMs))
      const etag = `"${createHash('md5').update(body).digest('hex')}"`
      objects.set(id, { body, etag, contentType: req.headers['content-type'] ?? 'application/octet-stream', modified: new Date() })
      res.writeHead(200, { etag })
      return res.end()
    }
    if (req.method === 'DELETE') {
      objects.delete(id)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(405)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return {
    endpoint,
    objects,
    stats,
    settings: { endpoint, region, accessKeyId, secretAccessKey, bucket: buckets[0], forcePathStyle: true },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
