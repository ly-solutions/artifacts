import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { titleSimilarity } from '../src/catalog.mjs'
import { renderMarkdown, renderVersion, renderWidgets } from '../src/render/doc.mjs'
import { htmlToText, isFullDocument, isValidSlug, makeSlug, normalizeTags, normalizeTitle, slugBase, titleFromHtml, titleFromMarkdown } from '../src/text.mjs'

describe('slugs', () => {
  it('derives readable slugs, transliterating Cyrillic and Greek and stripping accents', () => {
    assert.equal(slugBase('Payment flow: Q3 review'), 'payment-flow-q3-review')
    assert.equal(slugBase('Разбор оплаты'), 'razbor-oplaty')
    assert.equal(slugBase('Café déjà vu'), 'cafe-deja-vu')
    assert.equal(slugBase('Αθήνα'), 'athina')
    assert.equal(slugBase('!!!'), 'artifact')
    assert.ok(slugBase('x'.repeat(100)).length <= 48)
  })

  it('adds a random tail and validates', () => {
    const slug = makeSlug('Hello world')
    assert.match(slug, /^hello-world-[a-z0-9]{6}$/)
    assert.ok(isValidSlug(slug))
    for (const bad of ['', 'A', 'Upper', '-x', 'a_b', 'a/b', 'x'.repeat(81)]) assert.equal(isValidSlug(bad), false)
  })
})

describe('titles and tags', () => {
  it('normalises copies to the same title', () => {
    const base = normalizeTitle('Payment flow')
    for (const variant of ['Payment flow (v2)', 'Payment flow — final', 'payment flow v3.1', 'Payment Flow: updated', 'Payment flow 2', 'Payment flow (draft)']) {
      assert.equal(normalizeTitle(variant), base, variant)
    }
    assert.notEqual(normalizeTitle('Payment flow for refunds'), base)
  })

  it('measures title similarity by shared words', () => {
    assert.equal(titleSimilarity('Checkout incident review', 'Checkout incident review v2'), 1)
    assert.ok(titleSimilarity('Checkout incident', 'Billing migration') < 0.6)
  })

  it('normalises tags: trimmed, unique case-insensitively, at most ten', () => {
    assert.deepEqual(normalizeTags(' API, api ,Flow,,  two   words '), ['API', 'Flow', 'two words'])
    assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 10)
    assert.equal(normalizeTags(['x'.repeat(50)])[0].length, 32)
  })

  it('finds a title in documents', () => {
    assert.equal(titleFromHtml('<html><head><title>T &amp; C</title></head></html>'), 'T & C')
    assert.equal(titleFromHtml('<h1>Head <em>line</em></h1>'), 'Head line')
    assert.equal(titleFromMarkdown('intro\n# The title\n'), 'The title')
  })
})

describe('text extraction and rendering', () => {
  it('extracts visible text from HTML', () => {
    const text = htmlToText('<html><head><style>p{}</style><title>x</title></head><body><script>var a=1</script><h1>Hello</h1><p>World &amp; more&nbsp;text</p></body></html>')
    assert.equal(text, 'Hello\nWorld & more text')
  })

  it('tells full documents from fragments', () => {
    assert.ok(isFullDocument('<!doctype html><html></html>'))
    assert.ok(isFullDocument('  <!-- c -->\n<html lang="en">'))
    assert.equal(isFullDocument('<h1>fragment</h1>'), false)
  })

  it('renders Markdown with GFM tables and heading anchors', () => {
    const html = renderMarkdown('# Title\n\n## Part one\n\n## Part one\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done')
    assert.match(html, /<h2 id="part-one">/)
    assert.match(html, /<h2 id="part-one-1">/)
    assert.match(html, /<table>/)
    assert.match(html, /type="checkbox"/)
  })

  it('wraps fragments and Markdown in the typography, serves full documents as published', () => {
    const full = '<!doctype html><html><body>mine</body></html>'
    assert.equal(renderVersion({ html: full, title: 't' }).html, full)
    const wrapped = renderVersion({ html: '<p>frag</p>', title: 'A <b>title</b>', theme: 'dark' })
    assert.equal(wrapped.wrapped, true)
    assert.match(wrapped.html, /<html lang="en" data-theme="dark">/)
    assert.match(wrapped.html, /<title>A &lt;b&gt;title&lt;\/b&gt;<\/title>/)
    assert.match(renderVersion({ markdown: '**bold**', title: 't' }).html, /<strong>bold<\/strong>/)
  })

  it('renders kpi widgets and leaves unknown ones alone', () => {
    const html = renderWidgets('<artifact-widget type="kpi">{"items":[{"label":"Revenue","value":"1.2M","delta":"-3%"}]}</artifact-widget><artifact-widget type="x">{}</artifact-widget>')
    assert.match(html, /class="kpi-row"/)
    assert.match(html, /kpi-delta down/)
    assert.match(renderWidgets('<artifact-widget type="kpi">{"items":[{"label":"Errors","value":"9","delta":"+4","tone":"bad"}]}</artifact-widget>'), /kpi-delta down/)
    assert.match(html, /<artifact-widget type="x">/)
    assert.match(renderWidgets('<artifact-widget type="kpi">not json</artifact-widget>'), /artifact-widget/)
  })
})
