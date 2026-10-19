/**
 * Signed tokens: share links and browser sessions.
 *
 * A token is `base64url(payload).base64url(hmac)`, where the HMAC key is
 * derived from the server secret and a purpose, so a session cookie can never
 * be replayed as a share link or the other way round.
 *
 * A share token carries the slug, the artifact's share generation and an
 * optional expiry. Revoking sharing bumps the generation in the manifest, which
 * invalidates every token issued before, without a list of revoked tokens.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const b64 = (buffer) => Buffer.from(buffer).toString('base64url')

export class Signer {
  constructor(secret) {
    if (!secret) throw new Error('signer needs a secret')
    this.secret = secret
  }

  key(purpose) {
    return createHmac('sha256', this.secret).update(`artifacts:${purpose}`).digest()
  }

  sign(purpose, payload) {
    const body = b64(JSON.stringify(payload))
    const mac = createHmac('sha256', this.key(purpose)).update(body).digest()
    return `${body}.${b64(mac)}`
  }

  verify(purpose, token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 2048) return null
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const body = token.slice(0, dot)
    const given = Buffer.from(token.slice(dot + 1), 'base64url')
    const expected = createHmac('sha256', this.key(purpose)).update(body).digest()
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    let payload
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (!payload || typeof payload !== 'object') return null
    if (typeof payload.e === 'number' && payload.e * 1000 <= now) return null
    return payload
  }
}

/** Constant-time comparison for static tokens of any length. */
export function safeEqual(provided, expected) {
  const a = createHmac('sha256', 'cmp').update(String(provided ?? '')).digest()
  const b = createHmac('sha256', 'cmp').update(String(expected ?? '')).digest()
  return expected !== undefined && expected !== '' && timingSafeEqual(a, b)
}
