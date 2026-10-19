import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ArtifactService } from '../src/service.mjs'
import { FsStorage } from '../src/storage/fs.mjs'
import { S3Storage } from '../src/storage/s3.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'
import { tempDir, testConfig } from './helpers/setup.mjs'

const backends = {
  fs: async () => {
    const tmp = await tempDir()
    return { storage: new FsStorage({ dir: tmp.dir }), cleanup: tmp.cleanup }
  },
  's3 (fake)': async () => {
    const fake = await startFakeS3()
    return { storage: new S3Storage({ ...fake.settings, prefix: 'artifacts/' }), cleanup: fake.close }
  },
}

if (process.env.ARTIFACTS_TEST_S3_ENDPOINT) {
  backends[`s3 (${process.env.ARTIFACTS_TEST_S3_ENDPOINT})`] = async () => {
    const storage = new S3Storage({
      endpoint: process.env.ARTIFACTS_TEST_S3_ENDPOINT,
      bucket: process.env.ARTIFACTS_TEST_S3_BUCKET ?? 'artifacts-test',
      prefix: `service-${randomBytes(4).toString('hex')}/`,
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
  }
}

for (const [name, make] of Object.entries(backends)) {
  describe(`service on ${name}`, () => {
    let ctx
    let service
    before(async () => {
      ctx = await make()
    })
    after(() => ctx.cleanup())
    beforeEach(async () => {
      service = await new ArtifactService({ storage: ctx.storage, config: testConfig({ ARTIFACTS_TASK_URL: 'https://tracker.example.com/issue/{task}' }) }).init()
    })

    it('publishes, refuses a duplicate title, and versions the same slug', async () => {
      const first = await service.publish({ html: '<h1>Rollout plan</h1><p>one</p>', title: 'Rollout plan', tags: ['Ops', 'ops', 'Plan'], task: 'PROJ-1', author: 'ada' })
      assert.equal(first.created, true)
      assert.equal(first.version.n, 1)
      const slug = first.meta.slug
      assert.deepEqual(first.meta.tags, ['Ops', 'Plan'])

      await assert.rejects(service.publish({ html: '<p>copy</p>', title: 'Rollout plan (v2)' }), (error) => error.status === 409 && error.code === 'duplicate' && error.extra.candidates[0].slug === slug)
      await assert.rejects(service.publish({ html: '<p>copy</p>', title: 'Rollout plan for staging', task: 'PROJ-1' }), (error) => error.code === 'duplicate')
      const other = await service.publish({ html: '<p>other</p>', title: 'Rollout plan (v2)', new: true })
      assert.notEqual(other.meta.slug, slug)

      const second = await service.publish({ slug, markdown: '# Rollout plan\n\ntwo', title: 'Rollout plan', note: 'second pass', author: 'grace' })
      assert.equal(second.created, false)
      assert.equal(second.version.n, 2)
      // Fields not sent stay as they were.
      assert.equal(second.meta.task, 'PROJ-1')
      assert.deepEqual(second.meta.tags, ['Ops', 'Plan'])
      assert.equal(second.meta.author, 'ada')

      const v1 = await service.readContent(slug, 1)
      assert.match(v1.html, /one/)
      const latest = await service.readContent(slug)
      assert.equal(latest.n, 2)
      assert.match(latest.markdown, /two/)
      const byId = await service.readContent(slug, second.version.id)
      assert.equal(byId.n, 2)
      await assert.rejects(service.readContent(slug, 3), (error) => error.status === 404)

      const versions = service.versionsOf((await service.get(slug)).meta)
      assert.deepEqual(versions.map((v) => [v.n, v.author, v.note, v.current]), [[2, 'grace', 'second pass', true], [1, 'ada', null, false]])
      assert.equal(service.present(second.meta).taskUrl, 'https://tracker.example.com/issue/PROJ-1')
    })

    it('validates input with reasons an agent can act on', async () => {
      await assert.rejects(service.publish({ title: 'x' }), (error) => error.status === 400 && error.problems.some((p) => p.startsWith('html or markdown')))
      await assert.rejects(service.publish({ html: '<p>x</p>', title: 'Bad slug', slug: 'Not OK' }), (error) => error.problems.some((p) => p.startsWith('slug')))
      await assert.rejects(service.publish({ html: '<p>x</p>', title: 'Bad note', slug: 'note-x', note: 'a\nb' }), (error) => error.problems.some((p) => p.startsWith('note')))
      await assert.rejects(service.publish({ html: '<p>x</p>', title: 'Public', public: true }), (error) => error.problems.some((p) => p.startsWith('public')))
      await assert.rejects(service.publish({ html: '<p>x</p>', title: 'Link', link: 'javascript:alert(1)' }), (error) => error.problems.some((p) => p.startsWith('link')))
      const big = 'x'.repeat(service.config.content.maxBytes + 1)
      await assert.rejects(service.publish({ html: big, title: 'Too big' }), (error) => error.status === 413)
    })

    it('takes the title from the document when none is given', async () => {
      const result = await service.publish({ markdown: '# Derived title\n\nbody', new: true })
      assert.equal(result.meta.title, 'Derived title')
    })

    it('numbers concurrent publications of one slug without losing any', async () => {
      const { meta } = await service.publish({ html: '<p>0</p>', title: 'Busy document', slug: 'busy-document' })
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => service.publish({ slug: meta.slug, html: `<p>${i + 1}</p>`, title: 'Busy document', note: `edit ${i + 1}` })))
      const numbers = results.map((r) => r.version.n).sort((a, b) => a - b)
      assert.deepEqual(numbers, [2, 3, 4, 5, 6, 7])
      const { meta: final } = await service.get(meta.slug)
      assert.equal(final.versions.length, 7)
      assert.equal(new Set(final.versions.map((v) => v.id)).size, 7)
    })

    it('refuses an edit based on a stale version', async () => {
      const { meta } = await service.publish({ html: '<p>a</p>', title: 'Optimistic', slug: 'optimistic' })
      await service.publish({ slug: meta.slug, html: '<p>b</p>', title: 'Optimistic', baseVersion: 1 })
      await assert.rejects(service.publish({ slug: meta.slug, html: '<p>c</p>', title: 'Optimistic', baseVersion: 1 }), (error) => error.status === 409 && error.code === 'version_conflict')
    })

    it('edits metadata without creating a version', async () => {
      const { meta } = await service.publish({ html: '<p>a</p>', title: 'Meta target', slug: 'meta-target', tags: ['one'] })
      const { meta: next } = await service.updateMeta(meta.slug, { title: 'Meta target renamed', addTags: 'two, ONE', removeTags: ['one'], task: 'PROJ-9', link: 'https://example.com/pr/1', session: 'conv-123' })
      assert.equal(next.title, 'Meta target renamed')
      assert.deepEqual(next.tags, ['two'])
      assert.equal(next.session, 'conv-123')
      assert.equal(next.versions.length, 1)
      await assert.rejects(service.updateMeta(meta.slug, { color: 'red' }), (error) => error.status === 400)
      await assert.rejects(service.updateMeta('no-such-thing', { title: 'x' }), (error) => error.status === 404)
      const found = await service.search({ session: 'conv-123' })
      assert.deepEqual(found.items.map((i) => i.slug), ['meta-target'])
    })

    it('shares by signed link and revokes every earlier link', async () => {
      const { meta } = await service.publish({ html: '<p>a</p>', title: 'Shared doc', slug: 'shared-doc' })
      assert.equal(await service.resolveShareToken(service.issueShareToken(meta)), null, 'private documents open by no link')
      const first = await service.share(meta.slug)
      assert.equal((await service.resolveShareToken(first.token)).slug, meta.slug)
      const again = await service.share(meta.slug)
      assert.ok(await service.resolveShareToken(first.token), 'sharing again keeps earlier links')
      assert.ok(await service.resolveShareToken(again.token))
      const rotated = await service.share(meta.slug, { rotate: true })
      assert.equal(await service.resolveShareToken(first.token), null, 'rotation revokes earlier links')
      assert.ok(await service.resolveShareToken(rotated.token))
      await service.unshare(meta.slug)
      assert.equal(await service.resolveShareToken(rotated.token), null)
      const reopened = await service.share(meta.slug)
      assert.equal(await service.resolveShareToken(rotated.token), null, 'reopening does not revive revoked links')
      assert.ok(await service.resolveShareToken(reopened.token))
      assert.equal(await service.resolveShareToken(`${reopened.token.slice(0, -2)}xx`), null)
      assert.equal(await service.resolveShareToken('garbage'), null)
    })

    it('expires share links', async () => {
      const { meta } = await service.publish({ html: '<p>a</p>', title: 'Expiring', slug: 'expiring' })
      await service.share(meta.slug)
      const expired = service.signer.sign('share', { s: meta.slug, g: (await service.get(meta.slug)).meta.share.gen, e: Math.floor(Date.now() / 1000) - 5 })
      assert.equal(await service.resolveShareToken(expired), null)
      const { expiresAt } = await service.share(meta.slug, { ttlSeconds: 3600 })
      assert.ok(Date.parse(expiresAt) > Date.now())
    })

    it('searches titles, tags and text with ranking', async () => {
      await service.publish({ html: '<p>The quarterly numbers for kiwi sales.</p>', title: 'Sales report', tags: ['finance'], slug: 'sales-report' })
      await service.publish({ markdown: 'kiwi is mentioned here once', title: 'Kiwi roadmap', tags: ['product'], slug: 'kiwi-roadmap' })
      const result = await service.search({ q: 'kiwi' })
      assert.deepEqual(result.items.map((i) => i.slug).slice(0, 2), ['kiwi-roadmap', 'sales-report'])
      assert.match(result.items[1].snippet, /kiwi sales/)
      assert.deepEqual((await service.search({ q: 'kiwi', tags: ['Finance'] })).items.map((i) => i.slug), ['sales-report'])
      assert.equal((await service.search({ q: 'kiwi banana' })).total, 0)
    })

    it('picks up writes made by another replica', async () => {
      const other = await new ArtifactService({ storage: ctx.storage, config: testConfig() }).init()
      await other.publish({ html: '<p>from elsewhere</p>', title: 'Replica write', slug: 'replica-write' })
      const found = await service.search({ q: 'replica write' })
      assert.equal(found.items[0]?.slug, 'replica-write')
      await other.remove('replica-write')
      assert.equal((await service.search({ q: 'replica write' })).total, 0)
    })

    it('deletes every version', async () => {
      const { meta } = await service.publish({ html: '<p>a</p>', title: 'Doomed', slug: 'doomed' })
      await service.publish({ slug: meta.slug, html: '<p>b</p>', title: 'Doomed' })
      await service.remove(meta.slug)
      await assert.rejects(service.get(meta.slug), (error) => error.status === 404)
      const left = []
      for await (const item of ctx.storage.list('content/doomed/')) left.push(item.key)
      assert.deepEqual(left, [])
    })

    it('shares one generated signing secret between replicas', async () => {
      const config = testConfig({ ARTIFACTS_SECRET: '' })
      config.auth.secret = undefined
      const a = await new ArtifactService({ storage: ctx.storage, config }).init()
      const b = await new ArtifactService({ storage: ctx.storage, config }).init()
      assert.equal(a.signer.secret, b.signer.secret)
    })
  })
}

describe('webhooks', () => {
  it('posts signed events', async () => {
    const tmp = await tempDir()
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return new Response('ok')
    }
    try {
      const service = await new ArtifactService({
        storage: new FsStorage({ dir: tmp.dir }),
        config: testConfig({ ARTIFACTS_WEBHOOK_URL: 'https://hooks.example.com/artifacts', ARTIFACTS_WEBHOOK_SECRET: 'hook-secret' }),
        fetchImpl,
      }).init()
      await service.publish({ html: '<p>x</p>', title: 'Hooked', slug: 'hooked', session: 'conv-9' })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(calls.length, 1)
      const body = JSON.parse(calls[0].init.body)
      assert.equal(body.event, 'artifact.published')
      assert.equal(body.artifact.session, 'conv-9')
      assert.match(calls[0].init.headers['x-artifacts-signature'], /^sha256=[0-9a-f]{64}$/)
    } finally {
      await tmp.cleanup()
    }
  })
})
