/**
 * Minimal OpenID Connect relying party: authorization code flow with PKCE,
 * ID token verification against the provider's JWKS (RS256/384/512, PS256,
 * ES256/384). Works with any compliant provider: Keycloak, Authentik, Dex,
 * Zitadel, Okta, Auth0, Google, Microsoft Entra, GitLab.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'

const ALGORITHMS = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: 'pss' },
  ES256: { hash: 'sha256', ec: true },
  ES384: { hash: 'sha384', ec: true },
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

export class OidcClient {
  constructor({ issuer, clientId, clientSecret, scopes, redirectUrl, fetchImpl = fetch }) {
    this.issuer = issuer
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.scopes = scopes
    this.redirectUrl = redirectUrl
    this.fetch = fetchImpl
    this.discovery = null
    this.jwks = null
    this.jwksAt = 0
  }

  async discover() {
    if (this.discovery) return this.discovery
    const response = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`)
    const doc = await response.json()
    if (doc.issuer?.replace(/\/$/, '') !== this.issuer) throw new Error(`OIDC issuer mismatch: configured ${this.issuer}, provider says ${doc.issuer}`)
    this.discovery = doc
    return doc
  }

  /** Returns the URL to redirect to and the state to keep in a short-lived cookie. */
  async authorizationRequest(next = '/') {
    const doc = await this.discover()
    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const url = new URL(doc.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUrl,
      scope: this.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return { url: url.toString(), pending: { state, nonce, verifier, next } }
  }

  async exchange(code, pending) {
    const doc = await this.discover()
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUrl, code_verifier: pending.verifier, client_id: this.clientId })
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    if (this.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`
    }
    const response = await this.fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`OIDC token exchange failed: ${response.status}`)
    const tokens = await response.json()
    if (!tokens.id_token) throw new Error('OIDC provider returned no id_token')
    const claims = await this.verifyJwt(tokens.id_token, { audience: this.clientId, nonce: pending.nonce })
    return claims
  }

  async keys(force = false) {
    if (!force && this.jwks && Date.now() - this.jwksAt < 10 * 60_000) return this.jwks
    const doc = await this.discover()
    const response = await this.fetch(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`OIDC JWKS fetch failed: ${response.status}`)
    this.jwks = (await response.json()).keys ?? []
    this.jwksAt = Date.now()
    return this.jwks
  }

  async verifyJwt(token, { audience, nonce } = {}) {
    const parts = String(token).split('.')
    if (parts.length !== 3) throw new Error('malformed JWT')
    const header = b64json(parts[0])
    const claims = b64json(parts[1])
    const alg = ALGORITHMS[header.alg]
    if (!alg) throw new Error(`unsupported JWT algorithm ${header.alg}`)
    const find = (keys) => keys.find((key) => (header.kid ? key.kid === header.kid : true) && (!key.use || key.use === 'sig'))
    let jwk = find(await this.keys())
    if (!jwk) jwk = find(await this.keys(true))
    if (!jwk) throw new Error('no matching key in JWKS')
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    const options = { key }
    if (alg.ec) options.dsaEncoding = 'ieee-p1363'
    if (alg.padding === 'pss') {
      options.padding = 6 // RSA_PKCS1_PSS_PADDING
      options.saltLength = 32
    }
    const ok = verifySignature(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), options, Buffer.from(parts[2], 'base64url'))
    if (!ok) throw new Error('JWT signature invalid')
    const now = Math.floor(Date.now() / 1000)
    if (claims.iss?.replace(/\/$/, '') !== this.issuer) throw new Error('JWT issuer mismatch')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (audience && !aud.includes(audience) && claims.azp !== audience) throw new Error('JWT audience mismatch')
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('JWT expired')
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new Error('JWT not yet valid')
    if (nonce !== undefined && claims.nonce !== nonce) throw new Error('JWT nonce mismatch')
    return claims
  }
}
