import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { pickEncoding } from '../src/static-assets.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

/** A raw GET (fetch would decode the body): status, headers and the bytes as sent. */
function rawGet(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('static files and compression (HRN-1516)', () => {
  let app
  before(async () => {
    app = await startApp({ ARTIFACTS_APP_VIEW: 'on' })
  })
  after(() => app.close())

  it('puts a content version on every address of the app page and loads the editor lazily', async () => {
    const page = (await app.request('GET', '/app', { token: null, raw: true })).text
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
    assert.ok(scripts.length >= 5)
    for (const src of scripts) assert.match(src, /^\/static\/[\w/.-]+\.js\?v=[\w-]{12}$/)
    // The list does not carry the editor, the comments or the HTML editor; they are named for later.
    assert.equal(scripts.some((s) => /docs\/(md|text-doc|panel|html-doc)\.js/.test(s)), false)
    const versions = JSON.parse(/<script type="application\/json" id="dx-lazy">([^<]*)<\/script>/.exec(page)[1])
    assert.deepEqual(Object.keys(versions), ['md', 'text-doc', 'panel', 'html-doc'])
    for (const [name, v] of Object.entries(versions)) {
      const res = await rawGet(app.base, `/static/docs/${name}.js?v=${v}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
    }
  })

  it('caches a bare address for an hour and revalidates it by the ETag', async () => {
    const first = await rawGet(app.base, '/static/docs/docs.css')
    assert.equal(first.status, 200)
    assert.equal(first.headers['cache-control'], 'public, max-age=3600')
    assert.match(first.headers.etag, /^"[\w-]{12}"$/)
    const again = await rawGet(app.base, '/static/docs/docs.css', { 'if-none-match': first.headers.etag })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)
    // A version that is not the file's own (an old page after a release) is not cached for a year.
    const stale = await rawGet(app.base, '/static/docs/docs.css?v=000000000000')
    assert.equal(stale.headers['cache-control'], 'public, max-age=3600')
  })

  it('sends text files compressed to the clients that take it, the same bytes once decoded', async () => {
    const plain = await rawGet(app.base, '/static/docs/text-doc.js')
    assert.equal(plain.headers['content-encoding'], undefined)
    const br = await rawGet(app.base, '/static/docs/text-doc.js', { 'accept-encoding': 'gzip, deflate, br' })
    assert.equal(br.headers['content-encoding'], 'br')
    assert.equal(br.headers.vary, 'accept-encoding')
    assert.ok(br.body.length < plain.body.length / 3)
    assert.deepEqual(brotliDecompressSync(br.body), plain.body)
    const gz = await rawGet(app.base, '/static/docs/text-doc.js', { 'accept-encoding': 'gzip' })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.deepEqual(gunzipSync(gz.body), plain.body)
    // Fonts are compressed already; sandboxed documents still may fetch them.
    const font = await rawGet(app.base, '/static/fonts/geist-400.woff2', { 'accept-encoding': 'br' })
    assert.equal(font.headers['content-encoding'], undefined)
    assert.equal(font.headers['access-control-allow-origin'], '*')
  })

  it('compresses large JSON and pages, leaves small answers as they are', async () => {
    const markdown = `# Long\n\n${'Строка текста документа. '.repeat(400)}`
    const created = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Long', markdown } })
    assert.equal(created.status, 201)
    const slug = created.data.artifact.slug
    const big = await rawGet(app.base, `/api/v1/artifacts/${slug}/content?format=markdown`, { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'br' })
    assert.equal(big.status, 200)
    assert.equal(big.headers['content-encoding'], 'br')
    assert.equal(brotliDecompressSync(big.body).toString(), markdown)
    const small = await rawGet(app.base, '/healthz', { 'accept-encoding': 'br' })
    assert.equal(small.headers['content-encoding'], undefined)
  })

  it('reads Accept-Encoding with q-values', () => {
    assert.equal(pickEncoding('gzip, deflate, br'), 'br')
    assert.equal(pickEncoding('br;q=0, gzip'), 'gzip')
    assert.equal(pickEncoding('identity'), null)
    assert.equal(pickEncoding(undefined), null)
  })
})
