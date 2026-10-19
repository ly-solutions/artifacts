/**
 * Turns a stored version into the page the reader frames.
 *
 * - a full HTML document (own <html>) is served as published;
 * - an HTML fragment or a Markdown-only version is wrapped in the built-in
 *   typography: readable measure, light and dark themes, tables, code.
 *
 * Widgets are optional sugar for fragments: `<artifact-widget type="kpi">{json}</artifact-widget>`
 * renders a row of figures ({"items": [{label, value, delta?, tone?: good|bad, hint?}]}).
 * Unknown widget types are left in place.
 */
import { readFileSync } from 'node:fs'

import { Marked } from 'marked'

import { escapeHtml, isFullDocument } from '../text.mjs'

const DOC_CSS = readFileSync(new URL('../../web/doc.css', import.meta.url), 'utf8')

const headingId = (text, seen) => {
  let id = String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '') || 'section'
  const base = id
  let n = 1
  while (seen.has(id)) id = `${base}-${n++}`
  seen.add(id)
  return id
}

export function renderMarkdown(markdown) {
  const seen = new Set()
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const id = headingId(inner, seen)
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`
      },
    },
  })
  return marked.parse(String(markdown ?? ''))
}

const WIDGET_RE = /<artifact-widget\b([^>]*)>([\s\S]*?)<\/artifact-widget>/gi

function renderKpi(spec) {
  const items = Array.isArray(spec?.items) ? spec.items.slice(0, 8) : []
  if (!items.length) return null
  const cells = items
    .map((item) => {
      // tone: "good" or "bad" says how to read the change; without it a minus reads as bad.
      const bad = item.tone === 'bad' || (item.tone !== 'good' && String(item.delta ?? '').trim().startsWith('-'))
      const delta = item.delta ? `<span class="kpi-delta${bad ? ' down' : ''}">${escapeHtml(item.delta)}</span>` : ''
      const hint = item.hint ? `<span class="kpi-hint">${escapeHtml(item.hint)}</span>` : ''
      return `<div class="kpi"><span class="kpi-label">${escapeHtml(item.label)}</span><span class="kpi-value">${escapeHtml(item.value)}</span>${delta}${hint}</div>`
    })
    .join('')
  return `<div class="kpi-row">${cells}</div>`
}

export function renderWidgets(html) {
  return String(html).replace(WIDGET_RE, (whole, attrs, inner) => {
    const type = /\btype\s*=\s*["']([a-z-]+)["']/i.exec(attrs)?.[1]
    if (type !== 'kpi') return whole
    try {
      return renderKpi(JSON.parse(inner)) ?? whole
    } catch {
      return whole
    }
  })
}

const THEME_SCRIPT = `<script>
(function(){var d=document.documentElement;addEventListener('message',function(e){var m=e.data;if(m&&m.type==='artifacts:theme'&&(m.theme==='light'||m.theme==='dark'||m.theme==='auto')){if(m.theme==='auto')d.removeAttribute('data-theme');else d.setAttribute('data-theme',m.theme)}});})();
</script>`

export function wrapDocument({ title, body, theme, fontBase = '' }) {
  const themeAttr = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''
  const css = DOC_CSS.replaceAll('/static/fonts/', `${fontBase}/static/fonts/`)
  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main class="doc">
${body}
</main>
${THEME_SCRIPT}
</body>
</html>`
}

/** The HTML to serve for a version: as published, or wrapped. */
export function renderVersion({ html, markdown, title, theme, fontBase }) {
  if (typeof html === 'string' && html.trim()) {
    if (isFullDocument(html)) return { html, wrapped: false }
    return { html: wrapDocument({ title, body: renderWidgets(html), theme, fontBase }), wrapped: true }
  }
  return { html: wrapDocument({ title, body: renderMarkdown(markdown ?? ''), theme, fontBase }), wrapped: true }
}
