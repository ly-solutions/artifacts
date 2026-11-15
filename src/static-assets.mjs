/**
 * The files under web/ as the server sends them (HRN-1516): read once, with a content hash for the ETag and for the
 * `?v=` the pages put on their addresses, and compressed once (brotli and gzip) for the clients that take it.
 * A versioned address is cached by browsers for a year; a bare one for an hour and then revalidated by the ETag.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'

export const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))

const TEXT = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/
const MIN_COMPRESS = 1024

const entries = new Map()

const hashOf = (body) => createHash('sha256').update(body).digest('base64url').slice(0, 12)

/** A path under web/ or null when it leaves the folder. */
function resolve(rel) {
  const path = normalize(join(WEB_DIR, rel))
  return path.startsWith(WEB_DIR) && !rel.includes('\0') ? path : null
}

function entryOf(path, body, type) {
  const entry = { body, type, hash: hashOf(body), br: null, gzip: null }
  if (TEXT.test(type) && body.length >= MIN_COMPRESS) {
    entry.br = brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } })
    entry.gzip = gzipSync(body, { level: 9 })
  }
  entries.set(path, entry)
  return entry
}

/** The file's entry (cached), or null when there is no such file. */
export async function staticEntry(rel, type) {
  const path = resolve(rel)
  if (!path) return null
  const known = entries.get(path)
  if (known) return known
  try {
    return entryOf(path, await readFile(path), type)
  } catch {
    return null
  }
}

/** The address of a file under web/ with its content version, for the pages: `/static/docs/app.js?v=…`. */
export function assetUrl(rel) {
  const path = resolve(rel)
  if (!path) throw new Error(`not a static file: ${rel}`)
  let entry = entries.get(path)
  if (!entry) {
    try {
      entry = entryOf(path, readFileSync(path), TYPES[extname(path)] ?? 'application/octet-stream')
    } catch {
      return `/static/${rel}`
    }
  }
  return `/static/${rel}?v=${entry.hash}`
}

export const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** Which encoding of the ones we have the client takes: 'br', 'gzip' or null. */
export function pickEncoding(acceptEncoding) {
  const takes = (name) =>
    String(acceptEncoding ?? '')
      .toLowerCase()
      .split(',')
      .some((part) => {
        const [coding, ...params] = part.split(';').map((s) => s.trim())
        const q = params.find((p) => p.startsWith('q='))
        return coding === name && !(q && Number(q.slice(2)) === 0)
      })
  if (takes('br')) return 'br'
  if (takes('gzip')) return 'gzip'
  return null
}

/** Whether a response of this type and size is worth compressing on the fly. */
export const compressible = (type, length) => TEXT.test(String(type ?? '')) && length >= MIN_COMPRESS
