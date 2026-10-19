/**
 * Import from a git repository that keeps one folder per artifact:
 *
 *   <dir>/<slug>/index.html    the page; every commit that changed it is a version
 *   <dir>/<slug>/document.md   optional Markdown source, read at the same commit
 *   <dir>/<slug>/meta.yaml     title, description, author, task, tags, public, key, createdAt, updatedAt
 *
 * Commit trailers `Author:` and `Note:` become the version's author and note;
 * without a trailer the commit author is used. Each version keeps its commit
 * sha as the version id, so `?v=<sha>` links from the old system resolve.
 *
 * The import is idempotent: version objects are immutable and keyed by sha,
 * and an artifact that already has a manifest is skipped unless --overwrite.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { parse as parseYaml } from 'yaml'

import { ArtifactStore, SCHEMA } from '../store.mjs'
import { isValidSlug, normalizeTags } from '../text.mjs'

const run = promisify(execFile)
const RS = '\x1e'
const US = '\x1f'

async function git(repo, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' })
    return stdout
  } catch (error) {
    if (allowFail) return null
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`)
  }
}

const trailer = (message, name) => new RegExp(`^${name}: (.*)$`, 'm').exec(message ?? '')?.[1]?.trim() || null
const utc = (iso) => (iso ? new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z') : null)
const str = (value) => (value === undefined || value === null || value === '' ? null : String(value))

export const isRemote = (repo) => /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/.test(repo)

export async function migrateFromGit({ repo, storage, dir = 'artifacts', ref = 'HEAD', overwrite = false, dryRun = false, only, log = () => {} }) {
  let workdir = repo
  let cleanup = null
  if (isRemote(repo)) {
    workdir = await mkdtemp(join(tmpdir(), 'artifacts-migrate-'))
    cleanup = () => rm(workdir, { recursive: true, force: true })
    log('info', 'cloning', { repo: repo.replace(/\/\/[^@/]+@/, '//***@') })
    await run('git', ['clone', '--quiet', '--no-checkout', repo, workdir], { maxBuffer: 64 * 1024 * 1024 })
  }
  const store = new ArtifactStore(storage)
  const report = { artifacts: 0, versions: 0, skipped: [], failed: [] }
  try {
    const listing = (await git(workdir, ['ls-tree', '-d', '--name-only', `${ref}:${dir}`])).toString('utf8')
    const slugs = listing.split('\n').map((line) => line.trim()).filter(Boolean)
    for (const slug of slugs) {
      if (only && !only.includes(slug)) continue
      if (!isValidSlug(slug)) {
        report.skipped.push({ slug, reason: 'not a valid slug' })
        continue
      }
      try {
        const result = await migrateOne({ workdir, store, dir, ref, slug, overwrite, dryRun })
        if (result.skipped) report.skipped.push({ slug, reason: result.skipped })
        else {
          report.artifacts += 1
          report.versions += result.versions
          log('info', dryRun ? 'would import' : 'imported', { slug, versions: result.versions })
        }
      } catch (error) {
        report.failed.push({ slug, error: error.message })
        log('warn', 'import failed', { slug, error: error.message })
      }
    }
  } finally {
    if (cleanup) await cleanup()
  }
  return report
}

async function migrateOne({ workdir, store, dir, ref, slug, overwrite, dryRun }) {
  const base = `${dir}/${slug}`
  const rawMeta = await git(workdir, ['show', `${ref}:${base}/meta.yaml`], { allowFail: true })
  if (!rawMeta) return { skipped: 'no meta.yaml' }
  let meta
  try {
    meta = parseYaml(rawMeta.toString('utf8')) ?? {}
  } catch (error) {
    return { skipped: `meta.yaml does not parse: ${error.message}` }
  }

  const existing = await store.getManifest(slug)
  if (existing && !overwrite) return { skipped: 'already imported (use --overwrite to replace the manifest)' }

  const log = (await git(workdir, ['log', ref, '--reverse', `--format=%H${US}%cI${US}%an${US}%B${RS}`, '--', `${base}/index.html`])).toString('utf8')
  const commits = log
    .split(RS)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.includes(US))
    .map((record) => {
      const [sha, date, authorName, message] = record.split(US)
      return { sha, date, authorName, message }
    })
  if (!commits.length) return { skipped: 'index.html has no history' }

  const versions = []
  for (const commit of commits) {
    const html = await git(workdir, ['show', `${commit.sha}:${base}/index.html`], { allowFail: true })
    if (html === null) continue // the commit deleted the page
    const markdown = await git(workdir, ['show', `${commit.sha}:${base}/document.md`], { allowFail: true })
    const htmlText = html.toString('utf8')
    const markdownText = markdown?.toString('utf8')
    if (!dryRun) {
      await store.putVersionContent(slug, commit.sha, { html: htmlText, markdown: markdownText }).catch((error) => {
        if (!/already exists/.test(error.message)) throw error
      })
    }
    versions.push({
      id: commit.sha,
      createdAt: utc(commit.date),
      author: trailer(commit.message, 'Author') ?? commit.authorName ?? null,
      note: trailer(commit.message, 'Note'),
      html: true,
      markdown: markdownText !== undefined,
      bytes: html.length + (markdown?.length ?? 0),
      sha256: createHash('sha256').update(htmlText).update('\0').update(markdownText ?? '').digest('hex'),
      source: 'git',
    })
  }
  if (!versions.length) return { skipped: 'no readable versions' }

  const isPublic = meta.public === true
  const manifest = {
    schema: SCHEMA,
    slug,
    title: str(meta.title) ?? slug,
    description: str(meta.description) ?? '',
    author: str(meta.author) ?? versions[0].author,
    tags: normalizeTags(meta.tags ?? []),
    task: str(meta.task),
    link: str(meta.link) ?? str(meta.promotedTo),
    session: str(meta.session),
    public: isPublic,
    // A shared document keeps its old `?k=` link working until sharing is turned off.
    share: isPublic && meta.key ? { gen: 1, legacyKey: String(meta.key) } : { gen: 1 },
    createdAt: utc(meta.createdAt) ?? versions[0].createdAt,
    updatedAt: utc(meta.updatedAt) ?? versions.at(-1).createdAt,
    versions,
  }
  if (!dryRun) await store.putManifest(manifest, existing ? existing.etag : null)
  return { versions: versions.length }
}

/** Copies every object from one storage to another (fs -> s3, bucket -> bucket). */
export async function copyStorage({ from, to, overwrite = false, log = () => {} }) {
  let copied = 0
  let skipped = 0
  for await (const item of from.list('')) {
    if (!overwrite && (await to.head(item.key))) {
      skipped += 1
      continue
    }
    const object = await from.get(item.key)
    if (!object) continue
    await to.put(item.key, object.body, { contentType: object.contentType ?? (item.key.endsWith('.json') ? 'application/json' : item.key.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8') })
    copied += 1
    if (copied % 500 === 0) log('info', 'copying', { copied })
  }
  return { copied, skipped }
}
