import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { startApp } from './helpers/setup.mjs'

const ACCESS_TOKEN = 'hub-docs-token-0123456789'
const ORIGIN = 'http://artifacts.test'

/** A fake hub: keys, rights, and the document routes of the contract (HRN-1478), recording what it was asked. */
async function startHub() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url').slice(0, 16)
  const hub = { calls: [], rights: {}, trashed: new Set(), fail: null }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub')
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (url.pathname === '/.well-known/jwks.json') return reply(200, { keys: [{ ...jwk, kid, use: 'sig', alg: 'EdDSA' }] })
    if (url.pathname === '/.well-known/openid-configuration') return reply(404, {})
    if (url.pathname === '/api/platform/docs/_rights') {
      const person = hub.rights[body.sub] ?? {}
      return reply(200, { rights: Object.fromEntries(body.slugs.map((slug) => [slug, hub.trashed.has(slug) ? 'none' : (person[slug] ?? 'none')])) })
    }
    if (url.pathname.startsWith('/api/platform/docs')) {
      hub.calls.push({ method: req.method, path: url.pathname.slice('/api/platform/docs'.length), authorization: req.headers.authorization, token: req.headers['x-harnessly-token'], body })
      if (hub.fail) return reply(hub.fail.status, hub.fail.body)
      return hub.docs(req.method, url.pathname.slice('/api/platform/docs'.length), body, reply)
    }
    reply(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  hub.issuer = `http://127.0.0.1:${server.address().port}`
  hub.token = (claims = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'harnessly-app+jwt', kid })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iss: hub.issuer, aud: ORIGIN, sub: 'u-ada', email: 'ada@example.com', name: 'Ada', iat: now, nbf: now, exp: now + 300, ...claims })).toString('base64url')
    return `${head}.${payload}.${signBytes(null, Buffer.from(`${head}.${payload}`), privateKey).toString('base64url')}`
  }
  hub.close = () => new Promise((resolve) => server.close(resolve))
  return hub
}

describe('documents made and trashed through the hub', () => {
  let hub
  let app
  let cookie
  const appToken = () => hub.token()
  const own = (method, path, body) => app.request(method, path, { token: null, body, headers: { cookie, origin: ORIGIN } })

  before(async () => {
    hub = await startHub()
    hub.docs = async (method, path, body, reply) => {
      if (method === 'POST' && path === '') {
        const made = await app.service.publish({ title: body.title ?? 'Заметки встречи', markdown: body.markdown ?? `# ${body.title ?? 'Заметки встречи'}\n`, new: true }, { name: 'hub', role: 'editor', via: 'bearer' })
        hub.rights['u-ada'][made.meta.slug] = 'edit'
        return reply(201, { doc: { slug: made.meta.slug, title: made.meta.title, kind: 'artifact' } })
      }
      if (method === 'DELETE') {
        hub.trashed.add(path.slice(1))
        return reply(200, { slug: path.slice(1), kind: 'artifact', trashedAt: new Date().toISOString(), trashedBy: 'Ada' })
      }
      if (method === 'POST' && path.endsWith('/restore')) {
        hub.trashed.delete(path.split('/')[1])
        return reply(200, { doc: { slug: path.split('/')[1], kind: 'artifact' } })
      }
      if (method === 'GET' && path === '/_trash') return reply(200, { docs: [...hub.trashed].map((slug) => ({ slug, kind: 'artifact', title: slug })).concat([{ slug: 'a-board', kind: 'board', title: 'Board' }]) })
      if (method === 'PATCH') return reply(200, { doc: { slug: path.slice(1), title: body.title } })
      return reply(404, { error: 'not_found' })
    }
    hub.rights['u-ada'] = {}
    app = await startApp({ ARTIFACTS_AUTH: 'harnessly', ARTIFACTS_HARNESSLY_ISSUER: hub.issuer, ARTIFACTS_HARNESSLY_ACCESS_TOKEN: ACCESS_TOKEN, ARTIFACTS_APP_VIEW: 'true' })
    // the agent asks for a pass with the person's app token; the page posts it and gets the session cookie
    const mcp = await app.request('POST', '/mcp', { token: appToken(), body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doc_signin', arguments: {} } }, headers: { accept: 'application/json, text/event-stream' } })
    const pass = mcp.data.result.structuredContent.pass
    assert.ok(pass, JSON.stringify(mcp.data))
    const entered = await app.request('POST', '/app/enter', { token: null, body: { t: pass }, headers: { origin: ORIGIN }, raw: true })
    assert.equal(entered.status, 200, entered.text)
    cookie = entered.headers.get('set-cookie').split(';')[0]
  })
  after(async () => {
    await app.close()
    await hub.close()
  })

  it('makes a document through the hub as the person, with both tokens', async () => {
    const made = await own('POST', '/app/docs', { template: 'meeting' })
    assert.equal(made.status, 201, made.text)
    assert.ok(made.data.slug)
    const call = hub.calls.at(-1)
    assert.equal(call.method, 'POST')
    assert.equal(call.authorization, `Bearer ${ACCESS_TOKEN}`)
    assert.ok(call.token && call.token.split('.').length === 3, 'the person\'s app token goes on')
    assert.equal(call.body.template, 'meeting')
    assert.equal(call.body.kind, 'artifact')
    const list = await own('GET', '/app/docs')
    assert.equal(list.data.canCreate, true)
    assert.equal(list.data.hub, true)
    assert.ok(list.data.items.some((item) => item.slug === made.data.slug))
  })

  it('tells the hub\'s refusal in its words and asks to sign in again when the token is no good', async () => {
    hub.fail = { status: 400, body: { error: 'space_required', message: 'Вы в нескольких пространствах: укажите spaceId — a1 (Одно), b2 (Другое)' } }
    const refused = await own('POST', '/app/docs', { title: 'X' })
    assert.equal(refused.status, 400)
    assert.equal(refused.data.error, 'space_required')
    assert.match(refused.data.hint, /a1 \(Одно\)/)
    hub.fail = { status: 401, body: { error: 'unauthenticated' } }
    assert.equal((await own('POST', '/app/docs', { title: 'X' })).status, 401)
    hub.fail = null
  })

  it('puts a document into the trash, lists it there, and brings it back', async () => {
    const slug = (await own('POST', '/app/docs', { title: 'Временный' })).data.slug
    const trashed = await own('DELETE', `/app/doc?slug=${slug}`)
    assert.equal(trashed.status, 200, trashed.text)
    assert.equal(trashed.data.trashed, true)
    assert.equal(hub.calls.at(-1).method, 'DELETE')
    // nothing is deleted here: the service token still reads it, the person's lists do not
    assert.equal((await app.request('GET', `/api/v1/artifacts/${slug}`)).status, 200)
    assert.ok(!(await own('GET', '/app/docs')).data.items.some((item) => item.slug === slug))
    const bin = await own('GET', '/app/trash')
    assert.deepEqual(bin.data.docs.map((d) => d.slug), [slug])
    const back = await own('POST', '/app/trash/restore', { slug })
    assert.equal(back.status, 200, back.text)
    assert.ok((await own('GET', '/app/docs')).data.items.some((item) => item.slug === slug))
  })

  it('renames through the hub and keeps the title here', async () => {
    const slug = (await own('POST', '/app/docs', { title: 'Старое' })).data.slug
    const renamed = await own('PATCH', '/app/doc', { slug, title: 'Новое' })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(hub.calls.at(-1).method, 'PATCH')
    assert.equal(hub.calls.at(-1).body.title, 'Новое')
    assert.equal((await app.request('GET', `/api/v1/artifacts/${slug}`)).data.artifact.title, 'Новое')
  })
})

describe('the trash for a person who signed in directly', () => {
  let app
  const sso = { 'x-forwarded-user': 'sso-person', 'x-forwarded-email': 'p@example.com' }
  before(async () => {
    app = await startApp({ ARTIFACTS_AUTH: 'proxy' })
  })
  after(() => app.close())

  it('answers 404 for a trashed document, takes it out of the lists, and returns it when the hub says so', async () => {
    const made = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Корзинный', markdown: '# Корзинный\n\nтекст' } })
    const slug = made.data.artifact.slug
    const read = () => app.request('GET', `/api/v1/artifacts/${slug}`, { token: null, headers: sso })
    assert.equal((await read()).status, 200)
    assert.equal((await app.request('POST', `/api/v1/artifacts/${slug}/trash`, { body: { trashed: true, by: 'Ada' } })).status, 200)
    assert.equal((await read()).status, 404)
    assert.equal((await app.request('GET', `/a/${slug}/raw`, { token: null, headers: sso, raw: true })).status, 404)
    const list = await app.request('GET', '/api/v1/artifacts', { token: null, headers: sso })
    assert.ok(!list.data.items.some((item) => item.slug === slug))
    // a service token still sees it
    assert.equal((await app.request('GET', `/api/v1/artifacts/${slug}`)).status, 200)
    assert.equal((await app.request('POST', `/api/v1/artifacts/${slug}/trash`, { body: { trashed: false } })).status, 200)
    assert.equal((await read()).status, 200)
  })

  it('lets only a service token say it', async () => {
    const made = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Чужой', markdown: '# Чужой' } })
    const response = await app.request('POST', `/api/v1/artifacts/${made.data.artifact.slug}/trash`, { token: null, headers: sso, body: { trashed: true } })
    assert.equal(response.status, 403)
  })
})

describe('the trash and an address written another way', () => {
  it('holds for a percent-encoded slug too', async () => {
    const app = await startApp({ ARTIFACTS_AUTH: 'proxy' })
    try {
      const made = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Кодированный', markdown: '# Кодированный' } })
      const slug = made.data.artifact.slug
      await app.request('POST', `/api/v1/artifacts/${slug}/trash`, { body: { trashed: true } })
      const encoded = `%${slug.charCodeAt(0).toString(16)}${slug.slice(1)}`
      const sso = { 'x-forwarded-user': 'sso-person' }
      for (const path of [`/api/v1/artifacts/${encoded}`, `/api/v1/artifacts/${encoded}/content`, `/api/v1/artifacts/${encoded}/versions`]) {
        assert.equal((await app.request('GET', path, { token: null, headers: sso })).status, 404, path)
      }
    } finally {
      await app.close()
    }
  })
})
