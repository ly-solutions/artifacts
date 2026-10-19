import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { copyStorage, migrateFromGit } from '../src/migrate/git.mjs'
import { ArtifactService } from '../src/service.mjs'
import { FsStorage } from '../src/storage/fs.mjs'
import { S3Storage } from '../src/storage/s3.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'
import { tempDir, testConfig } from './helpers/setup.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Publisher Bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'Publisher Bot', GIT_COMMITTER_EMAIL: 'bot@example.com' } })

function meta(fields) {
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? v : JSON.stringify(v)}`)
    .join('\n')}\n`
}

/** A repository shaped like the old store: three versions of one page, one meta-only commit, a second artifact. */
function buildRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main')
  const doc = join(dir, 'artifacts', 'checkout-review-abc123def456')
  mkdirSync(doc, { recursive: true })
  const base = { title: 'Checkout review', description: 'Why checkout failed', author: 'ada', key: 'old-share-key', public: true, task: 'PROJ-12', tags: ['incident', 'checkout'], createdAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z' }
  writeFileSync(join(doc, 'index.html'), '<h1>Checkout review</h1><p>first</p>')
  writeFileSync(join(doc, 'meta.yaml'), meta(base))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'docs(artifacts): published\n\nAuthor: ada')
  writeFileSync(join(doc, 'index.html'), '<h1>Checkout review</h1><p>second</p>')
  writeFileSync(join(doc, 'document.md'), '# Checkout review\n\nsecond')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'docs(artifacts): updated\n\nNote: added the timeline\nAuthor: grace')
  writeFileSync(join(doc, 'meta.yaml'), meta({ ...base, tags: ['incident', 'checkout', 'payments'] }))
  git(dir, 'commit', '-q', '-am', 'docs(artifacts): meta only')
  writeFileSync(join(doc, 'index.html'), '<h1>Checkout review</h1><p>third</p>')
  git(dir, 'commit', '-q', '-am', 'docs(artifacts): third, no trailers')

  const other = join(dir, 'artifacts', 'private-notes-zzz999')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'index.html'), '<!doctype html><html><body>private</body></html>')
  writeFileSync(join(other, 'meta.yaml'), meta({ title: 'Private notes', key: 'PrivKey', public: false }))
  mkdirSync(join(dir, 'artifacts', 'broken'), { recursive: true })
  writeFileSync(join(dir, 'artifacts', 'broken', 'index.html'), '<p>no meta</p>')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'docs(artifacts): private notes')
  return git(dir, 'log', '--format=%H', '--', 'artifacts/checkout-review-abc123def456/index.html').trim().split('\n').reverse()
}

describe('migrate --from-git', () => {
  let repo
  let shas
  before(async () => {
    repo = await tempDir()
    shas = buildRepo(repo.dir)
  })
  after(() => repo.cleanup())

  for (const backend of ['fs', 's3']) {
    it(`replays the history into ${backend}, keeping authors, notes, shas and shared links`, async () => {
      const target = await tempDir()
      const fake = backend === 's3' ? await startFakeS3() : null
      const storage = backend === 's3' ? new S3Storage({ ...fake.settings, prefix: 'migrated/' }) : new FsStorage({ dir: target.dir })
      try {
        const report = await migrateFromGit({ repo: repo.dir, storage })
        assert.equal(report.artifacts, 2)
        assert.equal(report.versions, 4)
        assert.deepEqual(report.skipped.map((s) => s.slug), ['broken'])

        const service = await new ArtifactService({ storage, config: testConfig() }).init()
        const { meta: doc } = await service.get('checkout-review-abc123def456')
        assert.equal(doc.title, 'Checkout review')
        assert.equal(doc.task, 'PROJ-12')
        assert.deepEqual(doc.tags, ['incident', 'checkout', 'payments'])
        assert.equal(doc.createdAt, '2026-07-01T10:00:00Z')
        assert.deepEqual(doc.versions.map((v) => v.id), shas, 'the meta-only commit is not a version')
        assert.deepEqual(doc.versions.map((v) => v.author), ['ada', 'grace', 'Publisher Bot'])
        assert.deepEqual(doc.versions.map((v) => v.note), [null, 'added the timeline', null])
        assert.deepEqual(doc.versions.map((v) => v.markdown), [false, true, true])

        const second = await service.readContent('checkout-review-abc123def456', shas[1].slice(0, 7))
        assert.equal(second.n, 2)
        assert.match(second.html, /second/)
        assert.match(second.markdown, /second/)
        assert.ok(service.legacyKeyMatches(doc, 'old-share-key'))
        assert.equal(service.legacyKeyMatches(doc, 'wrong'), false)

        const { meta: priv } = await service.get('private-notes-zzz999')
        assert.equal(priv.public, false)
        assert.equal(service.legacyKeyMatches(priv, 'PrivKey'), false, 'a private document keeps no old link')
        assert.equal((await service.search({ q: 'timeline' })).total, 0)
        assert.equal((await service.search({ q: 'third' })).items[0].slug, 'checkout-review-abc123def456')

        const again = await migrateFromGit({ repo: repo.dir, storage })
        assert.equal(again.artifacts, 0, 'a second run skips what is there')
        const overwrite = await migrateFromGit({ repo: repo.dir, storage, overwrite: true })
        assert.equal(overwrite.artifacts, 2, '--overwrite replaces manifests; version objects are reused')
      } finally {
        await fake?.close()
        await target.cleanup()
      }
    })
  }

  it('supports a dry run and a subset', async () => {
    const target = await tempDir()
    try {
      const storage = new FsStorage({ dir: target.dir })
      const report = await migrateFromGit({ repo: repo.dir, storage, dryRun: true, only: ['private-notes-zzz999'] })
      assert.equal(report.artifacts, 1)
      const keys = []
      for await (const item of storage.list('')) keys.push(item.key)
      assert.deepEqual(keys, [])
    } finally {
      await target.cleanup()
    }
  })

  it('copies a whole store between backends', async () => {
    const a = await tempDir()
    const fake = await startFakeS3()
    try {
      const from = new FsStorage({ dir: a.dir })
      await migrateFromGit({ repo: repo.dir, storage: from })
      const to = new S3Storage({ ...fake.settings })
      const result = await copyStorage({ from, to })
      assert.ok(result.copied >= 7)
      const service = await new ArtifactService({ storage: to, config: testConfig() }).init()
      assert.equal((await service.get('checkout-review-abc123def456')).meta.versions.length, 3)
    } finally {
      await fake.close()
      await a.cleanup()
    }
  })
})
