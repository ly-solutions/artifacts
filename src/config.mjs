import { bucketNameProblem } from './storage/s3.mjs'
import { VERSION_ID_FORMATS } from './store.mjs'

/**
 * Configuration from environment variables. Every option is documented in
 * docs/configuration.md; keep the two in sync (a test checks the names).
 */

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const int = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number, got "${value}"`)
  return parsed
}

/** "30s", "15m", "12h", "7d" or plain seconds. */
export function parseDuration(value, name = 'duration') {
  if (value === undefined || value === null || value === '') return undefined
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(String(value).trim())
  if (!match) throw new Error(`${name}: expected a duration like 30s, 15m, 12h or 7d, got "${value}"`)
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's']
  return Number(match[1]) * unit
}

export const AUTH_MODES = ['token', 'oidc', 'proxy', 'none']

const intIn = (raw, fallback, min, max, name) => {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return value
}

export function loadConfig(env = process.env) {
  const port = int(env.ARTIFACTS_PORT ?? env.PORT, 8080, 'ARTIFACTS_PORT')
  const publicUrl = (env.ARTIFACTS_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')
  const s3Endpoint = env.ARTIFACTS_S3_ENDPOINT || undefined

  const config = {
    host: env.ARTIFACTS_HOST || '0.0.0.0',
    port,
    publicUrl,
    siteName: env.ARTIFACTS_SITE_NAME || 'artifacts',
    // s3 as soon as a bucket is configured, a local directory otherwise (development).
    storage: (env.ARTIFACTS_STORAGE || (env.ARTIFACTS_S3_BUCKET ? 's3' : 'fs')).toLowerCase(),
    fsDir: env.ARTIFACTS_DATA_DIR || './data',
    s3: {
      bucket: env.ARTIFACTS_S3_BUCKET,
      prefix: env.ARTIFACTS_S3_PREFIX || '',
      endpoint: s3Endpoint,
      region: env.ARTIFACTS_S3_REGION || env.AWS_REGION || 'us-east-1',
      forcePathStyle: bool(env.ARTIFACTS_S3_FORCE_PATH_STYLE, Boolean(s3Endpoint)),
      accessKeyId: env.ARTIFACTS_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.ARTIFACTS_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.ARTIFACTS_S3_SESSION_TOKEN || env.AWS_SESSION_TOKEN || undefined,
      createBucket: bool(env.ARTIFACTS_S3_CREATE_BUCKET, false),
      // auto and on use If-Match / If-None-Match; off checks the ETag before writing (single writer).
      conditionalWrites: !/^(off|false|0|no)$/i.test(env.ARTIFACTS_S3_CONDITIONAL_WRITES || 'auto'),
    },
    auth: {
      mode: (env.ARTIFACTS_AUTH || 'token').toLowerCase(),
      tokens: list(env.ARTIFACTS_TOKEN),
      readTokens: list(env.ARTIFACTS_READ_TOKEN),
      shareTokens: list(env.ARTIFACTS_SHARE_TOKEN),
      secret: env.ARTIFACTS_SECRET || undefined,
      sessionTtl: parseDuration(env.ARTIFACTS_SESSION_TTL || '12h', 'ARTIFACTS_SESSION_TTL'),
      cookieSameSite: (env.ARTIFACTS_COOKIE_SAMESITE || 'lax').toLowerCase(),
      editors: list(env.ARTIFACTS_EDITORS ?? '*'),
      editorGroups: list(env.ARTIFACTS_EDITOR_GROUPS),
      oidc: {
        issuer: (env.ARTIFACTS_OIDC_ISSUER || '').replace(/\/$/, ''),
        clientId: env.ARTIFACTS_OIDC_CLIENT_ID,
        clientSecret: env.ARTIFACTS_OIDC_CLIENT_SECRET,
        scopes: env.ARTIFACTS_OIDC_SCOPES || 'openid profile email',
        redirectUrl: env.ARTIFACTS_OIDC_REDIRECT_URL || `${publicUrl}/auth/callback`,
        allowedDomains: list(env.ARTIFACTS_OIDC_ALLOWED_DOMAINS),
        allowedGroups: list(env.ARTIFACTS_OIDC_ALLOWED_GROUPS),
        groupsClaim: env.ARTIFACTS_OIDC_GROUPS_CLAIM || 'groups',
        acceptBearer: bool(env.ARTIFACTS_OIDC_ACCEPT_BEARER, false),
      },
      proxy: {
        userHeader: (env.ARTIFACTS_PROXY_USER_HEADER || 'X-Forwarded-User').toLowerCase(),
        emailHeader: (env.ARTIFACTS_PROXY_EMAIL_HEADER || 'X-Forwarded-Email').toLowerCase(),
        groupsHeader: (env.ARTIFACTS_PROXY_GROUPS_HEADER || 'X-Forwarded-Groups').toLowerCase(),
        trustedCidrs: list(env.ARTIFACTS_PROXY_TRUSTED_CIDRS || '127.0.0.1/32,::1/128'),
      },
    },
    links: {
      taskPattern: env.ARTIFACTS_TASK_PATTERN || '^[A-Za-z0-9][A-Za-z0-9_.#/-]{0,63}$',
      taskUrl: env.ARTIFACTS_TASK_URL || '',
      sessionUrl: env.ARTIFACTS_SESSION_URL || '',
    },
    reader: {
      url: env.ARTIFACTS_READER_URL || '',
      redirect: (env.ARTIFACTS_READER_REDIRECT || 'anonymous').toLowerCase(),
    },
    embed: {
      frameAncestors: list(env.ARTIFACTS_FRAME_ANCESTORS),
      corsOrigins: list(env.ARTIFACTS_CORS_ORIGINS),
    },
    content: {
      scriptSrc: list(env.ARTIFACTS_CONTENT_SCRIPT_SRC ?? 'https://cdnjs.cloudflare.com,https://cdn.jsdelivr.net'),
      connectSrc: list(env.ARTIFACTS_CONTENT_CONNECT_SRC),
      frameSrc: list(env.ARTIFACTS_CONTENT_FRAME_SRC),
      maxBytes: int(env.ARTIFACTS_MAX_DOCUMENT_BYTES, 8 * 1024 * 1024, 'ARTIFACTS_MAX_DOCUMENT_BYTES'),
    },
    share: {
      defaultTtl: parseDuration(env.ARTIFACTS_SHARE_TTL, 'ARTIFACTS_SHARE_TTL'),
      readTokenTtl: parseDuration(env.ARTIFACTS_READ_LINK_TTL || '15m', 'ARTIFACTS_READ_LINK_TTL'),
    },
    webhook: {
      url: env.ARTIFACTS_WEBHOOK_URL || '',
      secret: env.ARTIFACTS_WEBHOOK_SECRET || '',
    },
    plugins: {
      modules: list(env.ARTIFACTS_PLUGINS),
      widgetTimeout: parseDuration(env.ARTIFACTS_WIDGET_TIMEOUT || '5s', 'ARTIFACTS_WIDGET_TIMEOUT'),
    },
    versions: {
      idFormat: (env.ARTIFACTS_VERSION_ID || 'timestamp').toLowerCase(),
    },
    index: {
      refreshSeconds: parseDuration(env.ARTIFACTS_INDEX_REFRESH || '10s', 'ARTIFACTS_INDEX_REFRESH'),
      // How many documents the index reads at once; a store with slow reads wants more.
      concurrency: intIn(env.ARTIFACTS_INDEX_CONCURRENCY, 16, 1, 128, 'ARTIFACTS_INDEX_CONCURRENCY'),
    },
    // In-memory read cache for the s3 driver, in MiB; 0 turns it off.
    cacheMb: intIn(env.ARTIFACTS_CACHE_MB, 128, 0, 65536, 'ARTIFACTS_CACHE_MB'),
    log: {
      level: (env.ARTIFACTS_LOG_LEVEL || 'info').toLowerCase(),
      format: (env.ARTIFACTS_LOG_FORMAT || 'json').toLowerCase(),
    },
  }
  return config
}

/** Refuses configurations that would start insecure or broken; returns warnings for the log. */
export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!['s3', 'fs'].includes(config.storage)) errors.push(`ARTIFACTS_STORAGE must be s3 or fs, got "${config.storage}"`)
  if (config.storage === 'fs') warnings.push(`storage: fs in ${config.fsDir} (one replica only; set ARTIFACTS_S3_BUCKET for S3)`)
  if (config.storage === 's3') {
    if (!config.s3.bucket) errors.push('ARTIFACTS_S3_BUCKET is required with ARTIFACTS_STORAGE=s3 (use ARTIFACTS_STORAGE=fs for a local directory)')
    else if (bucketNameProblem(config.s3.bucket)) errors.push(`ARTIFACTS_S3_BUCKET: ${bucketNameProblem(config.s3.bucket)}`)
    if (!config.s3.accessKeyId || !config.s3.secretAccessKey) errors.push('S3 credentials missing: set ARTIFACTS_S3_ACCESS_KEY_ID and ARTIFACTS_S3_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)')
  }
  if (!(config.plugins.widgetTimeout >= 1)) errors.push('ARTIFACTS_WIDGET_TIMEOUT must be at least 1s')
  if (!VERSION_ID_FORMATS.includes(config.versions.idFormat)) errors.push(`ARTIFACTS_VERSION_ID must be one of ${VERSION_ID_FORMATS.join(', ')}, got "${config.versions.idFormat}"`)
  const { auth } = config
  if (!AUTH_MODES.includes(auth.mode)) errors.push(`ARTIFACTS_AUTH must be one of ${AUTH_MODES.join(', ')}, got "${auth.mode}"`)
  if (auth.mode === 'token' && auth.tokens.length === 0) {
    errors.push('ARTIFACTS_AUTH=token needs ARTIFACTS_TOKEN (generate one: openssl rand -hex 32); for a throwaway local run set ARTIFACTS_AUTH=none')
  }
  for (const token of [...auth.tokens, ...auth.readTokens, ...auth.shareTokens]) {
    if (token.length < 16) errors.push('every token in ARTIFACTS_TOKEN / ARTIFACTS_READ_TOKEN / ARTIFACTS_SHARE_TOKEN must be at least 16 characters')
  }
  const readTtl = config.share.readTokenTtl
  if (!(readTtl >= 60 && readTtl <= 86400)) errors.push('ARTIFACTS_READ_LINK_TTL must be between 1m and 24h: read links are meant to be short-lived')
  if (auth.mode === 'oidc') {
    if (!auth.oidc.issuer || !auth.oidc.clientId) errors.push('ARTIFACTS_AUTH=oidc needs ARTIFACTS_OIDC_ISSUER and ARTIFACTS_OIDC_CLIENT_ID')
  }
  if (!['lax', 'strict', 'none'].includes(auth.cookieSameSite)) errors.push('ARTIFACTS_COOKIE_SAMESITE must be lax, strict or none')
  if (auth.cookieSameSite === 'none' && !config.publicUrl.startsWith('https://')) errors.push('ARTIFACTS_COOKIE_SAMESITE=none needs an https ARTIFACTS_PUBLIC_URL (browsers drop SameSite=None cookies without Secure)')
  if (auth.mode === 'none') warnings.push('ARTIFACTS_AUTH=none: anyone who can reach this server can read and publish. Use it only on localhost.')
  if (auth.secret !== undefined && auth.secret.length < 32) errors.push('ARTIFACTS_SECRET must be at least 32 characters')
  try {
    new RegExp(config.links.taskPattern)
  } catch (error) {
    errors.push(`ARTIFACTS_TASK_PATTERN is not a valid regular expression: ${error.message}`)
  }
  for (const [name, template] of [['ARTIFACTS_TASK_URL', config.links.taskUrl], ['ARTIFACTS_SESSION_URL', config.links.sessionUrl]]) {
    if (template && !/^https?:\/\//.test(template)) errors.push(`${name} must be an http(s) URL template, e.g. https://tracker.example.com/issue/{task}`)
  }
  if (config.reader.url) {
    if (!/^https?:\/\//.test(config.reader.url)) errors.push('ARTIFACTS_READER_URL must be an http(s) URL template, e.g. https://reader.example.com/docs/{slug}?v={version}')
    else if (!config.reader.url.includes('{slug}')) errors.push('ARTIFACTS_READER_URL must contain {slug}')
  }
  if (!['anonymous', 'browsers'].includes(config.reader.redirect)) errors.push(`ARTIFACTS_READER_REDIRECT must be anonymous or browsers, got "${config.reader.redirect}"`)
  for (const [name, sources] of [['ARTIFACTS_CONTENT_SCRIPT_SRC', config.content.scriptSrc], ['ARTIFACTS_CONTENT_CONNECT_SRC', config.content.connectSrc], ['ARTIFACTS_CONTENT_FRAME_SRC', config.content.frameSrc]]) {
    // One CSP source per entry: a semicolon or a space would smuggle extra directives into the policy.
    const bad = sources.filter((source) => !/^[^\s;,"]+$/.test(source))
    if (bad.length) errors.push(`${name}: each entry must be one CSP source such as https://boards.example.com, got ${bad.map((b) => JSON.stringify(b)).join(', ')}`)
  }
  if (!/^https?:\/\//.test(config.publicUrl)) errors.push('ARTIFACTS_PUBLIC_URL must start with http:// or https://')
  return { errors, warnings }
}
