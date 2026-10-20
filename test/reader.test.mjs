import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { validateConfig } from '../src/config.mjs'
import { fillUrlTemplate } from '../src/text.mjs'
import { READ_TOKEN, TOKEN, startApp, testConfig } from './helpers/setup.mjs'

const READER = 'https://reader.example.com/docs/{slug}?v={version}&n={n}'
const browser = { accept: 'text/html,application/xhtml+xml' }

describe('URL templates', () => {
  it('fills placeholders and drops parameters left empty', () => {
    assert.equal(fillUrlTemplate(READER, { slug: 'a-doc', version: 'abc1234', n: '2' }), 'https://reader.example.com/docs/a-doc?v=abc1234&n=2')
    assert.equal(fillUrlTemplate(READER, { slug: 'a-doc' }), 'https://reader.example.com/docs/a-doc')
    assert.equal(fillUrlTemplate('https://r.example.com/{slug}?mode=view&v={version}#top', { slug: 'x' }), 'https://r.example.com/x?mode=view#top')
    assert.equal(fillUrlTemplate('https://r.example.com/{slug}', { slug: 'a b/c' }), 'https://r.example.com/a%20b%2Fc')
  })

  it('validates the reader settings', () => {
    assert.deepEqual(validateConfig(testConfig({ ARTIFACTS_READER_URL: READER })).errors, [])
    assert.ok(validateConfig(testConfig({ ARTIFACTS_READER_URL: 'https://reader.example.com/docs' })).errors.some((e) => e.includes('{slug}')))
    assert.ok(validateConfig(testConfig({ ARTIFACTS_READER_URL: 'javascript:alert(1)//{slug}' })).errors.some((e) => e.startsWith('ARTIFACTS_READER_URL')))
    assert.ok(validateConfig(testConfig({ ARTIFACTS_READER_REDIRECT: 'everyone' })).errors.some((e) => e.startsWith('ARTIFACTS_READER_REDIRECT')))
  })
})

describe('external reader', () => {
  let app
  let ids
  before(async () => {
    app = await startApp({ ARTIFACTS_READER_URL: READER })
    await app.service.publish({ title: 'Read elsewhere', slug: 'read-elsewhere', markdown: '# one' })
    await app.service.publish({ title: 'Read elsewhere', slug: 'read-elsewhere', markdown: '# two' })
    ids = (await app.service.get('read-elsewhere')).meta.versions.map((v) => v.id)
  })
  after(() => app.close())

  it('sends anonymous browsers to the reader, with the version resolved to its id', async () => {
    const plain = await app.request('GET', '/a/read-elsewhere', { token: null, raw: true, headers: browser })
    assert.equal(plain.status, 302)
    assert.equal(plain.headers.get('location'), 'https://reader.example.com/docs/read-elsewhere')
    const byNumber = await app.request('GET', '/a/read-elsewhere?v=1', { token: null, raw: true, headers: browser })
    assert.equal(byNumber.headers.get('location'), `https://reader.example.com/docs/read-elsewhere?v=${ids[0]}&n=1`)
    const unknown = await app.request('GET', '/a/no-such-doc?v=xyz', { token: null, raw: true, headers: browser })
    assert.equal(unknown.headers.get('location'), 'https://reader.example.com/docs/no-such-doc?v=xyz', 'the reader reports what does not exist')
  })

  it('leaves API clients, signed-in people, content and embeds alone', async () => {
    assert.equal((await app.request('GET', '/a/read-elsewhere', { token: READ_TOKEN, raw: true, headers: browser })).status, 200, 'bearer clients get the page')
    assert.equal((await app.request('GET', '/a/read-elsewhere', { token: null, raw: true, headers: { accept: 'application/json' } })).status, 401)
    assert.equal((await app.request('GET', '/a/read-elsewhere/raw', { token: READ_TOKEN, raw: true, headers: browser })).status, 200)
    assert.equal((await app.request('GET', '/a/read-elsewhere/versions', { token: null })).status, 401)
    assert.equal((await app.request('GET', '/embed/read-elsewhere', { token: null, raw: true, headers: browser })).status, 401)

    const login = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}&next=/` })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const signedIn = await app.request('GET', '/a/read-elsewhere', { token: null, raw: true, headers: { ...browser, cookie } })
    assert.equal(signedIn.status, 200, 'a person signed in here keeps this reader')
  })

  it('points viewUrl at the reader', async () => {
    const res = await app.request('GET', '/api/v1/artifacts/read-elsewhere')
    assert.equal(res.data.artifact.viewUrl, 'https://reader.example.com/docs/read-elsewhere')
    assert.equal(res.data.artifact.embedUrl, 'http://artifacts.test/embed/read-elsewhere')
    const legacy = await app.request('POST', '/a', { body: { title: 'Legacy reader link', html: '<p>x</p>' } })
    assert.equal(legacy.data.viewUrl, `https://reader.example.com/docs/${legacy.data.slug}`)
  })

  it('keeps ?k= links of shared documents on this server', async () => {
    await app.service.store.putManifest({ ...(await app.service.get('read-elsewhere')).meta, public: true, share: { gen: 1, legacyKey: 'old-key-123' } }, (await app.service.get('read-elsewhere')).etag)
    const keyed = await app.request('GET', '/a/read-elsewhere?k=old-key-123', { token: null, raw: true, headers: browser })
    assert.equal(keyed.status, 200)
    const wrongKey = await app.request('GET', '/a/read-elsewhere?k=nope', { token: null, raw: true, headers: browser })
    assert.equal(wrongKey.status, 302)
  })

  it('can send every browser there', async () => {
    const all = await startApp({ ARTIFACTS_READER_URL: READER, ARTIFACTS_READER_REDIRECT: 'browsers' })
    try {
      await all.service.publish({ title: 'All browsers', slug: 'all-browsers', markdown: '# x' })
      const login = await fetch(`${all.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}&next=/` })
      const cookie = login.headers.get('set-cookie').split(';')[0]
      assert.equal((await all.request('GET', '/a/all-browsers', { token: null, raw: true, headers: { ...browser, cookie } })).status, 302)
      assert.equal((await all.request('GET', '/a/all-browsers', { raw: true, headers: browser })).status, 200, 'bearer clients still get the page')
    } finally {
      await all.close()
    }
  })
})

describe('without a reader', () => {
  it('keeps today’s behaviour', async () => {
    const app = await startApp()
    try {
      await app.service.publish({ title: 'Here', slug: 'read-here', markdown: '# x' })
      const res = await app.request('GET', '/a/read-here', { token: null, raw: true, headers: browser })
      assert.equal(res.status, 302)
      assert.equal(res.headers.get('location'), '/login?next=%2Fa%2Fread-here')
    } finally {
      await app.close()
    }
  })
})
