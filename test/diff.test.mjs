import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { main } from '../src/cli.mjs'
import { diffLines, diffTexts, splitLines, unifiedDiff } from '../src/diff.mjs'
import { READ_TOKEN, TOKEN, startApp } from './helpers/setup.mjs'

describe('line diff', () => {
  it('splits lines without a phantom last line', () => {
    assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b'])
    assert.deepEqual(splitLines(''), [])
    assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b'])
  })

  it('finds a minimal edit script', () => {
    const { blocks, approximate } = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
    assert.equal(approximate, false)
    assert.deepEqual(blocks, [
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'added', text: 'e' },
    ])
  })

  it('falls back to an approximate diff past the edit limit, keeping the common ends', () => {
    const a = ['top', '1', '2', '3', 'bottom']
    const b = ['top', 'x', 'y', 'z', 'bottom']
    const { blocks, approximate } = diffLines(a, b, { maxEdits: 2 })
    assert.equal(approximate, true)
    assert.deepEqual(blocks.map((block) => block.kind), ['same', 'removed', 'removed', 'removed', 'added', 'added', 'added', 'same'])
  })

  it('writes a unified diff like diff -u', () => {
    const { blocks, stats } = diffTexts('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n', 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\nnine\nten\n')
    assert.deepEqual(stats, { added: 2, removed: 1, same: 8 })
    assert.equal(
      unifiedDiff(blocks, { fromLabel: 'old', toLabel: 'new', context: 2 }),
      '--- old\n+++ new\n@@ -2,5 +2,5 @@\n two\n three\n-four\n+FOUR\n five\n six\n@@ -8,2 +8,3 @@\n eight\n nine\n+ten\n',
    )
    assert.equal(unifiedDiff(diffTexts('same\n', 'same\n').blocks), '')
    assert.equal(unifiedDiff(diffTexts('', 'new\n').blocks), '--- a\n+++ b\n@@ -0,0 +1 @@\n+new\n')
  })
})

describe('version diff API', () => {
  let app
  before(async () => {
    app = await startApp()
    await app.service.publish({ title: 'Diffed', slug: 'diffed', markdown: '# Diffed\n\nBurst: 20\nRate: 100\n' })
    await app.service.publish({ title: 'Diffed', slug: 'diffed', markdown: '# Diffed\n\nBurst: 40\nRate: 100\n' })
    await app.service.publish({ title: 'Diffed', slug: 'diffed', html: '<h1>Diffed</h1><p>Burst: 40</p><p style="color:red">Rate: 120</p>' })
  })
  after(() => app.close())

  it('compares the last two versions by default, by visible text when one has no Markdown', async () => {
    const res = await app.request('GET', '/api/v1/artifacts/diffed/diff', { token: READ_TOKEN })
    assert.equal(res.status, 200)
    assert.deepEqual([res.data.from.n, res.data.to.n, res.data.source], [2, 3, 'text'])
    const of = (kind) => res.data.blocks.filter((b) => b.kind === kind).map((b) => b.text)
    assert.deepEqual(of('same'), ['Burst: 40'], 'the unchanged paragraph matches across Markdown and HTML')
    assert.deepEqual(of('removed'), ['# Diffed', '', 'Rate: 100'])
    assert.deepEqual(of('added'), ['Diffed', 'Rate: 120'])
    assert.ok(!res.data.blocks.some((b) => /color/.test(b.text)), 'styling is not text')
  })

  it('compares Markdown sources when both versions have one, by number or id', async () => {
    const { meta } = await app.service.get('diffed')
    const res = await app.request('GET', `/api/v1/artifacts/diffed/diff?from=1&to=${meta.versions[1].id}`)
    assert.equal(res.data.source, 'markdown')
    assert.deepEqual(res.data.stats, { added: 1, removed: 1, same: 3 })
    assert.equal(res.data.to.id, meta.versions[1].id)
    const forced = await app.request('GET', '/api/v1/artifacts/diffed/diff?from=1&to=3&source=markdown')
    assert.equal(forced.status, 404)
    assert.equal(forced.data.error, 'no_markdown')
    assert.equal((await app.request('GET', '/api/v1/artifacts/diffed/diff?source=html')).status, 400)
    assert.equal((await app.request('GET', '/api/v1/artifacts/diffed/diff?from=9')).data.error, 'version_not_found')
  })

  it('returns a unified patch on request', async () => {
    const res = await app.request('GET', '/api/v1/artifacts/diffed/diff?from=1&to=2&format=unified', { raw: true })
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(res.headers.get('x-diff-source'), 'markdown')
    assert.match(res.text, /^--- diffed@v1 \(\S+\)\n\+\+\+ diffed@v2 \(\S+\)\n@@ -1,4 \+1,4 @@\n # Diffed\n \n-Burst: 20\n\+Burst: 40\n Rate: 100\n$/)
  })

  it('keeps the earlier service shape on /a/{slug}/diff and its reading rights', async () => {
    const { meta } = await app.service.get('diffed')
    const res = await app.request('GET', `/a/diffed/diff?from=${meta.versions[0].id}&to=${meta.versions[1].id}`, { token: READ_TOKEN })
    assert.equal(res.status, 200)
    assert.equal(res.data.from, meta.versions[0].id)
    assert.equal(res.data.to, meta.versions[1].id)
    assert.deepEqual(res.data.stats, { added: 1, removed: 1, same: 3 })
    assert.ok(res.data.blocks.some((b) => b.kind === 'added' && b.text === 'Burst: 40'))
    assert.equal((await app.request('GET', '/a/diffed/diff', { token: null })).status, 401)
    assert.equal((await app.request('GET', '/a/missing-doc/diff')).status, 404)
    assert.equal((await app.request('GET', '/embed/diffed/diff', { raw: true })).status, 404)
  })

  it('prints a diff from the CLI', async () => {
    const out = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => (typeof chunk === 'string' ? out.push(chunk) : orig(chunk)) && true
    let code
    try {
      code = await main(['diff', 'diffed', '1', '2'], { ARTIFACTS_URL: app.base, ARTIFACTS_TOKEN: TOKEN })
    } finally {
      process.stdout.write = orig
    }
    assert.equal(code, 0)
    assert.match(out.join(''), /-Burst: 20\n\+Burst: 40/)
  })
})
