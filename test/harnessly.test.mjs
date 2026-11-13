import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'

import { loadConfig, validateConfig } from '../src/config.mjs'
import { HubRights, HubTokenVerifier, HubUnavailableError } from '../src/auth/harnessly.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

const ACCESS_TOKEN = 'hub-rights-token-0123456789'
const AUDIENCE = 'http://artifacts.test'

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url').slice(0, 16)
  return { privateKey, jwk: { ...jwk, kid, use: 'sig', alg: 'EdDSA' }, kid }
}

/** A fake hub by the contract: optional discovery, JWKS, and the batched rights endpoint. */
async function startHub() {
  const hub = {
    keys: [keyPair()],
    discovery: true,
    down: false,
    rights: {},
    rightsCalls: [],
    jwksCalls: 0,
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub')
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      if (!hub.discovery) return reply(404, { error: 'not_found' })
      return reply(200, { issuer: hub.issuer, jwks_uri: `${hub.issuer}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['EdDSA'] })
    }
    if (url.pathname === '/.well-known/jwks.json') {
      hub.jwksCalls += 1
      return reply(200, { keys: hub.keys.map((key) => key.jwk) })
    }
    if (url.pathname === '/api/platform/docs/_rights' && req.method === 'POST') {
      if (hub.down) return reply(500, { error: 'boom' })
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return reply(401, { error: 'unauthorized' })
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      hub.rightsCalls.push(body)
      const person = hub.rights[body.sub] ?? {}
      return reply(200, { rights: Object.fromEntries(body.slugs.map((slug) => [slug, person[slug] ?? 'none'])) })
    }
    reply(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  hub.issuer = `http://127.0.0.1:${server.address().port}`
  hub.token = (claims = {}, { header = {}, key = hub.keys[0] } = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'harnessly-app+jwt', kid: key.kid, ...header })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iss: hub.issuer, aud: AUDIENCE, sub: 'u-ada', email: 'ada@example.com', name: 'Ada', iat: now, nbf: now, exp: now + 300, jti: String(Math.random()), ...claims })).toString('base64url')
    const signature = signBytes(null, Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')
    return `${head}.${body}.${signature}`
  }
  hub.close = () => new Promise((resolve) => server.close(resolve))
  return hub
}

const DOCS = [
  { slug: 'roadmap-open', title: 'Roadmap open', markdown: '# Roadmap\n\nshared plan' },
  { slug: 'roadmap-comment', title: 'Roadmap comment', markdown: '# Roadmap\n\ncomment plan' },
  { slug: 'roadmap-edit', title: 'Roadmap edit', markdown: '# Roadmap\n\nedit plan' },
  { slug: 'roadmap-secret', title: 'Roadmap secret', markdown: '# Roadmap\n\nsecret plan' },
]

describe('harnessly mode', () => {
  let hub
  let app
  before(async () => {
    hub = await startHub()
    app = await startApp({ ARTIFACTS_AUTH: 'harnessly', ARTIFACTS_HARNESSLY_ISSUER: hub.issuer, ARTIFACTS_HARNESSLY_ACCESS_TOKEN: ACCESS_TOKEN })
    for (const doc of DOCS) await app.service.publish(doc)
  })
  after(async () => {
    await app.close()
    await hub.close()
  })
  beforeEach(() => {
    hub.rights = { 'u-ada': { 'roadmap-open': 'view', 'roadmap-comment': 'comment', 'roadmap-edit': 'edit' } }
    hub.down = false
    hub.rightsCalls.length = 0
    app.auth.hubRights.cache.clear()
  })

  const mcp = async (token, method, params, id = 1) => {
    const response = await app.request('POST', '/mcp', { token, body: { jsonrpc: '2.0', id, method, params }, headers: { accept: 'application/json, text/event-stream' } })
    return response
  }
  const call = async (token, name, args) => (await mcp(token, 'tools/call', { name, arguments: args })).data.result

  describe('sign-in with a hub app token', () => {
    it('accepts a valid token and takes the person from sub', async () => {
      const response = await app.request('GET', '/api/v1/whoami', { token: hub.token() })
      assert.equal(response.status, 200)
      assert.equal(response.data.role, 'member')
      assert.equal(response.data.name, 'Ada')
      assert.equal(response.data.auth, 'harnessly')
    })

    for (const [what, claims, header] of [
      ['another audience', { aud: 'http://elsewhere.test' }],
      ['another issuer', { iss: 'http://other-hub.test' }],
      ['an expired token', { exp: Math.floor(Date.now() / 1000) - 120 }],
      ['a token from the future', { nbf: Math.floor(Date.now() / 1000) + 600 }],
      ['no subject', { sub: '' }],
      ['another algorithm in the header', {}, { alg: 'HS256' }],
    ]) {
      it(`refuses ${what} with 401 and invalid_token`, async () => {
        const response = await app.request('GET', '/api/v1/whoami', { token: hub.token(claims, { header }) })
        assert.equal(response.status, 401)
        assert.match(response.headers.get('www-authenticate'), /^Bearer error="invalid_token"/)
      })
    }

    it('refuses a token signed by a key the hub does not publish', async () => {
      const stranger = keyPair()
      const response = await app.request('GET', '/api/v1/whoami', { token: hub.token({}, { key: { ...stranger, kid: hub.keys[0].kid } }) })
      assert.equal(response.status, 401)
    })

    it('fetches the keys again once for an unknown key id (rotation)', async () => {
      const rotated = keyPair()
      hub.keys.push(rotated)
      app.auth.hub.forcedAt = 0
      const response = await app.request('GET', '/api/v1/whoami', { token: hub.token({}, { key: rotated }) })
      assert.equal(response.status, 200)
    })

    it('keeps static tokens working', async () => {
      const response = await app.request('GET', '/api/v1/whoami', { token: TOKEN })
      assert.equal(response.data.role, 'editor')
    })
  })

  describe('document rights from the hub', () => {
    it('lists only the documents the hub allows', async () => {
      const response = await app.request('GET', '/api/v1/artifacts?q=roadmap', { token: hub.token() })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data.items.map((item) => item.slug).sort(), ['roadmap-comment', 'roadmap-edit', 'roadmap-open'])
      assert.equal(response.data.total, 3)
      assert.equal(hub.rightsCalls.length, 1)
      assert.equal(hub.rightsCalls[0].sub, 'u-ada')
    })

    it('hides a document without a right as if it did not exist', async () => {
      const token = hub.token()
      assert.equal((await app.request('GET', '/api/v1/artifacts/roadmap-secret', { token })).status, 404)
      assert.equal((await app.request('GET', '/api/v1/artifacts/roadmap-secret/content?format=markdown', { token })).status, 404)
      assert.equal((await app.request('GET', '/a/roadmap-secret/raw', { token })).status, 404)
      assert.equal((await app.request('GET', '/api/v1/artifacts/roadmap-open/content?format=markdown', { token })).status, 200)
    })

    it('lets view and comment read but not change; edit changes', async () => {
      const token = hub.token()
      for (const slug of ['roadmap-open', 'roadmap-comment']) {
        assert.equal((await app.request('PATCH', `/api/v1/artifacts/${slug}`, { token, body: { tags: ['x'] } })).status, 403)
        assert.equal((await app.request('POST', `/api/v1/artifacts/${slug}/share`, { token })).status, 403)
      }
      assert.equal((await app.request('PATCH', '/api/v1/artifacts/roadmap-edit', { token, body: { tags: ['x'] } })).status, 200)
      const shared = await app.request('POST', '/api/v1/artifacts/roadmap-edit/share', { token })
      assert.equal(shared.status, 200)
      assert.match(shared.data.url, /\/s\//)
    })

    it('does not publish or delete with a hub app token', async () => {
      const token = hub.token()
      assert.equal((await app.request('POST', '/api/v1/artifacts', { token, body: { title: 'x', markdown: '# x' } })).status, 403)
      assert.equal((await app.request('DELETE', '/api/v1/artifacts/roadmap-edit', { token })).status, 403)
    })

    it('answers the access route by the hub right', async () => {
      const token = hub.token()
      const open = await app.request('GET', '/api/v1/artifacts/roadmap-open/access', { token })
      assert.equal(open.status, 200)
      assert.deepEqual([open.data.access.read, open.data.access.write], [true, false])
      assert.equal((await app.request('GET', '/api/v1/artifacts/roadmap-secret/access', { token })).status, 404)
      assert.equal((await app.request('PUT', '/api/v1/artifacts/roadmap-open/access', { token, body: { public: true } })).status, 403)
    })

    it('caches rights for a few seconds', async () => {
      const token = hub.token()
      await app.request('GET', '/api/v1/artifacts/roadmap-open', { token })
      await app.request('GET', '/api/v1/artifacts/roadmap-open/versions', { token })
      assert.equal(hub.rightsCalls.length, 1)
    })

    it('answers 503 when the hub does not answer', async () => {
      hub.down = true
      const response = await app.request('GET', '/api/v1/artifacts/roadmap-open', { token: hub.token() })
      assert.equal(response.status, 503)
      assert.equal(response.data.error, 'rights_unavailable')
    })
  })

  describe('MCP', () => {
    it('initializes and lists the four tools, none of them publishes', async () => {
      const init = await mcp(hub.token(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      assert.equal(init.status, 200)
      assert.equal(init.data.result.protocolVersion, '2025-06-18')
      assert.match(init.data.result.instructions, /through the harnessly hub/)
      const list = await mcp(hub.token(), 'tools/list', {})
      assert.deepEqual(list.data.result.tools.map((tool) => tool.name), ['doc_find', 'doc_show', 'doc_versions', 'doc_signin', 'doc_open', 'doc_share'])
    })

    it('acknowledges notifications with 202', async () => {
      const response = await app.request('POST', '/mcp', { token: hub.token(), body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
      assert.equal(response.status, 202)
    })

    it('asks for a token without one', async () => {
      const response = await app.request('POST', '/mcp', { token: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
      assert.equal(response.status, 401)
      assert.ok(response.headers.get('www-authenticate'))
    })

    it('doc_find returns only what the person may read', async () => {
      const result = await call(hub.token(), 'doc_find', { query: 'roadmap' })
      assert.deepEqual(result.structuredContent.items.map((item) => item.slug).sort(), ['roadmap-comment', 'roadmap-edit', 'roadmap-open'])
    })

    it('doc_show reads an allowed document and refuses a hidden one', async () => {
      const shown = await call(hub.token(), 'doc_show', { slug: 'roadmap-open' })
      assert.equal(shown.isError, undefined)
      assert.match(shown.structuredContent.content, /shared plan/)
      assert.equal(shown.structuredContent.version.n, 1)
      const hidden = await call(hub.token(), 'doc_show', { slug: 'roadmap-secret' })
      assert.equal(hidden.isError, true)
      assert.doesNotMatch(hidden.content[0].text, /secret plan/)
    })

    it('doc_versions lists versions of an allowed document', async () => {
      const result = await call(hub.token(), 'doc_versions', { slug: 'roadmap-comment' })
      assert.equal(result.structuredContent.versions.length, 1)
    })

    it('doc_share needs the edit right', async () => {
      assert.equal((await call(hub.token(), 'doc_share', { slug: 'roadmap-open' })).isError, true)
      const shared = await call(hub.token(), 'doc_share', { slug: 'roadmap-edit', expiresIn: '1d' })
      assert.match(shared.structuredContent.url, /\/s\//)
      const closed = await call(hub.token(), 'doc_share', { slug: 'roadmap-edit', public: false })
      assert.equal(closed.structuredContent.public, false)
    })

    it('reports a silent hub as a tool error', async () => {
      hub.down = true
      const result = await call(hub.token(), 'doc_show', { slug: 'roadmap-open' })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /hub did not answer/)
    })

    it('refuses pages of other sites', async () => {
      const response = await app.request('POST', '/mcp', { token: hub.token(), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { origin: 'https://evil.example' } })
      assert.equal(response.status, 403)
    })

    it('signs the app view in: a one-time pass makes a session of the hub person, who reads only what the hub allows', async () => {
      const view = await startApp({ ARTIFACTS_AUTH: 'harnessly', ARTIFACTS_HARNESSLY_ISSUER: hub.issuer, ARTIFACTS_HARNESSLY_ACCESS_TOKEN: ACCESS_TOKEN, ARTIFACTS_APP_VIEW: 'true' })
      try {
        for (const doc of DOCS) await view.service.publish(doc)
        const viewCall = async (token, name, args) => (await view.request('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { accept: 'application/json, text/event-stream' } })).data.result
        // No session: the view's own data is closed, and a static token has no person to sign in.
        assert.equal((await view.request('GET', '/app/docs', { token: null })).status, 401)
        assert.equal((await viewCall(TOKEN, 'doc_signin', {})).isError, true)
        const { pass } = (await viewCall(hub.token(), 'doc_signin', {})).structuredContent
        const enter = (t, headers = { 'sec-fetch-site': 'same-origin' }) => fetch(`${view.base}/app/enter`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ t }) })
        // Another site's page cannot plant a session, and the pass is good once.
        assert.equal((await enter(pass, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403)
        const entered = await enter(pass)
        assert.equal(entered.status, 200)
        const cookie = entered.headers.get('set-cookie').split(';')[0]
        assert.equal((await enter(pass)).status, 401)
        const docs = await view.request('GET', '/app/docs', { token: null, headers: { cookie } })
        assert.equal(docs.status, 200)
        assert.deepEqual(docs.data.items.map((item) => item.slug).sort(), ['roadmap-comment', 'roadmap-edit', 'roadmap-open'])
        const doc = await view.request('GET', '/app/doc?slug=roadmap-open&theme=dark', { token: null, headers: { cookie } })
        assert.equal(doc.status, 200)
        assert.equal(doc.data.title, 'Roadmap open')
        const raw = await view.request('GET', doc.data.contentUrl, { token: null, raw: true })
        assert.equal(raw.status, 200)
        assert.match(raw.text, /shared plan/)
        assert.equal((await view.request('GET', '/app/doc?slug=roadmap-secret', { token: null, headers: { cookie } })).status, 404)
        assert.equal((await enter('wrong')).status, 401)
      } finally {
        await view.close()
      }
    })

    it('takes bearer tokens only, not a browser session', async () => {
      const login = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}&next=/` })
      const cookie = login.headers.get('set-cookie').split(';')[0]
      const response = await app.request('POST', '/mcp', { token: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { cookie } })
      assert.equal(response.status, 401)
    })

    it('wants a JSON body and small batches', async () => {
      const plain = await app.request('POST', '/mcp', { token: hub.token(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), headers: { 'content-type': 'text/plain' } })
      assert.equal(plain.status, 415)
      const many = Array.from({ length: 21 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }))
      assert.equal((await app.request('POST', '/mcp', { token: hub.token(), body: many })).status, 400)
      const few = await app.request('POST', '/mcp', { token: hub.token(), body: many.slice(0, 3) })
      assert.equal(few.data.length, 3)
    })

    it('serves static tokens with every document', async () => {
      const result = await call(TOKEN, 'doc_find', { query: 'roadmap' })
      assert.equal(result.structuredContent.items.length, 4)
    })
  })
})

describe('hub discovery fallback', () => {
  it('reads the keys from the well-known JWKS when the hub has no discovery', async () => {
    const hub = await startHub()
    hub.discovery = false
    try {
      const verifier = new HubTokenVerifier({ issuer: hub.issuer, audience: AUDIENCE })
      const claims = await verifier.verify(hub.token())
      assert.equal(claims.sub, 'u-ada')
      assert.equal(hub.jwksCalls, 1)
    } finally {
      await hub.close()
    }
  })

  it('asks the hub for rights in batches of 200', async () => {
    const hub = await startHub()
    try {
      const rights = new HubRights({ issuer: hub.issuer, accessToken: ACCESS_TOKEN })
      const slugs = Array.from({ length: 450 }, (_, i) => `doc-${i}`)
      const result = await rights.of('u-ada', slugs)
      assert.equal(result.size, 450)
      assert.deepEqual(hub.rightsCalls.map((body) => body.slugs.length), [200, 200, 50])
      assert.equal(result.get('doc-1'), 'none')
    } finally {
      await hub.close()
    }
  })
})

describe('harnessly configuration', () => {
  it('needs the hub address and the rights token, and is off by default', () => {
    assert.equal(loadConfig({}).auth.mode, 'token')
    const { errors } = validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'harnessly' }))
    assert.ok(errors.some((e) => e.includes('ARTIFACTS_HARNESSLY_ISSUER')))
    assert.ok(errors.some((e) => e.includes('ARTIFACTS_HARNESSLY_ACCESS_TOKEN')))
    const ok = validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'harnessly', ARTIFACTS_HARNESSLY_ISSUER: 'https://hub.example', ARTIFACTS_HARNESSLY_ACCESS_TOKEN: ACCESS_TOKEN, ARTIFACTS_TOKEN: TOKEN }))
    assert.deepEqual(ok.errors, [])
  })
})

describe('hub down', () => {
  it('a token that cannot be checked because the hub is down is a HubUnavailableError, not a bad token', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${enc({ alg: 'EdDSA', typ: 'harnessly-app+jwt', kid: 'k1' })}.${enc({ sub: 'u' })}.${Buffer.from('sig').toString('base64url')}`
    const verifier = new HubTokenVerifier({
      issuer: 'https://hub.example.com',
      audience: AUDIENCE,
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await assert.rejects(verifier.verify(token), HubUnavailableError)
    const refusing = new HubTokenVerifier({ issuer: 'https://hub.example.com', audience: AUDIENCE, fetchImpl: async () => new Response('', { status: 502 }) })
    await assert.rejects(refusing.verify(token), HubUnavailableError)
  })
})
