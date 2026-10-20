import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { validateConfig } from '../src/config.mjs'
import { ArtifactService } from '../src/service.mjs'
import { FsStorage } from '../src/storage/fs.mjs'
import { contentVersionId, isValidVersionId } from '../src/store.mjs'
import { startApp, tempDir, testConfig } from './helpers/setup.mjs'

describe('version ids', () => {
  let tmp
  let storage
  before(async () => {
    tmp = await tempDir()
    storage = new FsStorage({ dir: tmp.dir })
  })
  after(() => tmp.cleanup())

  const serviceWith = (env) => new ArtifactService({ storage, config: testConfig(env) }).init()

  it('validates the format setting', () => {
    assert.deepEqual(validateConfig(testConfig({ ARTIFACTS_VERSION_ID: 'sha' })).errors, [])
    assert.ok(validateConfig(testConfig({ ARTIFACTS_VERSION_ID: 'uuid' })).errors.some((e) => e.startsWith('ARTIFACTS_VERSION_ID')))
  })

  it('switches to 40-hex ids for new versions while earlier ids keep resolving', async () => {
    const before = await serviceWith({})
    const first = await before.publish({ title: 'Id formats', slug: 'id-formats', markdown: '# one' })
    assert.match(first.version.id, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/)

    const after = await serviceWith({ ARTIFACTS_VERSION_ID: 'sha' })
    const second = await after.publish({ title: 'Id formats', slug: 'id-formats', markdown: '# two' })
    assert.match(second.version.id, /^[0-9a-f]{40}$/)

    // Deterministic over slug, creation time and content: recomputable from the manifest.
    const { meta } = await after.get('id-formats')
    const stored = meta.versions[1]
    assert.equal(stored.id, contentVersionId({ slug: 'id-formats', createdAt: stored.createdAt, sha256: stored.sha256 }))

    assert.equal(after.resolveVersion(meta, first.version.id).n, 1, 'the timestamp id still resolves')
    assert.equal(after.resolveVersion(meta, second.version.id).n, 2)
    assert.equal(after.resolveVersion(meta, second.version.id.slice(0, 7)).n, 2, 'a short sha resolves like in git')
    assert.equal(after.resolveVersion(meta, '1').n, 1)
  })

  it('gives identical publishes in the same second distinct ids', async () => {
    const service = await serviceWith({ ARTIFACTS_VERSION_ID: 'sha' })
    const results = []
    for (let i = 0; i < 3; i += 1) results.push(await service.publish({ title: 'Same text', slug: 'same-text', markdown: '# same' }))
    const ids = results.map((r) => r.version.id)
    assert.equal(new Set(ids).size, 3)
    for (const id of ids) assert.match(id, /^[0-9a-f]{40}$/)
  })

  it('keeps an explicit id from another system, once', async () => {
    const service = await serviceWith({})
    const sha = '3f786850e387550fdab836ed7e6dc881de23001b'
    const imported = await service.publish({ title: 'Imported', slug: 'imported-doc', html: '<p>from git</p>', versionId: sha })
    assert.equal(imported.version.id, sha)
    const again = service.publish({ title: 'Imported', slug: 'imported-doc', html: '<p>other</p>', versionId: sha })
    await assert.rejects(again, (error) => error.status === 409 && error.code === 'version_exists')
    await assert.rejects(service.publish({ title: 'Imported', slug: 'imported-doc', html: '<p>x</p>', versionId: '123456' }), (error) => error.status === 400)
    assert.equal(isValidVersionId('12345678'), false, 'all-digit ids would read as version numbers')
    assert.equal(isValidVersionId(sha), true)
  })

  it('retries an interrupted import idempotently', async () => {
    const service = await serviceWith({})
    // Content written, manifest not: what a crash between the two writes leaves behind.
    await service.store.putVersionContent('half-imported', 'abcdef1234567', { html: '<p>v1</p>' })
    const done = await service.publish({ title: 'Half imported', slug: 'half-imported', html: '<p>v1</p>', versionId: 'abcdef1234567' })
    assert.equal(done.version.id, 'abcdef1234567')
    await service.store.putVersionContent('half-different', 'abcdef7654321', { html: '<p>stored</p>' })
    await assert.rejects(service.publish({ title: 'Half different', slug: 'half-different', html: '<p>new</p>', versionId: 'abcdef7654321' }), (error) => error.code === 'version_exists')
  })

  it('reports sha-shaped ids through the compatibility versions route', async () => {
    const app = await startApp({ ARTIFACTS_VERSION_ID: 'sha' })
    try {
      const created = await app.request('POST', '/a', { body: { title: 'Compat ids', html: '<p>x</p>' } })
      assert.match(created.data.versionInfo.sha, /^[0-9a-f]{40}$/)
      const versions = await app.request('GET', `/a/${created.data.slug}/versions`)
      assert.match(versions.data.versions[0].sha, /^[0-9a-f]{7,40}$/)
      const raw = await app.request('GET', `/a/${created.data.slug}/raw?v=${created.data.versionInfo.sha}`, { raw: true })
      assert.equal(raw.status, 200)
    } finally {
      await app.close()
    }
  })
})
