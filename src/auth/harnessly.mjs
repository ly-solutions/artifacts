/**
 * harnessly as the identity and the permission source (ARTIFACTS_AUTH=harnessly).
 *
 * A harnessly hub signs short-lived app tokens (JWT, Ed25519) for the person an agent works for.
 * The service checks them against the hub's keys and asks the hub which documents that person may
 * see, comment on or edit. See docs/integrations/harnessly.md#signing-in-with-a-hub-token.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'

export const APP_TOKEN_TYPE = 'harnessly-app+jwt'
export const RIGHTS = ['none', 'view', 'comment', 'edit']
const CLOCK_SKEW = 60
const KEYS_TTL_MS = 10 * 60_000
const FORCED_REFRESH_GAP_MS = 10_000
const RIGHTS_BATCH = 200

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** True when the bearer looks like a hub app token (checked before any signature work). */
export function isAppToken(token) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return false
  try {
    return b64json(parts[0]).typ === APP_TOKEN_TYPE
  } catch {
    return false
  }
}

export class HubTokenVerifier {
  /** issuer: the hub's public URL; audience: this service's origin. */
  constructor({ issuer, audience, fetchImpl = fetch, now = () => Date.now() }) {
    this.issuer = issuer
    this.audience = audience
    this.fetch = fetchImpl
    this.now = now
    this.jwksUri = null
    this.keys = null
    this.keysAt = 0
    this.forcedAt = 0
  }

  /** The JWKS address: from the hub's OpenID discovery, or the hub's well-known JWKS when there is none. */
  async resolveJwksUri() {
    if (this.jwksUri) return this.jwksUri
    try {
      const response = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) {
        const doc = await response.json()
        if (doc.issuer?.replace(/\/$/, '') !== this.issuer) throw new Error(`hub issuer mismatch: configured ${this.issuer}, hub says ${doc.issuer}`)
        if (typeof doc.jwks_uri === 'string' && /^https?:\/\//.test(doc.jwks_uri)) {
          this.jwksUri = doc.jwks_uri
          return this.jwksUri
        }
      }
    } catch (error) {
      if (error.message.startsWith('hub issuer mismatch')) throw error
    }
    // Hubs without discovery publish their keys at the well-known address; discovery is tried again on the next refresh.
    return `${this.issuer}/.well-known/jwks.json`
  }

  async loadKeys(force = false) {
    const now = this.now()
    if (this.keys && !force && now - this.keysAt < KEYS_TTL_MS) return this.keys
    if (force && this.keys && now - this.forcedAt < FORCED_REFRESH_GAP_MS) return this.keys
    if (force) this.forcedAt = now
    const uri = await this.resolveJwksUri()
    const response = await this.fetch(uri, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`hub JWKS fetch failed: ${response.status}`)
    const keys = (await response.json()).keys
    this.keys = Array.isArray(keys) ? keys.filter((key) => key && key.kty === 'OKP' && key.crv === 'Ed25519') : []
    this.keysAt = now
    return this.keys
  }

  /** Returns the claims of a valid hub app token; throws otherwise. */
  async verify(token) {
    const parts = String(token).split('.')
    if (parts.length !== 3) throw new Error('malformed token')
    let header
    let claims
    try {
      header = b64json(parts[0])
      claims = b64json(parts[1])
    } catch {
      throw new Error('malformed token')
    }
    if (header.alg !== 'EdDSA') throw new Error(`unsupported algorithm ${header.alg}`)
    if (header.typ !== APP_TOKEN_TYPE) throw new Error('not a hub app token')
    const find = (keys) => keys.find((key) => (header.kid ? key.kid === header.kid : true) && (!key.use || key.use === 'sig'))
    let jwk = find(await this.loadKeys())
    if (!jwk) jwk = find(await this.loadKeys(true))
    if (!jwk) throw new Error('no matching key at the hub')
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
    if (!verifySignature(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('signature invalid')
    const now = Math.floor(this.now() / 1000)
    if (claims.iss !== this.issuer) throw new Error('issuer mismatch')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(this.audience)) throw new Error('audience mismatch')
    if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW) throw new Error('token expired')
    if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW) throw new Error('token not yet valid')
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('token has no subject')
    return claims
  }
}

export class HubRightsError extends Error {}

/**
 * Which documents a hub person may open: `POST <hub>/api/platform/docs/_rights`, batched by 200
 * slugs and cached for a few seconds, so a search page costs one or two hub calls.
 */
export class HubRights {
  constructor({ issuer, accessToken, ttlMs = 10_000, fetchImpl = fetch, now = () => Date.now() }) {
    this.url = `${issuer}/api/platform/docs/_rights`
    this.accessToken = accessToken
    this.ttlMs = ttlMs
    this.fetch = fetchImpl
    this.now = now
    this.cache = new Map()
  }

  /** Map of slug to none | view | comment | edit for the person `sub`. */
  async of(sub, slugs) {
    const out = new Map()
    const missing = []
    const now = this.now()
    for (const slug of new Set(slugs)) {
      const hit = this.cache.get(`${sub}\n${slug}`)
      if (hit && now - hit.at < this.ttlMs) out.set(slug, hit.right)
      else missing.push(slug)
    }
    for (let i = 0; i < missing.length; i += RIGHTS_BATCH) {
      const batch = missing.slice(i, i + RIGHTS_BATCH)
      const rights = await this.ask(sub, batch)
      if (this.cache.size > 50_000) this.cache.clear()
      for (const slug of batch) {
        const right = RIGHTS.includes(rights[slug]) ? rights[slug] : 'none'
        out.set(slug, right)
        this.cache.set(`${sub}\n${slug}`, { right, at: now })
      }
    }
    return out
  }

  async ask(sub, slugs) {
    let response
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sub, slugs }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new HubRightsError(`the hub did not answer the rights request: ${error.message}`)
    }
    if (!response.ok) throw new HubRightsError(`the hub refused the rights request: ${response.status}`)
    const body = await response.json().catch(() => null)
    if (!body || typeof body.rights !== 'object' || body.rights === null) throw new HubRightsError('the hub sent no rights')
    return body.rights
  }
}

/** What a right lets a person do with a document here. Comments live in the hub, so `comment` reads. */
export function capabilitiesOf(right) {
  const read = right === 'view' || right === 'comment' || right === 'edit'
  const edit = right === 'edit'
  return { read, write: edit, share: edit, right }
}
