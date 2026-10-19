import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { TOKEN, startApp } from './helpers/setup.mjs'

/** A tiny OpenID provider: discovery, JWKS, token endpoint that mints ID tokens for a fixed person. */
async function startProvider({ email = 'ada@example.com', groups = ['docs-editors'] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }
  const codes = new Map()
  // oxlint-disable-next-line prefer-const -- assigned once the server knows its port
  let issuer
  const sign = (claims) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey).toString('base64url')
    return `${header}.${body}.${signature}`
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }))
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ keys: [jwk] }))
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const form = new URLSearchParams(raw)
      const pending = codes.get(form.get('code'))
      if (!pending || !req.headers.authorization?.startsWith('Basic ')) {
        res.writeHead(400)
        return res.end('{}')
      }
      const now = Math.floor(Date.now() / 1000)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id_token: sign({ iss: issuer, aud: 'artifacts', sub: 'u1', email, email_verified: true, preferred_username: 'ada', groups, nonce: pending.nonce, iat: now, exp: now + 300 }) }))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${server.address().port}`
  return { issuer, codes, sign, close: () => new Promise((resolve) => server.close(resolve)) }
}

describe('OIDC sign-in', () => {
  let provider
  let app
  before(async () => {
    provider = await startProvider()
    app = await startApp({
      ARTIFACTS_AUTH: 'oidc',
      ARTIFACTS_OIDC_ISSUER: provider.issuer,
      ARTIFACTS_OIDC_CLIENT_ID: 'artifacts',
      ARTIFACTS_OIDC_CLIENT_SECRET: 'client-secret',
      ARTIFACTS_OIDC_ALLOWED_DOMAINS: 'example.com',
      ARTIFACTS_OIDC_ACCEPT_BEARER: 'true',
      ARTIFACTS_EDITORS: '',
      ARTIFACTS_EDITOR_GROUPS: 'docs-editors',
    })
  })
  after(async () => {
    await app.close()
    await provider.close()
  })

  it('runs the authorization code flow with PKCE and issues a session', async () => {
    const start = await fetch(`${app.base}/login?next=%2Fa%2Fx`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const target = new URL(start.headers.get('location'))
    assert.equal(target.origin, provider.issuer)
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
    const state = target.searchParams.get('state')
    provider.codes.set('code-1', { nonce: target.searchParams.get('nonce') })
    const pendingCookie = start.headers.get('set-cookie').split(';')[0]

    const forged = await fetch(`${app.base}/auth/callback?code=code-1&state=wrong`, { redirect: 'manual', headers: { cookie: pendingCookie } })
    assert.equal(forged.status, 400)

    const callback = await fetch(`${app.base}/auth/callback?code=code-1&state=${state}`, { redirect: 'manual', headers: { cookie: pendingCookie } })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), '/a/x')
    const session = callback.headers.getSetCookie().find((c) => c.startsWith('artifacts_session=')).split(';')[0]
    const me = await fetch(`${app.base}/api/v1/whoami`, { headers: { cookie: session } }).then((r) => r.json())
    assert.deepEqual([me.name, me.role, me.via], ['ada', 'editor', 'session'])
  })

  it('accepts provider-issued bearer tokens and static tokens for agents', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = provider.sign({ iss: provider.issuer, aud: 'artifacts', sub: 'u2', email: 'grace@example.com', preferred_username: 'grace', groups: [], iat: now, exp: now + 300 })
    const me = await app.request('GET', '/api/v1/whoami', { token: jwt })
    assert.deepEqual([me.data.name, me.data.role], ['grace', 'viewer'])
    const wrongDomain = provider.sign({ iss: provider.issuer, aud: 'artifacts', sub: 'u3', email: 'eve@elsewhere.org', iat: now, exp: now + 300 })
    assert.equal((await app.request('GET', '/api/v1/whoami', { token: wrongDomain })).status, 401)
    const expired = provider.sign({ iss: provider.issuer, aud: 'artifacts', sub: 'u2', email: 'grace@example.com', iat: now - 900, exp: now - 600 })
    assert.equal((await app.request('GET', '/api/v1/whoami', { token: expired })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/whoami', { token: TOKEN })).data.role, 'editor')
  })
})
