/**
 * In-memory catalog index: every artifact's metadata plus the plain text of its
 * current version, for listing and search.
 *
 * The source of truth stays in storage. The index is rebuilt at start and kept
 * fresh incrementally: listing `meta/` returns each manifest's ETag, and only
 * manifests whose ETag changed are fetched again. Writes made by this process
 * update the index immediately; writes made by other replicas show up after at
 * most ARTIFACTS_INDEX_REFRESH.
 */
import { htmlToText, markdownToText, normalizeTitle } from './text.mjs'

const TEXT_LIMIT = 200_000

export class Catalog {
  constructor({ store, refreshSeconds = 10, log = () => {} }) {
    this.store = store
    this.refreshMs = refreshSeconds * 1000
    this.log = log
    this.entries = new Map() // slug -> { meta, etag, text }
    this.lastRefresh = 0
    this.refreshing = null
  }

  async ensureFresh() {
    if (Date.now() - this.lastRefresh < this.refreshMs && this.lastRefresh !== 0) return
    await this.refresh()
  }

  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  async doRefresh() {
    const seen = new Set()
    const changed = []
    for await (const item of this.store.listManifests()) {
      seen.add(item.slug)
      const current = this.entries.get(item.slug)
      if (!current || current.etag !== item.etag) changed.push(item.slug)
    }
    for (const slug of this.entries.keys()) if (!seen.has(slug)) this.entries.delete(slug)
    // A few at a time: a cold start over thousands of documents should not open thousands of sockets.
    const queue = [...changed]
    const worker = async () => {
      while (queue.length) {
        const slug = queue.shift()
        try {
          await this.load(slug)
        } catch (error) {
          this.log('warn', 'index: could not load artifact', { slug, error: error.message })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker))
    this.lastRefresh = Date.now()
  }

  async load(slug) {
    const found = await this.store.getManifest(slug)
    if (!found) {
      this.entries.delete(slug)
      return
    }
    const previous = this.entries.get(slug)
    const currentId = found.meta.versions.at(-1)?.id
    let text = previous?.versionId === currentId ? previous.text : null
    if (text === null && currentId) {
      const content = await this.store.readVersionContent(slug, found.meta.versions.at(-1))
      text = contentText(content)
    }
    this.entries.set(slug, { meta: found.meta, etag: found.etag, text: text ?? '', versionId: currentId })
  }

  /** Called by the service right after it wrote a manifest. */
  put(meta, etag, text) {
    const previous = this.entries.get(meta.slug)
    const versionId = meta.versions.at(-1)?.id
    this.entries.set(meta.slug, {
      meta,
      etag,
      text: text ?? (previous?.versionId === versionId ? previous.text : ''),
      versionId,
    })
  }

  remove(slug) {
    this.entries.delete(slug)
  }

  all() {
    return [...this.entries.values()].map((entry) => entry.meta)
  }

  /**
   * Every query word must appear somewhere (title, slug, tags, description,
   * task, author, text). Results are ranked: title hits outweigh tag hits,
   * which outweigh body text; ties go to the most recently updated.
   */
  search({ q = '', tags = [], task, session, author, limit = 50, offset = 0 } = {}) {
    const words = String(q).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean)
    const wantTags = tags.map((tag) => tag.toLowerCase())
    const results = []
    for (const { meta, text } of this.entries.values()) {
      if (task && String(meta.task ?? '').toLowerCase() !== String(task).toLowerCase()) continue
      if (session && meta.session !== session) continue
      if (author && String(meta.author ?? '').toLowerCase() !== String(author).toLowerCase()) continue
      const metaTags = (meta.tags ?? []).map((tag) => tag.toLowerCase())
      if (wantTags.some((tag) => !metaTags.includes(tag))) continue
      let score = 0
      if (words.length) {
        const fold = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        const title = fold(meta.title)
        const tagText = fold(metaTags.join(' '))
        const other = fold(`${meta.slug} ${meta.description ?? ''} ${meta.task ?? ''} ${meta.author ?? ''}`)
        const body = fold(text)
        let all = true
        for (const word of words) {
          let hit = 0
          if (title.includes(word)) hit += 10
          if (tagText.includes(word)) hit += 6
          if (other.includes(word)) hit += 3
          if (body.includes(word)) hit += 1
          if (!hit) {
            all = false
            break
          }
          score += hit
        }
        if (!all) continue
      }
      // A snippet only helps when the match is in the text, not already visible in the title or description.
      const fold = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      const visible = fold(`${meta.title} ${meta.description ?? ''}`)
      const hidden = words.filter((word) => !visible.includes(word))
      results.push({ meta, score, snippet: hidden.length ? snippet(text, hidden) : undefined })
    }
    results.sort((a, b) => b.score - a.score || String(b.meta.updatedAt).localeCompare(String(a.meta.updatedAt)))
    return { total: results.length, items: results.slice(offset, offset + limit) }
  }

  /** Documents that look like the same document: same normalised title, or same task and a close title. */
  duplicates(title, task) {
    const wanted = normalizeTitle(title)
    const out = []
    for (const meta of this.all()) {
      const same = wanted !== '' && normalizeTitle(meta.title) === wanted
      const close = Boolean(task) && meta.task === task && titleSimilarity(title, meta.title) >= 0.6
      if (same || close) out.push(meta)
    }
    return out
  }

  tagCounts() {
    const counts = new Map()
    for (const meta of this.all()) {
      for (const tag of meta.tags ?? []) {
        const key = tag.toLowerCase()
        const entry = counts.get(key) ?? { tag, count: 0 }
        entry.count += 1
        counts.set(key, entry)
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }
}

export function titleSimilarity(a, b) {
  const left = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const right = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common += 1
  return common / Math.min(left.size, right.size)
}

/** Text of what readers see: the HTML when there is one, the Markdown otherwise. */
export function contentText({ html, markdown } = {}) {
  const text = html ? htmlToText(html) : markdown ? markdownToText(markdown) : ''
  return text.slice(0, TEXT_LIMIT)
}

function snippet(text, words) {
  if (!text) return undefined
  const lower = text.toLowerCase()
  let at = -1
  for (const word of words) {
    at = lower.indexOf(word)
    if (at !== -1) break
  }
  if (at === -1) return undefined
  let start = Math.max(0, at - 80)
  // Begin at a word, not in the middle of one.
  if (start > 0) start = Math.min(at, text.indexOf(' ', start) + 1 || start)
  const end = Math.min(text.length, at + 160)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}
