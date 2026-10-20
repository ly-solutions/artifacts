/**
 * `artifacts` command line: the server (`serve`), the importer (`migrate`) and
 * a client for people and agents (publish, versions, find, get, meta, share).
 *
 * The client needs only ARTIFACTS_URL and ARTIFACTS_TOKEN. Building the JSON
 * body here, instead of a curl line in an agent's instructions, removes a whole
 * class of failures: a page full of quotes breaks hand-written JSON.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'

const VERSION = '0.1.0'

const HELP = `artifacts ${VERSION} — versioned documents for people and coding agents

Client (needs ARTIFACTS_URL and ARTIFACTS_TOKEN):
  artifacts find [words…] [--tag t] [--task ID] [--session ID] [--limit N] [--offset N] [--all] [--json]
  artifacts publish --file page.html|doc.md [--markdown doc.md] [--title "…"]
                    [--slug SLUG --note "what changed"] [--description "…"] [--tags a,b]
                    [--task ID] [--link URL] [--session ID] [--author NAME]
                    [--base-version N] [--new] [--share] [--json]
  artifacts versions SLUG [--json]
  artifacts diff SLUG [FROM] [TO] [--source auto|markdown|text] [--json]
  artifacts get SLUG [--v N] [--format html|markdown] [--out FILE]
  artifacts meta SLUG [--title "…"] [--description "…"] [--tags a,b] [--add-tag t] [--remove-tag t]
                      [--task ID | --no-task] [--link URL | --no-link] [--session ID | --no-session]
  artifacts share SLUG [--expires 7d] [--rotate]
  artifacts unshare SLUG
  artifacts delete SLUG --yes
  artifacts whoami

Server and operations (configured by ARTIFACTS_* variables, see docs/configuration.md):
  artifacts serve
  artifacts migrate --from-git REPO --to s3://bucket/prefix|DIR [--dir artifacts] [--ref main]
                    [--only slug,slug] [--overwrite] [--dry-run]
  artifacts migrate --from s3://…|DIR --to s3://…|DIR [--overwrite]

Publishing a new version of an existing document: pass its --slug and a --note.
Without --slug the server refuses a title that already exists; --new overrides that.

Environment:
  ARTIFACTS_URL      server address (default http://localhost:8080)
  ARTIFACTS_TOKEN    bearer token
  ARTIFACTS_AUTHOR   author recorded on publish (default: git user.name, then $USER)
  ARTIFACTS_SESSION  conversation or session id attached on publish (set by agent workspaces)
  ARTIFACTS_TASK     default --task
`

const BOOLEAN_FLAGS = new Set(['all', 'new', 'share', 'json', 'yes', 'rotate', 'no-task', 'no-link', 'no-session', 'overwrite', 'dry-run', 'help', 'version', 'verbose'])
const REPEATABLE = new Set(['add-tag', 'remove-tag', 'tag'])

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      args._.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s)
      let value = inline
      if (BOOLEAN_FLAGS.has(name)) {
        args[name] = value === undefined ? true : value !== 'false'
        continue
      }
      if (value === undefined) {
        value = argv[i + 1]
        if (value === undefined) throw new UsageError(`--${name} needs a value`)
        i += 1
      }
      if (REPEATABLE.has(name)) args[name] = [...(args[name] ?? []), value]
      else args[name] = value
    } else if (arg === '-h') args.help = true
    else if (arg === '-o') {
      args.out = argv[i + 1]
      i += 1
    } else args._.push(arg)
  }
  return args
}

class UsageError extends Error {}

const out = (text) => process.stdout.write(`${text}\n`)
const note = (text) => process.stderr.write(`${text}\n`)

function client(env = process.env) {
  const base = (env.ARTIFACTS_URL || 'http://localhost:8080').replace(/\/$/, '')
  const token = env.ARTIFACTS_TOKEN || ''
  return async function request(method, path, body) {
    const headers = { accept: 'application/json', 'user-agent': `artifacts-cli/${VERSION}` }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (error) {
      throw new UsageError(`cannot reach ${base}: ${error.cause?.code ?? error.message} (set ARTIFACTS_URL)`)
    }
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      const error = new Error(data.hint ?? data.error ?? `HTTP ${response.status}`)
      error.status = response.status
      error.data = data
      throw error
    }
    return { data, text, response }
  }
}

const slugArg = (args) => {
  const slug = args._[1] ?? args.slug
  if (!slug) throw new UsageError('which artifact? pass its slug')
  return slug
}

async function resolveAuthor(explicit, env) {
  if (explicit) return explicit
  if (env.ARTIFACTS_AUTHOR) return env.ARTIFACTS_AUTHOR
  try {
    const { execFileSync } = await import('node:child_process')
    const name = execFileSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    if (name) return name
  } catch {
    /* no git or no name */
  }
  return env.USER || env.LOGNAME || undefined
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' }
const IMAGE_LIMIT = 2 * 1024 * 1024
const IMAGES_TOTAL = 8 * 1024 * 1024

/** Local images (`<img src="./x.png">`, `![](x.png)`) are inlined, so the page is self-contained. */
export async function inlineImages(source, baseDir) {
  let total = 0
  const cache = new Map()
  const load = async (src) => {
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(src)) return null
    const type = IMAGE_TYPES[extname(src.split(/[?#]/)[0]).toLowerCase()]
    if (!type) return null
    const path = resolve(baseDir, decodeURIComponent(src.split(/[?#]/)[0]))
    if (cache.has(path)) return cache.get(path)
    let data
    try {
      data = await readFile(path)
    } catch {
      note(`warning: image not found, left as is: ${src}`)
      return null
    }
    if (data.length > IMAGE_LIMIT) throw new UsageError(`image ${src} is larger than 2 MB; compress it or host it elsewhere`)
    total += data.length
    if (total > IMAGES_TOTAL) throw new UsageError('local images add up to more than 8 MB')
    const uri = `data:${type};base64,${data.toString('base64')}`
    cache.set(path, uri)
    return uri
  }
  const replaceAsync = async (text, re, fn) => {
    const parts = []
    let last = 0
    for (const match of text.matchAll(re)) {
      parts.push(text.slice(last, match.index), await fn(match))
      last = match.index + match[0].length
    }
    parts.push(text.slice(last))
    return parts.join('')
  }
  let result = await replaceAsync(source, /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gis, async (m) => {
    const uri = await load(m[3])
    return uri ? `${m[1]}${m[2]}${uri}${m[2]}` : m[0]
  })
  result = await replaceAsync(result, /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, async (m) => {
    const uri = await load(m[2])
    return uri ? `${m[1]}${uri}${m[3]}` : m[0]
  })
  return result
}

const isMarkdownFile = (path) => /\.(md|markdown|mdx)$/i.test(path)

function printLinks(artifact, extra = {}) {
  out(artifact.viewUrl)
  if (extra.shareUrl) {
    out(extra.shareUrl)
    note('share link: read-only, no sign-in')
  }
}

async function cmdPublish(args, env, request) {
  if (!args.file && !args.markdown) throw new UsageError('publish needs --file (HTML or Markdown) or --markdown')
  if (args.note && !args.slug) throw new UsageError('--note describes a new version of an existing artifact: pass its --slug too')
  const body = {}
  if (args.file) {
    const text = await inlineImages(await readFile(args.file, 'utf8'), dirname(resolve(args.file)))
    if (isMarkdownFile(args.file)) body.markdown = text
    else body.html = text
  }
  if (args.markdown) body.markdown = await inlineImages(await readFile(args.markdown, 'utf8'), dirname(resolve(args.markdown)))
  for (const [flag, field] of [['title', 'title'], ['slug', 'slug'], ['note', 'note'], ['description', 'description'], ['task', 'task'], ['link', 'link'], ['session', 'session']]) {
    if (args[flag] !== undefined) body[field] = args[flag]
  }
  if (body.task === undefined && env.ARTIFACTS_TASK && !args.slug) body.task = env.ARTIFACTS_TASK
  if (body.session === undefined && env.ARTIFACTS_SESSION) body.session = env.ARTIFACTS_SESSION
  if (args.tags !== undefined) body.tags = args.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  if (args['base-version'] !== undefined) body.baseVersion = Number(args['base-version'])
  if (args.new) body.new = true
  const author = await resolveAuthor(args.author, env)
  if (author) body.author = author

  let result
  try {
    result = (await request('POST', '/api/v1/artifacts', body)).data
  } catch (error) {
    if (error.data?.error === 'duplicate') {
      note('an artifact with this title already exists:')
      for (const c of error.data.candidates ?? []) note(`  ${c.slug} — ${c.title}${c.task ? ` (${c.task})` : ''}  ${c.viewUrl}`)
      note('\npublish a new version of it:  artifacts publish --slug <slug> --note "what changed" --file …')
      note('or, if this really is a different document, add --new')
      return 1
    }
    throw error
  }
  let shareUrl
  if (args.share) shareUrl = (await request('POST', `/api/v1/artifacts/${result.artifact.slug}/share`, {})).data.url
  if (args.json) {
    out(JSON.stringify({ ...result, ...(shareUrl ? { shareUrl } : {}) }, null, 2))
    return 0
  }
  printLinks(result.artifact, { shareUrl })
  note(`${result.created ? 'published' : 'updated'} ${result.artifact.slug}, version ${result.version.n}${author ? `, author ${author}` : ''}`)
  return 0
}

async function cmdFind(args, request) {
  const params = new URLSearchParams()
  const q = args._.slice(1).join(' ') || args.query || ''
  if (q) params.set('q', q)
  for (const tag of args.tag ?? []) params.append('tag', tag)
  if (args.task) params.set('task', args.task)
  if (args.session) params.set('session', args.session)
  if (args.author) params.set('author', args.author)
  params.set('limit', args.limit ?? (args.all ? '500' : '25'))
  if (args.offset) params.set('offset', args.offset)
  const { data } = await request('GET', `/api/v1/artifacts?${params}`)
  // --all follows nextOffset to the end, so nothing past the first page is silently dropped.
  while (args.all && data.nextOffset !== null && data.nextOffset !== undefined) {
    params.set('offset', String(data.nextOffset))
    const page = (await request('GET', `/api/v1/artifacts?${params}`)).data
    data.items.push(...page.items)
    data.nextOffset = page.nextOffset
    data.total = page.total
  }
  if (args.json) {
    out(JSON.stringify(data, null, 2))
    return 0
  }
  if (!data.items.length) {
    note(q ? 'nothing found: no artifact on this topic yet, publishing a new one is fine' : 'the catalog is empty')
    return 0
  }
  for (const item of data.items) out(`${item.slug} — ${item.title}${item.task ? ` (${item.task})` : ''} · v${item.versionCount} · ${item.viewUrl}`)
  const shown = (data.offset ?? 0) + data.items.length
  if (data.total > shown) note(`${data.total - shown} more; narrow the query, or pass --offset ${shown} or --all`)
  return 0
}

async function cmdVersions(args, request) {
  const slug = slugArg(args)
  const { data } = await request('GET', `/api/v1/artifacts/${encodeURIComponent(slug)}/versions`)
  if (args.json) {
    out(JSON.stringify(data, null, 2))
    return 0
  }
  for (const v of [...data.versions].reverse()) out(`${v.n} · ${String(v.createdAt).slice(0, 16).replace('T', ' ')} · ${v.author ?? '—'} · ${v.note ?? '—'}`)
  return 0
}

async function cmdDiff(args, request) {
  const slug = slugArg(args)
  const params = new URLSearchParams({ format: args.json ? 'json' : 'unified' })
  const from = args._[2] ?? args.from
  const to = args._[3] ?? args.to
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (args.source) params.set('source', args.source)
  const { text } = await request('GET', `/api/v1/artifacts/${encodeURIComponent(slug)}/diff?${params}`)
  process.stdout.write(text || (args.json ? '' : 'no differences\n'))
  return 0
}

async function cmdGet(args, request) {
  const slug = slugArg(args)
  const format = args.format ?? 'html'
  const params = new URLSearchParams({ format })
  if (args.v) params.set('v', args.v)
  const { text } = await request('GET', `/api/v1/artifacts/${encodeURIComponent(slug)}/content?${params}`)
  if (args.out) {
    await writeFile(args.out, text)
    note(`saved ${args.out}`)
  } else process.stdout.write(text)
  return 0
}

async function cmdMeta(args, request) {
  const slug = slugArg(args)
  const body = {}
  if (args.title !== undefined) body.title = args.title
  if (args.description !== undefined) body.description = args.description
  if (args.tags !== undefined) body.tags = args.tags
  if (args['add-tag']) body.addTags = args['add-tag'].join(',')
  if (args['remove-tag']) body.removeTags = args['remove-tag'].join(',')
  for (const field of ['task', 'link', 'session']) {
    if (args[`no-${field}`]) body[field] = null
    else if (args[field] !== undefined) body[field] = args[field]
  }
  if (!Object.keys(body).length) throw new UsageError('nothing to change: --title, --description, --tags, --add-tag, --remove-tag, --task/--no-task, --link/--no-link, --session/--no-session')
  const { data } = await request('PATCH', `/api/v1/artifacts/${encodeURIComponent(slug)}`, body)
  const a = data.artifact
  out(`${a.slug}: "${a.title}", tags ${a.tags.join(', ') || '—'}, task ${a.task ?? '—'}, link ${a.link ?? '—'}, session ${a.session ?? '—'}`)
  return 0
}

async function cmdShare(args, request) {
  const slug = slugArg(args)
  const body = {}
  if (args.expires) body.expiresIn = args.expires
  if (args.rotate) body.rotate = true
  const { data } = await request('POST', `/api/v1/artifacts/${encodeURIComponent(slug)}/share`, body)
  out(data.url)
  note(data.expiresAt ? `read-only link, works until ${data.expiresAt}` : 'read-only link, does not expire; revoke with `artifacts unshare`')
  return 0
}

async function cmdUnshare(args, request) {
  const slug = slugArg(args)
  await request('DELETE', `/api/v1/artifacts/${encodeURIComponent(slug)}/share`)
  note(`sharing of ${slug} is off; every link issued before has stopped working`)
  return 0
}

async function cmdDelete(args, request) {
  const slug = slugArg(args)
  if (!args.yes) throw new UsageError('deleting removes every version for good; repeat with --yes')
  await request('DELETE', `/api/v1/artifacts/${encodeURIComponent(slug)}`)
  note(`deleted ${slug}`)
  return 0
}

async function storageFromUrl(url, env) {
  const { createStorage, parseStorageUrl } = await import('./storage/index.mjs')
  const { loadConfig } = await import('./config.mjs')
  const target = parseStorageUrl(url)
  const config = loadConfig(env)
  if (target.storage === 'fs') return createStorage({ storage: 'fs', fsDir: target.dir })
  return createStorage({ storage: 's3', s3: { ...config.s3, bucket: target.bucket, prefix: target.prefix } })
}

async function cmdMigrate(args, env) {
  if (!args.to) throw new UsageError('migrate needs --to s3://bucket/prefix or a directory')
  const { createLogger } = await import('./server.mjs')
  const log = createLogger({ level: 'info', format: 'text' }, process.stderr)
  const to = await storageFromUrl(args.to, env)
  const { copyStorage, migrateFromGit } = await import('./migrate/git.mjs')
  if (args['from-git']) {
    const report = await migrateFromGit({
      repo: args['from-git'],
      storage: to,
      dir: args.dir ?? 'artifacts',
      ref: args.ref ?? 'HEAD',
      overwrite: Boolean(args.overwrite),
      dryRun: Boolean(args['dry-run']),
      only: args.only ? args.only.split(',') : undefined,
      log,
    })
    out(JSON.stringify(report, null, 2))
    return report.failed.length ? 1 : 0
  }
  if (args.from) {
    const from = await storageFromUrl(args.from, env)
    out(JSON.stringify(await copyStorage({ from, to, overwrite: Boolean(args.overwrite), log }), null, 2))
    return 0
  }
  throw new UsageError('migrate needs --from-git REPO or --from STORAGE')
}

async function cmdServe(env) {
  const { loadConfig, validateConfig } = await import('./config.mjs')
  const { createApp, createLogger } = await import('./server.mjs')
  const { createStorage } = await import('./storage/index.mjs')
  const config = loadConfig(env)
  const log = createLogger(config.log)
  const { errors, warnings } = validateConfig(config)
  for (const warning of warnings) log('warn', warning)
  if (errors.length) {
    for (const error of errors) log('error', error)
    return 2
  }
  // Storage may come up after us (compose, a sidecar, a fresh bucket): wait up to a minute.
  let storage
  let app
  for (let attempt = 1; ; attempt += 1) {
    try {
      storage = await createStorage(config)
      app = await createApp(config, { storage, log })
      break
    } catch (error) {
      if (attempt >= 30) {
        log('error', 'storage is not reachable, giving up', { error: error.message })
        return 1
      }
      log('warn', 'waiting for storage', { attempt, error: error.message })
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
    }
  }
  const { server } = app
  await new Promise((resolveListen) => server.listen(config.port, config.host, resolveListen))
  log('info', 'listening', { url: config.publicUrl, port: config.port, storage: config.storage, auth: config.auth.mode })
  const stop = (signal) => {
    log('info', 'shutting down', { signal })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  return null
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    note(error.message)
    return 2
  }
  const command = args._[0]
  if (args.version || command === 'version') {
    out(VERSION)
    return 0
  }
  if (!command || args.help || command === 'help') {
    out(HELP)
    return command || args.help ? 0 : 2
  }
  const request = client(env)
  try {
    switch (command) {
      case 'serve':
        return await cmdServe(env)
      case 'migrate':
        return await cmdMigrate(args, env)
      case 'publish':
        return await cmdPublish(args, env, request)
      case 'find':
      case 'search':
        return await cmdFind(args, request)
      case 'versions':
        return await cmdVersions(args, request)
      case 'get':
        return await cmdGet(args, request)
      case 'diff':
        return await cmdDiff(args, request)
      case 'meta':
        return await cmdMeta(args, request)
      case 'share':
        return await cmdShare(args, request)
      case 'unshare':
        return await cmdUnshare(args, request)
      case 'delete':
        return await cmdDelete(args, request)
      case 'whoami': {
        const { data } = await request('GET', '/api/v1/whoami')
        out(`${data.name ?? 'anonymous'} (${data.role}, auth ${data.auth})`)
        return 0
      }
      default:
        note(`unknown command "${command}"\n`)
        out(HELP)
        return 2
    }
  } catch (error) {
    if (error instanceof UsageError) {
      note(error.message)
      return 2
    }
    if (error.status) {
      note(`error ${error.status}: ${error.message}`)
      for (const problem of error.data?.problems ?? []) note(`  - ${problem}`)
      return 1
    }
    note(error.stack ?? String(error))
    return 1
  }
}
