import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { main } from '../src/cli.mjs'
import { resultsList } from '../src/render/ui.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

async function quietCli(args, env) {
  const out = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // The test runner reports through stdout as binary chunks; the CLI writes strings.
  process.stdout.write = (chunk) => (typeof chunk === 'string' ? out.push(chunk) : origOut(chunk)) && true
  process.stderr.write = () => true
  try {
    return { code: await main(args, env), out: out.join('') }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

describe('pagination', () => {
  let app
  before(async () => {
    app = await startApp()
    for (let i = 1; i <= 7; i += 1) {
      await app.service.publish({ title: `Paged document ${i}`, slug: `paged-doc-${i}`, markdown: `# Paged document ${i}\n\nbody`, tags: ['paged'] })
    }
  })
  after(() => app.close())

  it('pages the list API with nextOffset and a Link header until every item was seen', async () => {
    const seen = []
    let path = '/api/v1/artifacts?tag=paged&limit=3'
    let pages = 0
    for (;;) {
      const page = await app.request('GET', path)
      assert.equal(page.status, 200)
      assert.equal(page.data.total, 7)
      assert.equal(page.data.limit, 3)
      seen.push(...page.data.items.map((item) => item.slug))
      pages += 1
      if (page.data.nextOffset === null) {
        assert.equal(page.headers.get('link'), null)
        break
      }
      assert.equal(page.data.nextOffset, page.data.offset + page.data.items.length)
      const link = /^<([^>]+)>; rel="next"$/.exec(page.headers.get('link'))
      assert.ok(link, 'a next link is advertised')
      const next = new URL(link[1])
      assert.equal(next.origin, 'http://artifacts.test')
      assert.equal(next.searchParams.get('tag'), 'paged')
      path = `${next.pathname}${next.search}`
    }
    assert.equal(pages, 3)
    assert.equal(new Set(seen).size, 7)
  })

  it('clamps the page size and ignores nonsense offsets', async () => {
    const big = await app.request('GET', '/api/v1/artifacts?limit=100000&offset=-4')
    assert.equal(big.data.limit, 500)
    assert.equal(big.data.offset, 0)
    assert.equal(big.data.nextOffset, null)
  })

  it('renders pager links on the catalog page', async () => {
    const html = resultsList({ items: [{ slug: 'a-doc', title: 'A', tags: [], updatedAt: '2026-10-19T00:00:00Z', versionCount: 1 }], total: 450, q: 'x y', tags: ['t'], offset: 200, limit: 200, nextOffset: 201 })
    assert.match(html, /450 artifacts · 201–201/)
    assert.match(html, /<a class="page-link" rel="prev" href="\/\?q=x\+y&amp;tag=t">Newer<\/a>/)
    assert.match(html, /rel="next" href="\/\?q=x\+y&amp;tag=t&amp;offset=201">Older \(249 more\)/)
    const page = await app.request('GET', '/?tag=paged&offset=5', { raw: true, headers: { accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(page.text, /7 artifacts · 6–7/)
    assert.match(page.text, /rel="prev"/)
    const beyond = await app.request('GET', '/?tag=paged&offset=50', { raw: true, headers: { accept: 'text/html' } })
    assert.match(beyond.text, /Back to the first page/)
  })

  it('follows every page in the CLI with --all', async () => {
    const env = { ARTIFACTS_URL: app.base, ARTIFACTS_TOKEN: TOKEN }
    const all = await quietCli(['find', '--tag', 'paged', '--limit', '2', '--all', '--json'], env)
    assert.equal(all.code, 0)
    assert.equal(JSON.parse(all.out).items.length, 7)
    const second = await quietCli(['find', '--tag', 'paged', '--limit', '2', '--offset', '6', '--json'], env)
    assert.equal(JSON.parse(second.out).items.length, 1)
  })
})
