/** Slugs, tags, titles and plain text extracted from documents. */
import { randomBytes } from 'node:crypto'

export const MAX_TAGS = 10
export const MAX_TAG_LENGTH = 32

// Basic Cyrillic and Greek transliteration, so a non-Latin title still gives a readable address.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n',
  ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
}

export function slugBase(title) {
  const lower = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  let out = ''
  for (const ch of lower) {
    if (ch in TRANSLIT) out += TRANSLIT[ch]
    else if (/[a-z0-9]/.test(ch)) out += ch
    else out += '-'
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'artifact'
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function randomString(length, alphabet = ALPHABET) {
  const bytes = randomBytes(length * 2)
  let out = ''
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length)
  for (const byte of bytes) {
    if (byte < limit) out += alphabet[byte % alphabet.length]
    if (out.length === length) return out
  }
  return out + randomString(length - out.length, alphabet)
}

export const makeSlug = (title) => `${slugBase(title)}-${randomString(6)}`

export const isValidSlug = (slug) => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)

/** Up to ten tags, 32 characters each, no empties, no case-insensitive duplicates; first spelling wins. */
export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH).trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

const VERSION_WORDS =
  /\(?\bv\s*\d+(?:\.\d+)*\)?|\b(?:version|rev|revision)\s*\d+\b|\b(?:final|draft|updated|update|new|copy|latest|wip)\b/g

/**
 * A title without the words people add when they make a copy instead of a new
 * version: "Payment flow (v2)", "Payment flow - final" and "Payment flow" all
 * normalise to "payment flow". Used to refuse accidental duplicates.
 */
export function normalizeTitle(title) {
  let text = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  text = text.replace(VERSION_WORDS, ' ')
  text = text.replace(/[^\p{L}\p{N}\s]|_/gu, ' ')
  text = text.replace(/\s+\d+\s*$/, '')
  return text.replace(/\s+/g, ' ').trim()
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»' }

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Visible text of an HTML page, good enough for search and diffs; not a sanitizer. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|pre|blockquote|table|ul|ol|dt|dd)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export function markdownToText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ' '))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * Fills `{name}` placeholders of a URL template with URL-encoded values. A query
 * parameter whose value is made only of placeholders that resolved to nothing
 * is dropped, so `…/{slug}?v={version}` gives `…/doc` rather than `…/doc?v=`.
 */
export function fillUrlTemplate(template, values = {}) {
  const sub = (text) => text.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(values[name] ?? ''))
  const hashAt = template.indexOf('#')
  const hash = hashAt === -1 ? '' : sub(template.slice(hashAt))
  const rest = hashAt === -1 ? template : template.slice(0, hashAt)
  const queryAt = rest.indexOf('?')
  if (queryAt === -1) return `${sub(rest)}${hash}`
  const pairs = rest
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => {
      const value = pair.slice(pair.indexOf('=') + 1)
      return !(pair.includes('=') && /\{\w+\}/.test(value) && sub(value) === '')
    })
    .map(sub)
  return `${sub(rest.slice(0, queryAt))}${pairs.length ? `?${pairs.join('&')}` : ''}${hash}`
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** A full document has its own <html>; anything else is a fragment the reader wraps in its typography. */
export const isFullDocument = (html) => /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s|<html[\s>])/i.test(String(html ?? ''))

export function titleFromHtml(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '') ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html ?? '')
  return match ? htmlToText(match[1]).slice(0, 200) : null
}

export function titleFromMarkdown(markdown) {
  const match = /^#\s+(.+)$/m.exec(markdown ?? '')
  return match ? match[1].trim().slice(0, 200) : null
}
