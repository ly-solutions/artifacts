/**
 * HTTP server: UI pages, the JSON API under /api/v1, the sandboxed content
 * endpoint, and the routes of the previous contract (`POST /a`, `PATCH /a/{slug}`).
 */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ANONYMOUS, Authenticator, OIDC_COOKIE, SESSION_COOKIE, canRead, canWrite, parseCookies } from './auth/index.mjs'
import { parseDuration } from './config.mjs'
import { renderVersion } from './render/doc.mjs'
import { catalogPage, embedSignInPage, errorPage, loginPage, readerPage, resultsList } from './render/ui.mjs'
import { ApiError, ArtifactService } from './service.mjs'
import { isValidSlug, normalizeTags } from './text.mjs'

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' }

export function createLogger({ level = 'info', format = 'json' } = {}, stream = process.stdout) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = order[level] ?? 20
  return (lvl, msg, extra = {}) => {
    if ((order[lvl] ?? 20) < min) return
    const time = new Date().toISOString()
    if (format === 'text') stream.write(`${time} ${lvl.toUpperCase()} ${msg}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}\n`)
    else stream.write(`${JSON.stringify({ time, level: lvl, msg, ...extra })}\n`)
  }
}

/** Paths and queries can carry share tokens; logs keep neither. */
export function redactPath(path) {
  return path.replace(/^\/s\/[^/?]+/, '/s/***').split('?')[0]
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, `request body larger than ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit) {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.includes('application/json')) throw new ApiError(415, 'unsupported_media_type', { hint: 'send Content-Type: application/json' })
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ApiError(400, 'bad_json', { hint: 'the request body is not valid JSON' })
  }
}

export async function createApp(config, { storage, log = createLogger(config.log), fetchImpl = fetch } = {}) {
  const service = await new ArtifactService({ storage, config, log, fetchImpl }).init()
  const auth = new Authenticator({ config, signer: service.signer, log, fetchImpl })
  const publicOrigin = new URL(config.publicUrl).origin
  const ancestors = config.embed.frameAncestors
  const jsonLimit = Math.ceil(config.content.maxBytes * 1.5) + 256 * 1024

  const uiCsp = (frameAncestors) =>
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'self' " + (config.auth.mode === 'oidc' ? new URL(config.auth.oidc.issuer).origin : ''),
      `frame-ancestors ${frameAncestors}`,
    ].join('; ')

  // The published HTML is untrusted: a unique origin (sandbox without allow-same-origin) keeps
  // its scripts away from cookies and from this server's API.
  const contentCsp = () =>
    [
      'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
      "default-src 'none'",
      "img-src 'self' data: blob: https:",
      `style-src 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${publicOrigin} data: https://fonts.gstatic.com`,
      `script-src 'unsafe-inline' 'unsafe-eval' ${config.content.scriptSrc.join(' ')}`.trim(),
      `connect-src ${config.content.connectSrc.length ? config.content.connectSrc.join(' ') : "'none'"}`,
      "frame-src 'none'",
      "form-action 'none'",
      `frame-ancestors 'self' ${ancestors.join(' ')}`.trim(),
    ].join('; ')

  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return
    res.writeHead(status, { ...baseHeaders, ...headers })
    res.end(body)
  }

  const json = (res, status, body, headers = {}) =>
    send(res, status, `${JSON.stringify(body, null, 2)}\n`, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })

  const html = (res, status, body, { frameAncestors = "'none'", headers = {} } = {}) =>
    send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': uiCsp(frameAncestors), ...headers })

  const redirect = (res, location, headers = {}) => send(res, 302, '', { location, 'cache-control': 'no-store', ...headers })

  const wantsHtml = (req) => String(req.headers.accept ?? '').includes('text/html')

  function deny(req, res, principal, url) {
    if (principal.role !== 'none') {
      return html(res, 403, errorPage({ siteName: config.siteName, status: 403, title: 'No access', message: 'Your account can read but not change this.', principal }))
    }
    if (config.auth.mode === 'proxy') {
      return html(res, 401, errorPage({ siteName: config.siteName, status: 401, title: 'Not signed in', message: 'The authenticating proxy did not identify you.', principal }))
    }
    const loginUrl = `/login?next=${encodeURIComponent(url.pathname + url.search)}`
    // Inside a frame, a redirect would land on the identity provider, which refuses to be framed:
    // offer a top-level sign-in instead and tell the embedding app.
    if (url.pathname.startsWith('/embed/')) {
      return html(res, 401, embedSignInPage({ siteName: config.siteName, loginUrl: `${config.publicUrl}${loginUrl}` }), { frameAncestors: ["'self'", ...ancestors].join(' ') })
    }
    return redirect(res, loginUrl)
  }

  /** Cookie-authenticated writes must come from our own pages. */
  function checkSameOrigin(req, principal) {
    if (principal.via !== 'session' && principal.via !== 'proxy') return
    const origin = req.headers.origin
    const site = req.headers['sec-fetch-site']
    if (origin === publicOrigin || site === 'same-origin') return
    throw new ApiError(403, 'cross_site', { hint: 'cookie-authenticated changes are only accepted from this server’s own pages' })
  }

  function cors(req, res) {
    const origin = req.headers.origin
    if (!origin || !config.embed.corsOrigins.includes(origin)) return false
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('access-control-max-age', '600')
    return true
  }

  const presentFull = (meta) => service.present(meta, { versions: true })

  // ---- route handlers --------------------------------------------------------

  async function apiSearch(req, res, url) {
    const params = url.searchParams
    const result = await service.search({
      q: params.get('q') ?? '',
      tags: params.getAll('tag').flatMap((tag) => normalizeTags(tag)),
      task: params.get('task') ?? undefined,
      session: params.get('session') ?? undefined,
      author: params.get('author') ?? undefined,
      limit: Math.min(Number(params.get('limit') ?? 50) || 50, 500),
      offset: Math.max(Number(params.get('offset') ?? 0) || 0, 0),
    })
    json(res, 200, result)
  }

  async function apiPublish(req, res, principal) {
    const body = await readJson(req, jsonLimit)
    const result = await service.publish(body, principal)
    json(res, result.created ? 201 : 200, { created: result.created, version: result.version, artifact: service.present(result.meta) })
  }

  async function apiMeta(req, res, slug, principal) {
    const body = await readJson(req, 256 * 1024)
    const { meta, shareToken } = await service.updateMeta(slug, body)
    json(res, 200, { artifact: service.present(meta), ...(shareToken ? { shareUrl: service.shareUrl(shareToken) } : {}) })
    void principal
  }

  async function apiContent(req, res, url, slug) {
    const format = url.searchParams.get('format') ?? 'html'
    const content = await service.readContent(slug, url.searchParams.get('v'))
    if (format === 'markdown') {
      if (content.markdown === undefined) throw new ApiError(404, 'no_markdown', { hint: 'this version was published without a Markdown source' })
      return send(res, 200, content.markdown, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-artifact-version': String(content.n) })
    }
    if (format === 'json') {
      return json(res, 200, { slug, version: { n: content.n, id: content.version.id }, html: content.html ?? null, markdown: content.markdown ?? null })
    }
    if (format !== 'html') throw new ApiError(400, 'invalid', { problems: ['format: html, markdown or json'] })
    if (content.html === undefined) throw new ApiError(404, 'no_html', { hint: 'this version was published as Markdown only; use format=markdown' })
    // Raw source as published, served as an attachment-like text so it never renders on this origin.
    send(res, 200, content.html, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-artifact-version': String(content.n) })
  }

  async function apiShare(req, res, slug) {
    const body = req.headers['content-length'] === '0' ? {} : await readJson(req, 16 * 1024).catch((error) => (error.code === 'unsupported_media_type' ? {} : Promise.reject(error)))
    let ttl
    try {
      ttl = body.expiresIn === undefined || body.expiresIn === null || body.expiresIn === '' ? undefined : parseDuration(body.expiresIn, 'expiresIn')
    } catch (error) {
      throw new ApiError(400, 'invalid', { problems: [error.message] })
    }
    const result = await service.share(slug, { ttlSeconds: ttl, rotate: body.rotate === true })
    json(res, 200, { url: result.url, expiresAt: result.expiresAt, artifact: service.present(result.meta) })
  }

  async function serveContent(res, { meta, ref, theme, download }) {
    const { version, n } = service.resolveVersion(meta, ref)
    const content = await service.store.readVersionContent(meta.slug, version)
    if (download === 'markdown') {
      if (content.markdown === undefined) throw new ApiError(404, 'no_markdown')
      return send(res, 200, content.markdown, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${meta.slug}-v${n}.md"`,
        'cache-control': 'no-store',
      })
    }
    const page = renderVersion({ html: content.html, markdown: content.markdown, title: meta.title, theme })
    const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': contentCsp(), 'cache-control': 'no-store', 'x-artifact-version': String(n) }
    if (download === 'html') headers['content-disposition'] = `attachment; filename="${meta.slug}-v${n}.html"`
    send(res, 200, page.html, headers)
  }

  async function serveStatic(res, rel) {
    const path = normalize(join(WEB_DIR, rel))
    if (!path.startsWith(WEB_DIR) || rel.includes('\0')) return send(res, 404, 'not found')
    try {
      const body = await readFile(path)
      const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600' }
      // Fonts are fetched by sandboxed documents, whose origin is "null".
      if (path.endsWith('.woff2')) headers['access-control-allow-origin'] = '*'
      send(res, 200, body, headers)
    } catch {
      send(res, 404, 'not found', { 'content-type': 'text/plain' })
    }
  }

  function legacyPublishResponse(result) {
    const meta = result.meta
    return {
      slug: meta.slug,
      public: meta.public === true,
      viewUrl: service.viewUrl(meta.slug),
      ...(meta.public ? { publicUrl: service.shareUrl(service.issueShareToken(meta)) } : {}),
      version: result.version.id,
      versionInfo: { n: result.version.n, sha: result.version.id },
      created: result.created,
    }
  }

  // ---- dispatcher ------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (path === '/healthz') return send(res, 200, 'ok\n', { 'content-type': 'text/plain' })
    if (path === '/readyz') {
      try {
        await storage.check()
        return send(res, 200, 'ready\n', { 'content-type': 'text/plain' })
      } catch (error) {
        log('warn', 'readiness check failed', { error: error.message })
        return send(res, 503, 'storage unavailable\n', { 'content-type': 'text/plain' })
      }
    }
    if (path.startsWith('/static/')) return serveStatic(res, path.slice('/static/'.length))
    if (path === '/favicon.svg' || path === '/favicon.ico') return serveStatic(res, 'favicon.svg')
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' })

    if (path.startsWith('/api/') && cors(req, res) && method === 'OPTIONS') return send(res, 204, '')

    // Shared view: the token is the whole credential; refusals all look alike.
    const sharedMatch = /^\/s\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/raw)?$/.exec(path)
    if (sharedMatch && method === 'GET') {
      const meta = await service.resolveShareToken(sharedMatch[1])
      if (!meta) return html(res, 404, errorPage({ siteName: config.siteName, status: 404, title: 'Link not available', message: 'This link has expired or was revoked, or it never existed.', principal: ANONYMOUS }))
      if (sharedMatch[2]) return serveContent(res, { meta, ref: url.searchParams.get('v'), theme: url.searchParams.get('theme'), download: url.searchParams.get('download') })
      const { n } = service.resolveVersion(meta, url.searchParams.get('v'))
      const artifact = presentFull(meta)
      const theme = url.searchParams.get('theme')
      const rawUrl = `/s/${sharedMatch[1]}/raw?v=${n}${theme ? `&theme=${encodeURIComponent(theme)}` : ''}`
      return html(res, 200, readerPage({ siteName: config.siteName, principal: ANONYMOUS, artifact, n, rawUrl, canEdit: false, shareToken: sharedMatch[1], mode: 'shared' }), { frameAncestors: ["'self'", ...ancestors].join(' ') })
    }

    let principal
    try {
      principal = await auth.authenticate(req)
    } catch (error) {
      if (error.status === 401) return json(res, 401, { error: 'unauthorized', hint: 'the bearer token is not valid' }, { 'www-authenticate': 'Bearer' })
      throw error
    }

    // ---- sign-in -------------------------------------------------------------
    if (path === '/login') {
      const next = safeNext(url.searchParams.get('next'))
      if (config.auth.mode === 'oidc' && method === 'GET') {
        const { url: target, pending } = await auth.oidc.authorizationRequest(next)
        return redirect(res, target, { 'set-cookie': auth.cookie(OIDC_COOKIE, service.signer.sign('oidc', { ...pending, e: Math.floor(Date.now() / 1000) + 600 }), 600, 'lax') })
      }
      if (config.auth.mode !== 'token') return redirect(res, next)
      if (method === 'GET') return html(res, 200, loginPage({ siteName: config.siteName, mode: 'token', next }))
      if (method === 'POST') {
        const ip = req.socket.remoteAddress ?? 'unknown'
        if (!auth.loginAllowed(ip)) return html(res, 429, loginPage({ siteName: config.siteName, mode: 'token', next, error: 'Too many attempts. Wait ten minutes.' }))
        const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'))
        const found = auth.staticToken(form.get('token') ?? '')
        const target = safeNext(form.get('next'))
        if (!found) {
          auth.loginFailed(ip)
          return html(res, 401, loginPage({ siteName: config.siteName, mode: 'token', next: target, error: 'That token is not valid.' }))
        }
        return send(res, 303, '', { location: target, 'set-cookie': auth.sessionCookie({ name: found.role === 'editor' ? 'editor' : 'reader', role: found.role }), 'cache-control': 'no-store' })
      }
    }
    if (path === '/auth/callback' && method === 'GET' && config.auth.mode === 'oidc') {
      const pending = service.signer.verify('oidc', parseCookies(req.headers.cookie)[OIDC_COOKIE])
      const clear = auth.cookie(OIDC_COOKIE, '', 0, 'lax')
      if (!pending || pending.state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
        return html(res, 400, loginPage({ siteName: config.siteName, mode: 'oidc', next: '/', error: 'The sign-in attempt expired or did not match. Try again.' }), { headers: { 'set-cookie': clear } })
      }
      try {
        const claims = await auth.oidc.exchange(url.searchParams.get('code'), pending)
        const person = auth.personFromClaims(claims)
        if (!person) return html(res, 403, loginPage({ siteName: config.siteName, mode: 'oidc', next: '/', error: 'Your account is not allowed on this server.' }), { headers: { 'set-cookie': clear } })
        return send(res, 302, '', { location: safeNext(pending.next), 'set-cookie': [clear, auth.sessionCookie(person)], 'cache-control': 'no-store' })
      } catch (error) {
        log('warn', 'oidc callback failed', { error: error.message })
        return html(res, 502, loginPage({ siteName: config.siteName, mode: 'oidc', next: '/', error: 'Sign-in failed at the identity provider.' }), { headers: { 'set-cookie': clear } })
      }
    }
    if (path === '/logout' && method === 'POST') {
      return send(res, 303, '', { location: '/', 'set-cookie': auth.clearCookie(SESSION_COOKIE), 'cache-control': 'no-store' })
    }

    // ---- API -----------------------------------------------------------------
    if (path.startsWith('/api/v1/')) {
      const needRead = () => {
        if (!canRead(principal)) throw new ApiError(401, 'unauthorized', { hint: 'send Authorization: Bearer <token>' })
      }
      const needWrite = () => {
        needRead()
        if (!canWrite(principal)) throw new ApiError(403, 'forbidden', { hint: 'this token or account can read but not write' })
        checkSameOrigin(req, principal)
      }
      if (path === '/api/v1/whoami' && method === 'GET') {
        return json(res, 200, { name: principal.name, role: principal.role, via: principal.via, auth: config.auth.mode })
      }
      if (path === '/api/v1/artifacts') {
        if (method === 'GET') return needRead(), apiSearch(req, res, url)
        if (method === 'POST') return needWrite(), apiPublish(req, res, principal)
      }
      if (path === '/api/v1/tags' && method === 'GET') return needRead(), json(res, 200, { tags: await service.tags() })
      const match = /^\/api\/v1\/artifacts\/([^/]+)(\/[a-z]+)?$/.exec(path)
      if (match) {
        const slug = decodeURIComponent(match[1])
        if (!isValidSlug(slug)) throw new ApiError(404, 'not_found')
        const sub = match[2] ?? ''
        if (sub === '' && method === 'GET') {
          needRead()
          return json(res, 200, { artifact: presentFull((await service.get(slug)).meta) })
        }
        if (sub === '' && method === 'PATCH') return needWrite(), apiMeta(req, res, slug, principal)
        if (sub === '' && method === 'DELETE') {
          needWrite()
          await service.remove(slug)
          return json(res, 200, { deleted: slug })
        }
        if (sub === '/versions' && method === 'GET') {
          needRead()
          const { meta } = await service.get(slug)
          return json(res, 200, { slug, versions: service.versionsOf(meta) })
        }
        if (sub === '/content' && method === 'GET') return needRead(), apiContent(req, res, url, slug)
        if (sub === '/share' && method === 'POST') return needWrite(), apiShare(req, res, slug)
        if (sub === '/share' && method === 'DELETE') {
          needWrite()
          const { meta } = await service.unshare(slug)
          return json(res, 200, { artifact: service.present(meta) })
        }
      }
      throw new ApiError(404, 'not_found', { hint: 'see docs/api.md for the routes' })
    }

    // ---- previous contract ---------------------------------------------------
    if (path === '/a' && method === 'POST') {
      if (!canWrite(principal)) return json(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token>' })
      const body = await readJson(req, jsonLimit)
      const rotate = body.rotateKey === true
      delete body.rotateKey
      const result = await service.publish(body, principal)
      if (rotate && result.meta.public) result.meta = (await service.share(result.meta.slug, { rotate: true })).meta
      return json(res, result.created ? 201 : 200, legacyPublishResponse(result))
    }

    // ---- UI ------------------------------------------------------------------
    if (method !== 'GET') {
      const slugPatch = /^\/a\/([a-z0-9][a-z0-9-]*)$/.exec(path)
      if (slugPatch && method === 'PATCH') {
        if (!canWrite(principal)) return json(res, 401, { error: 'unauthorized' })
        checkSameOrigin(req, principal)
        const body = await readJson(req, 256 * 1024)
        const { meta, shareToken } = await service.updateMeta(slugPatch[1], body)
        return json(res, 200, {
          ok: true,
          slug: meta.slug,
          title: meta.title,
          description: meta.description ?? '',
          task: meta.task ?? null,
          tags: meta.tags,
          public: meta.public === true,
          viewUrl: service.viewUrl(meta.slug),
          ...(shareToken ? { publicUrl: service.shareUrl(shareToken) } : {}),
        })
      }
      return json(res, 405, { error: 'method_not_allowed' })
    }

    if (path === '/') {
      if (!canRead(principal)) return deny(req, res, principal, url)
      const q = url.searchParams.get('q') ?? ''
      const tags = url.searchParams.getAll('tag').flatMap((tag) => normalizeTags(tag))
      const results = await service.search({ q, tags, limit: 200 })
      if (url.searchParams.get('partial') === '1') return html(res, 200, resultsList({ ...results, q, tags }))
      return html(res, 200, catalogPage({ siteName: config.siteName, principal, q, tags, results, allTags: await service.tags() }))
    }

    const readerMatch = /^\/(a|embed)\/([a-z0-9][a-z0-9-]*)(\/raw|\/versions)?$/.exec(path)
    if (readerMatch) {
      const [, kind, slug, sub] = readerMatch
      const found = await service.store.getManifest(slug)
      const legacyKey = url.searchParams.get('k')
      // Links of the previous system (`/a/<slug>?k=<key>`) keep working while the document stays shared.
      if (kind === 'a' && legacyKey && found && service.legacyKeyMatches(found.meta, legacyKey)) {
        if (sub === '/raw') return serveContent(res, { meta: found.meta, ref: url.searchParams.get('v'), theme: url.searchParams.get('theme'), download: url.searchParams.get('download') })
        const { n } = service.resolveVersion(found.meta, url.searchParams.get('v'))
        const rawUrl = `/a/${slug}/raw?v=${n}&k=${encodeURIComponent(legacyKey)}`
        return html(res, 200, readerPage({ siteName: config.siteName, principal: ANONYMOUS, artifact: presentFull(found.meta), n, rawUrl, canEdit: false, shareToken: '', mode: 'shared' }))
      }
      if (!canRead(principal)) {
        if (sub === '/raw' || sub === '/versions' || !wantsHtml(req)) return json(res, 401, { error: 'unauthorized' })
        return deny(req, res, principal, url)
      }
      if (!found) return html(res, 404, errorPage({ siteName: config.siteName, status: 404, title: 'Not found', message: `There is no artifact “${slug}”.`, principal }))
      if (sub === '/versions') return json(res, 200, { versions: service.versionsOf(found.meta).map((v) => ({ ...v, sha: v.id })) })
      if (sub === '/raw') return serveContent(res, { meta: found.meta, ref: url.searchParams.get('v'), theme: url.searchParams.get('theme'), download: url.searchParams.get('download') })
      const { n } = service.resolveVersion(found.meta, url.searchParams.get('v'))
      const theme = url.searchParams.get('theme')
      const rawUrl = `/a/${slug}/raw?v=${n}${theme ? `&theme=${encodeURIComponent(theme)}` : ''}`
      const mode = kind === 'embed' ? 'embed' : 'reader'
      return html(res, 200, readerPage({ siteName: config.siteName, principal, artifact: presentFull(found.meta), n, rawUrl, canEdit: canWrite(principal), mode }), {
        frameAncestors: mode === 'embed' ? ["'self'", ...ancestors].join(' ') : "'none'",
      })
    }

    return html(res, 404, errorPage({ siteName: config.siteName, status: 404, title: 'Not found', message: 'There is nothing at this address.', principal }))
  }

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint()
    res.on('finish', () => {
      if (req.url === '/healthz' || req.url === '/readyz') return
      log('info', 'request', { method: req.method, path: redactPath(req.url), status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) })
    })
    try {
      await handle(req, res)
    } catch (error) {
      if (error instanceof ApiError) return json(res, error.status, error.toJSON())
      if (error instanceof HttpError) return json(res, error.status, { error: 'request_error', hint: error.message })
      log('error', 'request failed', { path: redactPath(req.url), error: error.message, stack: error.stack })
      if (wantsHtml(req)) return html(res, 503, errorPage({ siteName: config.siteName, status: 503, title: 'Temporarily unavailable', message: 'The storage did not answer. The document is safe; try again in a minute.', principal: ANONYMOUS }))
      json(res, 503, { error: 'unavailable', hint: 'storage error; retry' }, { 'retry-after': '10' })
    }
  })
  server.headersTimeout = 30_000
  server.requestTimeout = 120_000

  return { server, service, auth }
}

/** Only same-site relative paths survive as a post-login destination. */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
