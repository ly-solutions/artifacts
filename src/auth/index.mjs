/**
 * Who is calling, and what they may do.
 *
 * Modes (ARTIFACTS_AUTH):
 *   token  (default) static bearer tokens; people sign in on /login with a token and get a session cookie
 *   oidc   people sign in with any OpenID Connect provider; agents keep using bearer tokens
 *   proxy  an authenticating reverse proxy (oauth2-proxy, Pomerium, Authelia, a mesh) sets a user header;
 *          trusted only from ARTIFACTS_PROXY_TRUSTED_CIDRS
 *   harnessly  token mode, plus app tokens signed by a harnessly hub: such a caller is a person (`sub`)
 *          whose rights on each document come from the hub (role `member`, see hubRights)
 *   none   no authentication at all; for a laptop
 *
 * Roles: `editor` publishes and changes metadata and sharing; `viewer` reads; `sharer` (a service
 * behind a "Share" button) only turns sharing of a document on and off and cannot read documents.
 * Static tokens: ARTIFACTS_TOKEN gives editor, ARTIFACTS_READ_TOKEN viewer, ARTIFACTS_SHARE_TOKEN sharer.
 * People (oidc, proxy): editor when listed in ARTIFACTS_EDITORS (default `*`)
 * or a member of ARTIFACTS_EDITOR_GROUPS, viewer otherwise.
 */
import { randomBytes } from 'node:crypto'

import { ipInCidrs, parseCidr } from './cidr.mjs'
import { HubRights, HubTokenVerifier, HubUnavailableError, capabilitiesOf, isAppToken } from './harnessly.mjs'
import { OidcClient } from './oidc.mjs'
import { safeEqual } from '../signing.mjs'

export const SESSION_COOKIE = 'artifacts_session'
export const OIDC_COOKIE = 'artifacts_oidc'

export const ANONYMOUS = Object.freeze({ role: 'none', name: null, via: 'none' })

export const canRead = (principal) => principal.role === 'viewer' || principal.role === 'editor'
export const canWrite = (principal) => principal.role === 'editor'
export const canShare = (principal) => principal.role === 'editor' || principal.role === 'sharer'

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name && !(name in out)) out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export class Authenticator {
  constructor({ config, signer, log = () => {}, fetchImpl = fetch }) {
    this.config = config
    this.auth = config.auth
    this.signer = signer
    this.log = log
    this.secureCookies = config.publicUrl.startsWith('https://')
    this.trusted = this.auth.proxy.trustedCidrs.map(parseCidr)
    this.oidc = this.auth.mode === 'oidc' ? new OidcClient({ ...this.auth.oidc, fetchImpl }) : null
    if (this.auth.mode === 'harnessly') {
      const { issuer, accessToken, rightsTtl } = this.auth.harnessly
      this.hub = new HubTokenVerifier({ issuer, audience: new URL(config.publicUrl).origin, fetchImpl })
      this.hubRights = new HubRights({ issuer, accessToken, ttlMs: rightsTtl * 1000, fetchImpl })
    } else {
      this.hub = null
      this.hubRights = null
    }
    this.attempts = new Map()
  }

  roleForPerson({ name, email, groups = [] }) {
    const editors = this.auth.editors.map((entry) => entry.toLowerCase())
    const ids = [name, email].filter(Boolean).map((value) => value.toLowerCase())
    const byName = editors.includes('*') || ids.some((id) => editors.includes(id))
    const byGroup = this.auth.editorGroups.some((group) => groups.includes(group))
    // An explicit group list without "*" narrows editors to the listed people and groups.
    return byName || byGroup ? 'editor' : 'viewer'
  }

  staticToken(token) {
    if (this.auth.tokens.some((expected) => safeEqual(token, expected))) return { role: 'editor', name: 'token', via: 'bearer' }
    if (this.auth.readTokens.some((expected) => safeEqual(token, expected))) return { role: 'viewer', name: 'read-token', via: 'bearer' }
    if (this.auth.shareTokens.some((expected) => safeEqual(token, expected))) return { role: 'sharer', name: 'share-token', via: 'bearer' }
    return null
  }

  /** Resolves the principal of a request. Throws { status: 401 } for a bearer token that is present but wrong. */
  async authenticate(req) {
    const header = req.headers.authorization ?? ''
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim()
    if (bearer) {
      const byToken = this.staticToken(bearer)
      if (byToken) return byToken
      if (this.hub && isAppToken(bearer)) {
        try {
          const claims = await this.hub.verify(bearer)
          const email = typeof claims.email === 'string' ? claims.email : undefined
          const name = (typeof claims.name === 'string' && claims.name) || email || claims.sub
          return { role: 'member', name, email, sub: claims.sub, hub: true, via: 'bearer' }
        } catch (error) {
          if (error instanceof HubUnavailableError) throw error
          this.log('info', 'hub app token rejected', { error: error.message })
        }
      }
      if (this.oidc && this.auth.oidc.acceptBearer && bearer.split('.').length === 3) {
        try {
          const claims = await this.oidc.verifyJwt(bearer, { audience: this.auth.oidc.clientId })
          const person = this.personFromClaims(claims)
          if (person) return { ...person, via: 'bearer' }
        } catch (error) {
          this.log('info', 'bearer JWT rejected', { error: error.message })
        }
      }
      const error = new Error('invalid bearer token')
      error.status = 401
      throw error
    }

    if (this.auth.mode === 'none') return { role: 'editor', name: 'anonymous', via: 'none' }

    if (this.auth.mode === 'proxy') {
      const remote = req.socket?.remoteAddress
      const user = req.headers[this.auth.proxy.userHeader]
      if (user && ipInCidrs(remote, this.trusted)) {
        const email = req.headers[this.auth.proxy.emailHeader] || undefined
        const groups = String(req.headers[this.auth.proxy.groupsHeader] ?? '')
          .split(/[,\s]+/)
          .filter(Boolean)
        return { role: this.roleForPerson({ name: user, email, groups }), name: String(user), email, via: 'proxy' }
      }
      if (user) this.log('warn', 'ignored proxy user header from an untrusted address', { remote })
      return ANONYMOUS
    }

    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (cookie) {
      const session = this.signer.verify('session', cookie)
      // A hub person's session (the app view's sign-in): rights on each document still come from the hub.
      if (session && session.h && this.hub && typeof session.s === 'string') return { role: 'member', name: session.n, email: session.m, sub: session.s, hub: true, via: 'session' }
      if (session && !session.h) return { role: session.r, name: session.n, email: session.m, via: 'session' }
    }
    return ANONYMOUS
  }

  /**
   * What the caller may do with each document: { read, write, share } per slug. A hub person gets the
   * hub's answer (throws HubRightsError when the hub does not answer); everyone else, their role.
   */
  async docAccess(principal, slugs) {
    if (principal.hub) {
      const rights = await this.hubRights.of(principal.sub, slugs)
      return new Map(slugs.map((slug) => [slug, capabilitiesOf(rights.get(slug) ?? 'none')]))
    }
    const same = { read: canRead(principal), write: canWrite(principal), share: canShare(principal), right: null }
    return new Map(slugs.map((slug) => [slug, same]))
  }

  async docAccessOne(principal, slug) {
    return (await this.docAccess(principal, [slug])).get(slug)
  }

  personFromClaims(claims) {
    const { oidc } = this.auth
    const email = typeof claims.email === 'string' ? claims.email : undefined
    const name = claims.preferred_username || email || claims.name || claims.sub
    const groupsClaim = claims[oidc.groupsClaim]
    const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : typeof groupsClaim === 'string' ? [groupsClaim] : []
    if (oidc.allowedDomains.length) {
      const domain = email?.split('@')[1]?.toLowerCase()
      if (!domain || !oidc.allowedDomains.map((d) => d.toLowerCase()).includes(domain) || claims.email_verified === false) return null
    }
    if (oidc.allowedGroups.length && !oidc.allowedGroups.some((group) => groups.includes(group))) return null
    return { role: this.roleForPerson({ name, email, groups }), name, email }
  }

  sessionCookie(principal) {
    const ttl = this.auth.sessionTtl
    const token = this.signer.sign('session', { n: principal.name, m: principal.email, r: principal.role, ...(principal.hub ? { h: 1, s: principal.sub } : {}), e: Math.floor(Date.now() / 1000) + ttl, i: randomBytes(6).toString('base64url') })
    return this.cookie(SESSION_COOKIE, token, ttl)
  }

  cookie(name, value, maxAge, sameSiteMode = this.auth.cookieSameSite) {
    const sameSite = { lax: 'Lax', strict: 'Strict', none: 'None' }[sameSiteMode] ?? 'Lax'
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAge}`]
    if (this.secureCookies) parts.push('Secure')
    return parts.join('; ')
  }

  clearCookie(name) {
    return this.cookie(name, '', 0)
  }

  /** Brute-force brake for the token login form: 10 failures per address per 10 minutes. */
  loginAllowed(ip) {
    const now = Date.now()
    const entry = this.attempts.get(ip)
    if (!entry || now - entry.since > 10 * 60_000) return true
    return entry.count < 10
  }

  loginFailed(ip) {
    const now = Date.now()
    const entry = this.attempts.get(ip)
    if (!entry || now - entry.since > 10 * 60_000) this.attempts.set(ip, { since: now, count: 1 })
    else entry.count += 1
    if (this.attempts.size > 10_000) this.attempts.clear()
  }
}
