/**
 * Server-rendered pages: catalog, reader, embed, shared view, sign-in, errors.
 * Every value goes through escapeHtml; pages load only same-origin scripts and
 * styles, so the UI's CSP can stay strict (no inline script or style).
 */
import { readFileSync } from 'node:fs'

import { escapeHtml as e } from '../text.mjs'

const WORDMARK = readFileSync(new URL('../../web/wordmark.svg', import.meta.url), 'utf8').trim()

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
}

const date = (iso) => (iso ? `<time datetime="${e(iso)}" data-rel>${e(String(iso).slice(0, 10))}</time>` : '')

export function layout({ title, body, siteName, principal, bodyClass = '', headExtra = '', chrome = true }) {
  const user = principal?.name && principal.via !== 'none' && principal.via !== 'bearer'
    ? `<div class="user"><span class="user-name" title="${e(principal.email ?? principal.name)}">${e(principal.name)}</span>${
        principal.via === 'session' ? '<form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>' : ''
      }</div>`
    : ''
  const header = chrome
    ? `<header class="top">
  <a class="brand" href="/" aria-label="${e(siteName)} — catalog">${WORDMARK}</a>
  <div class="top-actions">${user}<button class="icon-button" type="button" data-theme-toggle title="Theme: auto" aria-label="Toggle theme">${ICONS.sun}</button></div>
</header>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${e(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/theme.js"></script>
${headExtra}
</head>
<body class="${e(bodyClass)}">
${header}
${body}
<script src="/static/app.js" defer></script>
</body>
</html>`
}

function tagChips(tags, { link = true, active = [] } = {}) {
  if (!tags?.length) return ''
  return `<ul class="tags">${tags
    .map((tag) => {
      const on = active.some((a) => a.toLowerCase() === tag.toLowerCase())
      return link
        ? `<li><a class="tag${on ? ' on' : ''}" href="/?tag=${encodeURIComponent(tag)}">${e(tag)}</a></li>`
        : `<li><span class="tag">${e(tag)}</span></li>`
    })
    .join('')}</ul>`
}

function linkChips(item, { task = true } = {}) {
  const out = []
  if (task && item.task) {
    out.push(item.taskUrl ? `<a class="chip" href="${e(item.taskUrl)}" target="_blank" rel="noopener noreferrer">${e(item.task)}</a>` : `<span class="chip">${e(item.task)}</span>`)
  }
  if (item.session) {
    out.push(
      item.sessionUrl
        ? `<a class="chip" href="${e(item.sessionUrl)}" target="_blank" rel="noopener noreferrer" title="Conversation ${e(item.session)}">conversation</a>`
        : `<span class="chip" title="Conversation ${e(item.session)}">conversation</span>`,
    )
  }
  if (item.link) out.push(`<a class="chip" href="${e(item.link)}" target="_blank" rel="noopener noreferrer">link ${ICONS.external}</a>`)
  return out.join('')
}

/** Catalog address with the current query, tags and a page offset. */
function catalogHref({ q, tags, offset }) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  for (const tag of tags ?? []) params.append('tag', tag)
  if (offset) params.set('offset', String(offset))
  const query = params.toString()
  return query ? `/?${query}` : '/'
}

export function resultsList({ items, total, q, tags, offset = 0, limit = items.length, nextOffset = null }) {
  if (!items.length && offset > 0) {
    return `<p class="empty">No more artifacts on this page. <a href="${e(catalogHref({ q, tags }))}">Back to the first page</a>.</p>`
  }
  if (!items.length) {
    const why = q || tags.length ? 'Nothing matches. Try fewer words or another tag.' : 'No artifacts yet. Publish one with <code>artifacts publish --file page.html --title "…"</code>.'
    return `<p class="empty">${why}</p>`
  }
  const rows = items
    .map(
      (item) => `<li class="card">
  <a class="card-title" href="/a/${e(item.slug)}">${e(item.title)}</a>
  ${item.description ? `<p class="card-desc">${e(item.description)}</p>` : ''}
  ${item.snippet ? `<p class="card-snippet">${e(item.snippet)}</p>` : ''}
  <div class="card-meta">
    ${item.author ? `<span>${e(item.author)}</span>` : ''}
    <span>${date(item.updatedAt)}</span>
    <span>v${item.versionCount}</span>
    ${item.public ? `<span class="badge" title="Readable by share link">${ICONS.globe}shared</span>` : ''}
    ${linkChips(item)}
  </div>
  ${tagChips(item.tags, { active: tags })}
</li>`,
    )
    .join('\n')
  const range = offset > 0 || nextOffset !== null ? ` · ${offset + 1}–${offset + items.length}` : ''
  const pages = []
  if (offset > 0) pages.push(`<a class="page-link" rel="prev" href="${e(catalogHref({ q, tags, offset: Math.max(0, offset - limit) }))}">Newer</a>`)
  if (nextOffset !== null) pages.push(`<a class="page-link" rel="next" href="${e(catalogHref({ q, tags, offset: nextOffset }))}">Older (${total - nextOffset} more)</a>`)
  const pager = pages.length ? `<nav class="pager" aria-label="Pages">${pages.join('')}</nav>` : ''
  return `<p class="count">${total} ${total === 1 ? 'artifact' : 'artifacts'}${range}</p><ul class="cards">${rows}</ul>${pager}`
}

export function catalogPage({ siteName, principal, q, tags, results, allTags }) {
  const tagBar = allTags.length
    ? `<nav class="tag-bar" aria-label="Tags">${tagChips(
        allTags.slice(0, 24).map((t) => t.tag),
        { active: tags },
      )}${tags.length ? '<a class="clear" href="/">Clear</a>' : ''}</nav>`
    : ''
  const body = `<main class="catalog">
  <form class="search" action="/" method="get" role="search" data-live-search>
    <span class="search-icon">${ICONS.search}</span>
    <input id="q" name="q" type="search" value="${e(q)}" placeholder="Search titles, tags and text" autocomplete="off" aria-label="Search">
    ${tags.map((tag) => `<input type="hidden" name="tag" value="${e(tag)}">`).join('')}
  </form>
  ${tagBar}
  <section id="results" aria-live="polite">${resultsList({ ...results, q, tags })}</section>
</main>`
  return layout({ title: siteName, body, siteName, principal, bodyClass: 'page-catalog' })
}

function versionSelect(artifact, n) {
  if (!artifact.versions?.length) return ''
  const options = artifact.versions
    .map((v) => `<option value="${v.n}"${v.n === n ? ' selected' : ''}>v${v.n} · ${e(String(v.createdAt).slice(0, 10))}${v.note ? ` · ${e(v.note.slice(0, 60))}` : ''}</option>`)
    .join('')
  return `<label class="version"><span class="sr-only">Version</span><select data-version-select>${options}</select></label>`
}

export function readerPage({ siteName, principal, artifact, n, rawUrl, canEdit, shareToken, mode = 'reader' }) {
  const version = artifact.versions?.find((v) => v.n === n) ?? artifact.currentVersion
  const shared = mode === 'shared'
  const embed = mode === 'embed'
  const actions = []
  if (mode === 'reader') {
    if (canEdit) actions.push(`<button class="button" type="button" data-open="share-dialog">${ICONS.share}<span>Share</span></button>`)
    if (canEdit) actions.push(`<button class="button" type="button" data-open="edit-dialog">${ICONS.edit}<span>Details</span></button>`)
  }
  if (!embed) {
    const base = shared ? `/s/${e(shareToken)}/raw` : `/a/${e(artifact.slug)}/raw`
    const formats = version?.formats ?? ['html']
    const links = [`<a href="${base}?v=${n}&amp;download=html">HTML</a>`]
    if (formats.includes('markdown')) links.push(`<a href="${base}?v=${n}&amp;download=markdown">Markdown</a>`)
    actions.push(`<details class="menu"><summary class="button" title="Download">${ICONS.download}<span class="sr-only">Download</span></summary><div class="menu-list">${links.join('')}</div></details>`)
  } else {
    actions.push(`<a class="button" href="/a/${e(artifact.slug)}?v=${n}" target="_blank" rel="noopener">${ICONS.external}<span>Open</span></a>`)
  }

  const metaBits = [
    artifact.author ? `<span>${e(artifact.author)}</span>` : '',
    `<span>updated ${date(version?.createdAt ?? artifact.updatedAt)}</span>`,
    shared || embed ? `<span>v${n} of ${artifact.versionCount}</span>` : versionSelect(artifact, n),
    !shared && !embed ? `<span class="badge${artifact.public ? '' : ' muted'}">${artifact.public ? `${ICONS.globe}shared` : `${ICONS.lock}private`}</span>` : '',
    !shared ? linkChips(artifact) : '',
  ].filter(Boolean)

  const bar = `<div class="reader-bar">
  <div class="reader-head">
    ${!shared && !embed ? `<a class="icon-button back" href="/" title="Catalog" aria-label="Back to catalog">${ICONS.back}</a>` : ''}
    <div class="reader-titles">
      <h1 class="reader-title">${e(artifact.title)}</h1>
      <div class="reader-meta">${metaBits.join('')}</div>
    </div>
    <div class="reader-actions">${actions.join('')}${embed || shared ? `<button class="icon-button" type="button" data-theme-toggle aria-label="Toggle theme">${ICONS.sun}</button>` : ''}</div>
  </div>
  ${!embed && (artifact.description || artifact.tags?.length) && !shared ? `<div class="reader-sub">${artifact.description ? `<p>${e(artifact.description)}</p>` : ''}${tagChips(artifact.tags)}</div>` : ''}
</div>`

  const frame = `<iframe class="content" src="${e(rawUrl)}" title="${e(artifact.title)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer" data-content-frame></iframe>`

  const dialogs = canEdit && !shared && !embed ? `${shareDialog(artifact)}${editDialog(artifact)}` : ''
  const body = `<main class="reader" data-slug="${e(artifact.slug)}" data-version="${n}" data-mode="${mode}">
${bar}
${frame}
</main>
${dialogs}`
  return layout({ title: `${artifact.title} · ${siteName}`, body, siteName, principal, bodyClass: `page-reader mode-${mode}`, chrome: !embed && !shared })
}

function shareDialog(artifact) {
  return `<dialog id="share-dialog" class="dialog">
  <form method="dialog" class="dialog-body" data-share-form>
    <h2>Share “${e(artifact.title)}”</h2>
    <p class="hint">A share link opens a read-only view without signing in. Links are signed; revoking makes every earlier link stop working.</p>
    <label>Link expires
      <select name="expiresIn">
        <option value="">Never</option>
        <option value="1d">In 1 day</option>
        <option value="7d" selected>In 7 days</option>
        <option value="30d">In 30 days</option>
      </select>
    </label>
    <div class="share-result" hidden data-share-result>
      <input type="text" readonly data-share-url aria-label="Share link">
      <button class="button" type="button" data-copy>Copy</button>
    </div>
    <p class="status" data-share-status>${artifact.public ? 'Sharing is on.' : 'Sharing is off.'}</p>
    <div class="dialog-actions">
      <button class="button danger" type="button" data-unshare${artifact.public ? '' : ' hidden'}>Revoke all links</button>
      <span class="spacer"></span>
      <button class="button" value="cancel" formnovalidate>Close</button>
      <button class="button primary" type="button" data-share>Create link</button>
    </div>
  </form>
</dialog>`
}

function editDialog(artifact) {
  return `<dialog id="edit-dialog" class="dialog">
  <form method="dialog" class="dialog-body" data-edit-form>
    <h2>Details</h2>
    <label>Title<input name="title" required maxlength="200" value="${e(artifact.title)}"></label>
    <label>Description<textarea name="description" rows="3" maxlength="1000">${e(artifact.description)}</textarea></label>
    <label>Tags <span class="hint">comma-separated, up to 10</span><input name="tags" value="${e((artifact.tags ?? []).join(', '))}"></label>
    <div class="row">
      <label>Task<input name="task" value="${e(artifact.task ?? '')}" placeholder="PROJ-123"></label>
      <label>Link<input name="link" type="url" value="${e(artifact.link ?? '')}" placeholder="https://…"></label>
    </div>
    <p class="status" data-edit-status></p>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button class="button" value="cancel" formnovalidate>Cancel</button>
      <button class="button primary" type="submit" data-save>Save</button>
    </div>
  </form>
</dialog>`
}

export function loginPage({ siteName, mode, error, next }) {
  const body =
    mode === 'token'
      ? `<main class="login">
  <form class="login-card" method="post" action="/login">
    <h1>Sign in</h1>
    <p class="hint">Paste an access token. Ask whoever runs this ${e(siteName)} server for a read token.</p>
    <input type="hidden" name="next" value="${e(next)}">
    <label>Token<input name="token" type="password" autocomplete="current-password" required autofocus></label>
    ${error ? `<p class="error">${e(error)}</p>` : ''}
    <button class="button primary" type="submit">Sign in</button>
  </form>
</main>`
      : `<main class="login"><div class="login-card"><h1>Sign in</h1><p class="error">${e(error ?? 'You are not signed in.')}</p>${
          mode === 'oidc' ? `<a class="button primary" href="/login?next=${encodeURIComponent(next)}">Try again</a>` : ''
        }</div></main>`
  return layout({ title: `Sign in · ${siteName}`, body, siteName, principal: null, bodyClass: 'page-login' })
}

export function embedSignInPage({ siteName, loginUrl }) {
  const body = `<main class="error-page" data-auth-required data-login-url="${e(loginUrl)}"><h1>Sign in to view</h1><p>This document is private to ${e(siteName)}.</p><a class="button primary" href="${e(loginUrl)}" target="_blank" rel="opener">Sign in</a></main>`
  return layout({ title: `Sign in · ${siteName}`, body, siteName, principal: null, bodyClass: 'page-error mode-embed', chrome: false })
}

export function errorPage({ siteName, status, title, message, principal }) {
  const body = `<main class="error-page"><p class="code">${status}</p><h1>${e(title)}</h1><p>${e(message)}</p><a class="button" href="/">Back to the catalog</a></main>`
  return layout({ title: `${title} · ${siteName}`, body, siteName, principal, bodyClass: 'page-error' })
}
