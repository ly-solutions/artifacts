import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { validateConfig } from '../src/config.mjs'
import { READ_TOKEN, TOKEN, startApp, testConfig } from './helpers/setup.mjs'

const SHARE_TOKEN = 'sharer-token-0123456789abcdef'

describe('access route', () => {
  let app
  before(async () => {
    app = await startApp({ ARTIFACTS_SHARE_TOKEN: SHARE_TOKEN })
    await app.service.publish({ title: 'Access target', slug: 'access-target', markdown: '# Access target\n\nsecret plan' })
    await app.service.publish({ title: 'Other doc', slug: 'other-doc', markdown: '# Other' })
  })
  after(() => app.close())

  it('tells a viewer it may read and hands out a short-lived read link', async () => {
    const res = await app.request('GET', '/api/v1/artifacts/access-target/access', { token: READ_TOKEN })
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.access, { read: true, write: false, share: false, via: 'bearer' })
    assert.equal(res.data.public, false)
    assert.equal(res.data.publicUrl, undefined)
    const expires = Date.parse(res.data.readLink.expiresAt) - Date.now()
    assert.ok(expires > 14 * 60_000 && expires <= 15 * 60_000 + 1000, 'valid for ARTIFACTS_READ_LINK_TTL')
    // The read link opens the document though it is not shared, and only that document.
    const page = await app.request('GET', new URL(res.data.readLink.url).pathname + '/raw', { token: null, raw: true })
    assert.equal(page.status, 200)
    assert.match(page.text, /secret plan/)
  })

  it('lets the sharer turn sharing on and off, without reading', async () => {
    const opened = await app.request('PUT', '/a/access-target/access', { token: SHARE_TOKEN, body: { public: true, title: 'ignored' } })
    assert.equal(opened.status, 200)
    assert.equal(opened.data.public, true)
    assert.deepEqual(opened.data.access, { read: false, write: false, share: true, via: 'bearer' })
    assert.match(opened.data.publicUrl, /^http:\/\/artifacts\.test\/s\//)
    assert.equal(opened.data.readLink, undefined, 'a sharer cannot read')
    assert.equal((await app.service.get('access-target')).meta.title, 'Access target', 'only `public` is applied')

    const shareUrl = opened.data.publicUrl
    assert.equal((await app.request('GET', new URL(shareUrl).pathname, { token: null, raw: true })).status, 200)

    // The sharer's token reads nothing.
    assert.equal((await app.request('GET', '/api/v1/artifacts/access-target', { token: SHARE_TOKEN })).status, 401)
    assert.equal((await app.request('GET', '/a/access-target/raw', { token: SHARE_TOKEN, raw: true })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/artifacts', { token: SHARE_TOKEN })).status, 401)
    assert.equal((await app.request('POST', '/api/v1/artifacts', { token: SHARE_TOKEN, body: { title: 'No', html: '<p>x</p>' } })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/whoami', { token: SHARE_TOKEN })).data.role, 'sharer')

    const closed = await app.request('PUT', '/api/v1/artifacts/access-target/access', { token: SHARE_TOKEN, body: { public: false } })
    assert.equal(closed.data.public, false)
    assert.equal((await app.request('GET', new URL(shareUrl).pathname, { token: null, raw: true })).status, 404, 'closing revokes the link')
  })

  it('gives a share-link holder read access and a read link, and refuses a wrong link like a missing document', async () => {
    const { url } = await app.service.share('access-target')
    const byHeader = await app.request('GET', '/a/access-target/access', { token: null, headers: { 'x-artifacts-share': url } })
    assert.equal(byHeader.status, 200)
    assert.deepEqual(byHeader.data.access, { read: true, write: false, share: false, via: 'link' })
    assert.equal(byHeader.data.publicUrl, undefined, 'a holder gets a read link, not a new share link')
    assert.ok(byHeader.data.readLink.token)
    const token = new URL(url).pathname.split('/')[2]
    assert.equal((await app.request('GET', `/a/access-target/access?share=${token}`, { token: null })).status, 200)

    assert.equal((await app.request('GET', '/a/other-doc/access', { token: null, headers: { 'x-artifacts-share': url } })).status, 404, 'a link opens only its own document')
    assert.equal((await app.request('GET', '/a/access-target/access', { token: null, headers: { 'x-artifacts-share': 'bad.token' } })).status, 404)
    assert.equal((await app.request('GET', '/a/no-such-doc/access', { token: null, headers: { 'x-artifacts-share': url } })).status, 404)
    assert.equal((await app.request('GET', '/a/access-target/access', { token: null })).status, 401)

    // Turning sharing off kills the read links handed out before.
    const readLink = byHeader.data.readLink.url
    await app.service.unshare('access-target')
    assert.equal((await app.request('GET', new URL(readLink).pathname, { token: null, raw: true })).status, 404)
  })

  it('reports editors in full and refuses viewers on PUT', async () => {
    const editor = await app.request('GET', '/api/v1/artifacts/access-target/access')
    assert.deepEqual(editor.data.access, { read: true, write: true, share: true, via: 'bearer' })
    const denied = await app.request('PUT', '/a/access-target/access', { token: READ_TOKEN, body: { public: true } })
    assert.equal(denied.status, 403)
    assert.equal((await app.request('PUT', '/a/access-target/access', { token: null, body: { public: true } })).status, 401)
    assert.equal((await app.request('PUT', '/a/access-target/access', { token: SHARE_TOKEN, body: { public: 'yes' } })).status, 400)
    assert.equal((await app.request('PUT', '/a/missing-doc/access', { token: SHARE_TOKEN, body: { public: true } })).status, 404)
    assert.equal((await app.request('DELETE', '/a/access-target/access', { token: SHARE_TOKEN })).status, 405)
  })

  it('lets the sharer use the share endpoints too, and keeps it off the sign-in form', async () => {
    const shared = await app.request('POST', '/api/v1/artifacts/other-doc/share', { token: SHARE_TOKEN, body: {} })
    assert.equal(shared.status, 200)
    assert.equal((await app.request('DELETE', '/api/v1/artifacts/other-doc/share', { token: SHARE_TOKEN })).status, 200)
    assert.equal((await app.request('POST', '/api/v1/artifacts/other-doc/share', { token: READ_TOKEN, body: {} })).status, 403)
    const login = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${SHARE_TOKEN}&next=/` })
    assert.equal(login.status, 401)
    const editorLogin = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}&next=/` })
    assert.equal(editorLogin.status, 303)
  })

  it('validates the settings', () => {
    assert.ok(validateConfig(testConfig({ ARTIFACTS_SHARE_TOKEN: 'short' })).errors.some((e) => e.includes('ARTIFACTS_SHARE_TOKEN')))
    assert.ok(validateConfig(testConfig({ ARTIFACTS_READ_LINK_TTL: '30d' })).errors.some((e) => e.startsWith('ARTIFACTS_READ_LINK_TTL')))
    assert.deepEqual(validateConfig(testConfig({ ARTIFACTS_READ_LINK_TTL: '1h', ARTIFACTS_SHARE_TOKEN: SHARE_TOKEN })).errors, [])
  })
})
