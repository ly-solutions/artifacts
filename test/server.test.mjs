import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { validateConfig } from '../src/config.mjs'
import { redactPath } from '../src/server.mjs'
import { READ_TOKEN, TOKEN, startApp, testConfig } from './helpers/setup.mjs'

describe('HTTP API (token auth)', () => {
  let app
  before(async () => {
    app = await startApp({ ARTIFACTS_FRAME_ANCESTORS: 'https://workspace.example.com', ARTIFACTS_CORS_ORIGINS: 'https://workspace.example.com', ARTIFACTS_SESSION_URL: 'https://workspace.example.com/c/{session}' })
  })
  after(() => app.close())

  it('serves health and readiness without auth', async () => {
    assert.equal((await app.request('GET', '/healthz', { token: null, raw: true })).status, 200)
    assert.equal((await app.request('GET', '/readyz', { token: null, raw: true })).status, 200)
  })

  it('runs the publish → version → read → share round trip', async () => {
    const created = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Round trip', html: '<h1>Round trip</h1><p>first</p>', tags: ['demo'], session: 'conv-42' } })
    assert.equal(created.status, 201)
    const slug = created.data.artifact.slug
    assert.equal(created.data.version.n, 1)
    assert.equal(created.data.artifact.viewUrl, `http://artifacts.test/a/${slug}`)
    assert.equal(created.data.artifact.sessionUrl, 'https://workspace.example.com/c/conv-42')

    const updated = await app.request('POST', '/api/v1/artifacts', { body: { slug, title: 'Round trip', markdown: '# Round trip\n\nsecond', note: 'rewrote in Markdown' } })
    assert.equal(updated.status, 200)
    assert.equal(updated.data.version.n, 2)

    const versions = await app.request('GET', `/api/v1/artifacts/${slug}/versions`)
    assert.deepEqual(versions.data.versions.map((v) => v.n), [2, 1])
    assert.deepEqual(versions.data.versions[0].formats, ['markdown'])

    const v1 = await app.request('GET', `/api/v1/artifacts/${slug}/content?v=1`, { raw: true })
    assert.match(v1.text, /first/)
    assert.equal(v1.headers.get('content-type'), 'text/plain; charset=utf-8')
    const md = await app.request('GET', `/api/v1/artifacts/${slug}/content?format=markdown`, { raw: true })
    assert.match(md.text, /second/)

    const raw = await app.request('GET', `/a/${slug}/raw?v=2`, { raw: true })
    assert.equal(raw.status, 200)
    assert.match(raw.text, /<p>second<\/p>/)
    const csp = raw.headers.get('content-security-policy')
    assert.match(csp, /^sandbox allow-scripts/)
    assert.doesNotMatch(csp, /allow-same-origin/)
    assert.match(csp, /frame-ancestors 'self' https:\/\/workspace\.example\.com/)
    assert.match(csp, /connect-src 'none'/)
    assert.match(csp, /frame-src 'none'/)

    const shared = await app.request('POST', `/api/v1/artifacts/${slug}/share`, { body: { expiresIn: '7d' } })
    assert.equal(shared.status, 200)
    const path = new URL(shared.data.url).pathname
    assert.match(path, /^\/s\/[\w-]+\.[\w-]+$/)
    const page = await app.request('GET', path, { token: null, raw: true })
    assert.equal(page.status, 200)
    assert.match(page.text, /Round trip/)
    assert.doesNotMatch(page.text, /data-open="share-dialog"/)
    const sharedRaw = await app.request('GET', `${path}/raw`, { token: null, raw: true })
    assert.match(sharedRaw.text, /second/)

    await app.request('DELETE', `/api/v1/artifacts/${slug}/share`)
    assert.equal((await app.request('GET', path, { token: null, raw: true })).status, 404)
    assert.equal((await app.request('GET', `${path}/raw`, { token: null, raw: true })).status, 404)
  })

  it('separates read and write tokens', async () => {
    assert.equal((await app.request('GET', '/api/v1/artifacts', { token: null })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/artifacts', { token: 'wrong-token-0123456789' })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/artifacts', { token: READ_TOKEN })).status, 200)
    const denied = await app.request('POST', '/api/v1/artifacts', { token: READ_TOKEN, body: { title: 'Nope', html: '<p>x</p>' } })
    assert.equal(denied.status, 403)
    assert.equal((await app.request('GET', '/api/v1/whoami', { token: READ_TOKEN })).data.role, 'viewer')
  })

  it('explains bad requests', async () => {
    const bad = await app.request('POST', '/api/v1/artifacts', { body: { title: 'x', slug: 'Bad Slug' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.data.error, 'invalid')
    assert.ok(bad.data.problems.length >= 2)
    assert.equal((await app.request('POST', '/api/v1/artifacts', { body: '{not json' })).status, 400)
    assert.equal((await app.request('POST', '/api/v1/artifacts', { body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await app.request('GET', '/api/v1/artifacts/missing-doc')).status, 404)
  })

  it('redirects browsers without a session to sign in, and signs in with a token', async () => {
    const page = await fetch(`${app.base}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), '/login?next=%2F')

    const wrong = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nope&next=/' })
    assert.equal(wrong.status, 401)

    const login = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}&next=%2F%2Fevil.example.com` })
    assert.equal(login.status, 303)
    assert.equal(login.headers.get('location'), '/', 'open redirects are refused')
    const cookie = login.headers.get('set-cookie')
    assert.match(cookie, /artifacts_session=.*HttpOnly; SameSite=Lax/)
    const session = cookie.split(';')[0]

    const catalog = await fetch(`${app.base}/`, { headers: { cookie: session, accept: 'text/html' } })
    assert.equal(catalog.status, 200)
    const csp = catalog.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    const html = await catalog.text()
    assert.match(html, /class="wordmark"/)

    // A cookie-authenticated write from another site is refused; from our own origin it passes.
    const created = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Cookie target', html: '<p>x</p>', slug: 'cookie-target' } })
    assert.equal(created.status, 201)
    const cross = await fetch(`${app.base}/api/v1/artifacts/cookie-target`, { method: 'PATCH', headers: { cookie: session, 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: '{"title":"pwned"}' })
    assert.equal(cross.status, 403)
    const same = await fetch(`${app.base}/api/v1/artifacts/cookie-target`, { method: 'PATCH', headers: { cookie: session, 'content-type': 'application/json', origin: 'http://artifacts.test' }, body: '{"title":"Renamed"}' })
    assert.equal(same.status, 200)
  })

  it('serves the reader, the embed view with configured frame ancestors, and the partial list', async () => {
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Reader target', markdown: '# Reader target\n\ntext', slug: 'reader-target' } })
    const reader = await app.request('GET', '/a/reader-target', { raw: true, headers: { accept: 'text/html' } })
    assert.equal(reader.status, 200)
    assert.match(reader.text, /<iframe class="content" src="\/a\/reader-target\/raw\?v=1"/)
    assert.match(reader.text, /data-open="share-dialog"/)
    assert.match(reader.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    const embed = await app.request('GET', '/embed/reader-target', { raw: true, headers: { accept: 'text/html' } })
    assert.match(embed.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/workspace\.example\.com/)
    assert.doesNotMatch(embed.text, /data-open="share-dialog"/)
    const partial = await app.request('GET', '/?q=reader&partial=1', { raw: true })
    assert.match(partial.text, /href="\/a\/reader-target"/)
    assert.doesNotMatch(partial.text, /<html/)
    const anonymousEmbed = await app.request('GET', '/embed/reader-target', { token: null, raw: true, headers: { accept: 'text/html' } })
    assert.equal(anonymousEmbed.status, 401, 'an embed never redirects to the identity provider inside the frame')
    assert.match(anonymousEmbed.text, /data-auth-required/)
    assert.match(anonymousEmbed.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/workspace\.example\.com/)
    const read = await app.request('GET', '/a/reader-target', { token: READ_TOKEN, raw: true, headers: { accept: 'text/html' } })
    assert.doesNotMatch(read.text, /data-open="share-dialog"/, 'viewers get no edit controls')
  })

  it('answers CORS preflight only for configured origins', async () => {
    const ok = await fetch(`${app.base}/api/v1/artifacts`, { method: 'OPTIONS', headers: { origin: 'https://workspace.example.com', 'access-control-request-method': 'GET' } })
    assert.equal(ok.status, 204)
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://workspace.example.com')
    const other = await fetch(`${app.base}/api/v1/artifacts`, { headers: { origin: 'https://evil.example.com', authorization: `Bearer ${TOKEN}` } })
    assert.equal(other.headers.get('access-control-allow-origin'), null)
  })

  it('serves fonts to sandboxed documents', async () => {
    const font = await fetch(`${app.base}/static/fonts/geist-400.woff2`)
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('access-control-allow-origin'), '*')
    assert.equal((await fetch(`${app.base}/static/../package.json`)).status, 404)
  })

  it('keeps the previous contract: POST /a and PATCH /a/{slug}', async () => {
    const created = await app.request('POST', '/a', { body: { title: 'Legacy publish', html: '<p>legacy</p>', task: 'PROJ-7', rotateKey: true } })
    assert.equal(created.status, 201)
    assert.equal(created.data.created, true)
    assert.equal(created.data.versionInfo.n, 1)
    assert.equal(created.data.version, created.data.versionInfo.sha)
    assert.equal(created.data.public, false)
    const patched = await app.request('PATCH', `/a/${created.data.slug}`, { body: { public: true, tags: ['x'] } })
    assert.equal(patched.status, 200)
    assert.equal(patched.data.ok, true)
    assert.match(patched.data.publicUrl, /\/s\//)
    const versions = await app.request('GET', `/a/${created.data.slug}/versions`)
    assert.equal(versions.data.versions[0].sha, created.data.version)
  })

  it('redacts share tokens from logged paths', () => {
    assert.equal(redactPath('/s/abc.def/raw?v=1'), '/s/***/raw')
    assert.equal(redactPath('/a/x/raw?k=secret'), '/a/x/raw')
  })
})

describe('content policy', () => {
  it('lets documents frame the origins in ARTIFACTS_CONTENT_FRAME_SRC', async () => {
    const app = await startApp({ ARTIFACTS_CONTENT_FRAME_SRC: 'https://boards.example.com, https://video.example.com/embed/' })
    try {
      await app.request('POST', '/api/v1/artifacts', { body: { title: 'With a board', slug: 'with-a-board', html: '<iframe src="https://boards.example.com/b/x"></iframe>' } })
      const raw = await app.request('GET', '/a/with-a-board/raw', { raw: true })
      const csp = raw.headers.get('content-security-policy')
      assert.match(csp, /frame-src https:\/\/boards\.example\.com https:\/\/video\.example\.com\/embed\/;/)
      assert.match(csp, /^sandbox allow-scripts/, 'the document stays sandboxed')
    } finally {
      await app.close()
    }
  })

  it('refuses a source that would inject a directive', () => {
    const { errors } = validateConfig(testConfig({ ARTIFACTS_CONTENT_FRAME_SRC: "https://ok.example.com,https://x.example.com; script-src *" }))
    assert.ok(errors.some((e) => e.startsWith('ARTIFACTS_CONTENT_FRAME_SRC')))
    assert.deepEqual(validateConfig(testConfig({ ARTIFACTS_CONTENT_FRAME_SRC: "'self',https://ok.example.com/path/" })).errors, [])
  })
})

describe('HTTP API (proxy auth)', () => {
  let app
  before(async () => {
    app = await startApp({ ARTIFACTS_AUTH: 'proxy', ARTIFACTS_EDITORS: 'ada@example.com', ARTIFACTS_PROXY_TRUSTED_CIDRS: '127.0.0.1/32,::1/128' })
  })
  after(() => app.close())

  it('trusts the user header from a trusted address and maps roles', async () => {
    const ada = await app.request('GET', '/api/v1/whoami', { token: null, headers: { 'x-forwarded-user': 'ada', 'x-forwarded-email': 'ada@example.com' } })
    assert.deepEqual([ada.data.name, ada.data.role], ['ada', 'editor'])
    const bob = await app.request('GET', '/api/v1/whoami', { token: null, headers: { 'x-forwarded-user': 'bob' } })
    assert.equal(bob.data.role, 'viewer')
    const nobody = await app.request('GET', '/api/v1/artifacts', { token: null })
    assert.equal(nobody.status, 401)
  })

  it('ignores the header from an untrusted address', async () => {
    const strict = await startApp({ ARTIFACTS_AUTH: 'proxy', ARTIFACTS_PROXY_TRUSTED_CIDRS: '10.0.0.0/8' })
    try {
      const response = await strict.request('GET', '/api/v1/artifacts', { token: null, headers: { 'x-forwarded-user': 'mallory' } })
      assert.equal(response.status, 401)
    } finally {
      await strict.close()
    }
  })
})

describe('HTTP API (no auth)', () => {
  it('lets anyone read and publish, for local use', async () => {
    const app = await startApp({ ARTIFACTS_AUTH: 'none', ARTIFACTS_TOKEN: '' })
    try {
      const created = await app.request('POST', '/api/v1/artifacts', { token: null, body: { title: 'Open', html: '<p>x</p>' } })
      assert.equal(created.status, 201)
      assert.equal((await app.request('GET', '/', { token: null, raw: true, headers: { accept: 'text/html' } })).status, 200)
    } finally {
      await app.close()
    }
  })
})
