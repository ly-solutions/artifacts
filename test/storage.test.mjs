/**
 * One conformance suite for every driver: fs, the in-process fake S3, and a
 * real S3 endpoint when ARTIFACTS_TEST_S3_ENDPOINT is set (CI runs MinIO).
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { ConflictError, assertKey, parseStorageUrl } from '../src/storage/index.mjs'
import { FsStorage } from '../src/storage/fs.mjs'
import { S3Storage, bucketNameProblem } from '../src/storage/s3.mjs'
import { signRequest, uriEncode } from '../src/storage/sigv4.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'
import { tempDir } from './helpers/tmp.mjs'

const drivers = [
  {
    name: 'fs',
    async setup() {
      const tmp = await tempDir()
      return { storage: new FsStorage({ dir: tmp.dir }), cleanup: tmp.cleanup }
    },
  },
  {
    name: 's3 (fake)',
    async setup() {
      const fake = await startFakeS3({ pageSize: 3 })
      return { storage: new S3Storage({ ...fake.settings, prefix: 'pfx' }), cleanup: fake.close, fake }
    },
  },
]

// A bad test bucket would fail inside before() and cancel every test of the suite; say it plainly instead.
const testBucket = process.env.ARTIFACTS_TEST_S3_BUCKET ?? 'artifacts-test'
if (process.env.ARTIFACTS_TEST_S3_ENDPOINT && bucketNameProblem(testBucket)) throw new Error(`ARTIFACTS_TEST_S3_BUCKET: ${bucketNameProblem(testBucket)}`)

if (process.env.ARTIFACTS_TEST_S3_ENDPOINT) {
  drivers.push({
    name: `s3 (${process.env.ARTIFACTS_TEST_S3_ENDPOINT})`,
    async setup() {
      const storage = new S3Storage({
        endpoint: process.env.ARTIFACTS_TEST_S3_ENDPOINT,
        bucket: testBucket,
        prefix: `run-${randomBytes(4).toString('hex')}/`,
        region: process.env.ARTIFACTS_TEST_S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.ARTIFACTS_TEST_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.ARTIFACTS_TEST_S3_SECRET_ACCESS_KEY,
      })
      await storage.ensureBucket()
      return {
        storage,
        cleanup: async () => {
          for await (const item of storage.list('')) await storage.delete(item.key)
        },
      }
    },
  })
}

for (const driver of drivers) {
  describe(`storage driver: ${driver.name}`, () => {
    let ctx
    before(async () => {
      ctx = await driver.setup()
    })
    after(() => ctx.cleanup())

    it('returns null for a missing key', async () => {
      assert.equal(await ctx.storage.get('missing/key.json'), null)
      assert.equal(await ctx.storage.head('missing/key.json'), null)
    })

    it('writes, reads and lists objects', async () => {
      const { etag } = await ctx.storage.put('meta/a.json', Buffer.from('{"a":1}'), { contentType: 'application/json' })
      assert.ok(etag)
      const got = await ctx.storage.get('meta/a.json')
      assert.equal(got.body.toString(), '{"a":1}')
      assert.equal(got.etag, etag)
      assert.equal((await ctx.storage.head('meta/a.json')).etag, etag)
      await ctx.storage.put('meta/b.json', Buffer.from('{}'))
      await ctx.storage.put('content/a/v1/index.html', Buffer.from('<p>x</p>'))
      const keys = []
      for await (const item of ctx.storage.list('meta/')) keys.push(item.key)
      assert.deepEqual(keys, ['meta/a.json', 'meta/b.json'])
    })

    it('lists across pages', async () => {
      for (let i = 0; i < 7; i += 1) await ctx.storage.put(`page/k${i}.txt`, Buffer.from(String(i)))
      const keys = []
      for await (const item of ctx.storage.list('page/')) keys.push(item.key)
      assert.equal(keys.length, 7)
    })

    it('creates only once with ifNoneMatch', async () => {
      await ctx.storage.put('once.txt', Buffer.from('1'), { ifNoneMatch: '*' })
      await assert.rejects(ctx.storage.put('once.txt', Buffer.from('2'), { ifNoneMatch: '*' }), ConflictError)
      assert.equal((await ctx.storage.get('once.txt')).body.toString(), '1')
    })

    it('replaces only an unchanged object with ifMatch', async () => {
      const first = await ctx.storage.put('cas.txt', Buffer.from('a'))
      const second = await ctx.storage.put('cas.txt', Buffer.from('b'), { ifMatch: first.etag })
      await assert.rejects(ctx.storage.put('cas.txt', Buffer.from('c'), { ifMatch: first.etag }), ConflictError)
      await ctx.storage.put('cas.txt', Buffer.from('d'), { ifMatch: second.etag })
      assert.equal((await ctx.storage.get('cas.txt')).body.toString(), 'd')
      await assert.rejects(ctx.storage.put('never-existed.txt', Buffer.from('x'), { ifMatch: '"nope"' }), ConflictError)
    })

    it('lets exactly one of two concurrent compare-and-swaps win', async () => {
      const base = await ctx.storage.put('race.txt', Buffer.from('0'))
      const results = await Promise.allSettled([
        ctx.storage.put('race.txt', Buffer.from('x'), { ifMatch: base.etag }),
        ctx.storage.put('race.txt', Buffer.from('y'), { ifMatch: base.etag }),
      ])
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    })

    it('deletes idempotently', async () => {
      await ctx.storage.put('gone.txt', Buffer.from('x'))
      await ctx.storage.delete('gone.txt')
      await ctx.storage.delete('gone.txt')
      assert.equal(await ctx.storage.get('gone.txt'), null)
    })

    it('handles keys with dots, dashes and non-trivial characters', async () => {
      await ctx.storage.put('content/a-b/20261019T120000Z-abc123/document.md', Buffer.from('# hi'))
      assert.equal((await ctx.storage.get('content/a-b/20261019T120000Z-abc123/document.md')).body.toString(), '# hi')
    })

    it('passes the readiness check', async () => {
      await ctx.storage.check()
    })
  })
}

describe('storage keys and URLs', () => {
  it('rejects path traversal and odd keys', () => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', '', 'a b', 'a\\b']) assert.throws(() => assertKey(bad))
    assert.equal(assertKey('meta/x.json'), 'meta/x.json')
  })

  it('parses storage URLs', () => {
    assert.deepEqual(parseStorageUrl('s3://bucket/some/prefix'), { storage: 's3', bucket: 'bucket', prefix: 'some/prefix/' })
    assert.deepEqual(parseStorageUrl('s3://bucket'), { storage: 's3', bucket: 'bucket', prefix: '' })
    assert.deepEqual(parseStorageUrl('file:///var/data'), { storage: 'fs', dir: '/var/data' })
    assert.deepEqual(parseStorageUrl('./data'), { storage: 'fs', dir: './data' })
  })
})

describe('sigv4', () => {
  it('matches the AWS documentation example for GET Object', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (example: GET Object)
    const headers = signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('encodes like S3 expects', () => {
    assert.equal(uriEncode('a b+c/d~e', true), 'a%20b%2Bc/d~e')
    assert.equal(uriEncode('é'), '%C3%A9')
  })

  it('rejects invalid bucket names before the first request', () => {
    for (const bad of ['ci', 'a'.repeat(64), 'Upper', '-dash', 'dash-', 'a..b', '192.168.1.1', 'under_score']) {
      assert.ok(bucketNameProblem(bad), bad)
      assert.throws(() => new S3Storage({ bucket: bad, accessKeyId: 'k', secretAccessKey: 's' }), /bucket name/)
    }
    for (const good of ['abc', 'artifacts-ci', 'my.bucket.example', 'a1b']) assert.equal(bucketNameProblem(good), null, good)
  })

  it('builds virtual-hosted URLs for AWS and path-style for custom endpoints', () => {
    const aws = new S3Storage({ bucket: 'bkt', region: 'eu-west-1', accessKeyId: 'k', secretAccessKey: 's' })
    assert.equal(aws.url('meta/x.json'), 'https://bkt.s3.eu-west-1.amazonaws.com/meta/x.json')
    const minio = new S3Storage({ bucket: 'bkt', endpoint: 'http://minio:9000', prefix: 'p', accessKeyId: 'k', secretAccessKey: 's' })
    assert.equal(minio.url('meta/x.json'), 'http://minio:9000/bkt/p/meta/x.json')
  })

  it('falls back to check-then-write without conditional write support', async () => {
    const fake = await startFakeS3()
    try {
      const storage = new S3Storage({ ...fake.settings, conditionalWrites: false })
      await storage.put('x.txt', Buffer.from('1'), { ifNoneMatch: '*' })
      await assert.rejects(storage.put('x.txt', Buffer.from('2'), { ifNoneMatch: '*' }), ConflictError)
      assert.equal(fake.stats.rejectedSignatures, 0)
    } finally {
      await fake.close()
    }
  })

  it('creates a missing bucket on request', async () => {
    const fake = await startFakeS3({ buckets: [] })
    try {
      const storage = new S3Storage({ ...fake.settings, bucket: 'fresh' })
      await assert.rejects(storage.check())
      assert.equal(await storage.ensureBucket(), true)
      await storage.check()
      assert.equal(await storage.ensureBucket(), false)
    } finally {
      await fake.close()
    }
  })
})

describe('stores without atomic preconditions', () => {
  it('lets exactly one of many overlapping conditional writes win', async () => {
    const fake = await startFakeS3({ racyPreconditionsMs: 30 })
    try {
      const storage = new S3Storage(fake.settings)
      const creates = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => storage.put('race/new.json', Buffer.from(String(i)), { ifNoneMatch: '*' })))
      assert.equal(creates.filter((r) => r.status === 'fulfilled').length, 1)
      assert.ok(creates.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof ConflictError))

      const { etag } = await storage.head('race/new.json')
      const updates = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => storage.put('race/new.json', Buffer.from(`u${i}`), { ifMatch: etag })))
      assert.equal(updates.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(storage.locks.size, 0)
    } finally {
      await fake.close()
    }
  })

  it('does not serialise unconditional writes or writes to different keys', async () => {
    const fake = await startFakeS3({ racyPreconditionsMs: 30 })
    try {
      const storage = new S3Storage(fake.settings)
      const started = Date.now()
      await Promise.all(Array.from({ length: 8 }, (_, i) => storage.put(`race/k${i}.json`, Buffer.from('x'), { ifNoneMatch: '*' })))
      assert.ok(Date.now() - started < 8 * 30, 'different keys should be written in parallel')
    } finally {
      await fake.close()
    }
  })
})

describe('storage-check probe', () => {
  it('tells an atomic store from one that only checks one request at a time', async () => {
    const { probePreconditions } = await import('../src/storage/probe.mjs')
    const good = await startFakeS3()
    const racy = await startFakeS3({ racyPreconditionsMs: 30 })
    try {
      const ok = await probePreconditions(new S3Storage(good.settings))
      assert.deepEqual(ok, { sequential: true, parallel: 8, creates: 1, updates: 1, atomic: true })
      const bad = await probePreconditions(new S3Storage(racy.settings))
      assert.equal(bad.sequential, true)
      assert.equal(bad.atomic, false)
      assert.ok(bad.creates > 1 && bad.updates > 1)
      const left = []
      for await (const item of new S3Storage(racy.settings).list('system/')) left.push(item.key)
      assert.deepEqual(left, [])
    } finally {
      await good.close()
      await racy.close()
    }
  })
})
