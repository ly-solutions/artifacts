import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { loadConfig } from '../src/config.mjs'
import { Signer, issueViewTicket, viewTicketValid } from '../src/signing.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

const HOST = 'https://hub.example'

async function publish(app, title) {
  const created = await app.request('POST', '/api/v1/artifacts', { body: { title, html: `<h1>${title}</h1>` } })
  assert.equal(created.status, 201, created.text)
  return created.data.artifact.slug
}

async function mcp(app, name, args) {
  const response = await app.request('POST', '/mcp', {
    token: TOKEN,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers: { accept: 'application/json, text/event-stream' },
  })
  return response.data.result
}

describe('app view switch', () => {
  it('is off by default', () => {
    assert.equal(loadConfig({}).appView.enabled, false)
  })

  it('serves nothing at /app and keeps doc_open closed while off', async () => {
    const app = await startApp()
    try {
      assert.equal((await app.request('GET', '/app', { token: null, raw: true })).status, 404)
      const slug = await publish(app, 'Off')
      const result = await mcp(app, 'doc_open', { slug })
      assert.equal(result.isError, true)
      const raw = await app.request('GET', `/a/${slug}/raw?t=anything`, { token: null, raw: true })
      assert.notEqual(raw.status, 200)
    } finally {
      await app.close()
    }
  })
})

describe('app view on', () => {
  let app
  before(async () => {
    app = await startApp({ ARTIFACTS_APP_VIEW: 'true', ARTIFACTS_FRAME_ANCESTORS: HOST })
  })
  after(() => app.close())

  it('serves the view page with the bridge first, framed only by the embed list', async () => {
    const page = await app.request('GET', '/app', { token: null, raw: true })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${HOST}(;|$)`))
    const shim = page.text.indexOf('hl/bridge-shim.js')
    assert.ok(shim > 0 && shim < page.text.indexOf('hl/app-sdk.classic.js') && shim < page.text.indexOf('app-view.js'))
    assert.equal((await app.request('GET', '/static/app-view.js', { token: null, raw: true })).status, 200)
  })

  it('opens a document by a short ticket of its own', async () => {
    const slug = await publish(app, 'Plan')
    const other = await publish(app, 'Other')
    const result = await mcp(app, 'doc_open', { slug, theme: 'dark' })
    assert.ok(!result.isError, JSON.stringify(result))
    const opened = result.structuredContent
    assert.equal(opened.title, 'Plan')
    assert.match(opened.contentUrl, new RegExp(`^/a/${slug}/raw\\?t=[^&]+&theme=dark$`))
    const raw = await app.request('GET', opened.contentUrl, { token: null, raw: true })
    assert.equal(raw.status, 200)
    assert.match(raw.text, /Plan/)
    assert.match(raw.headers.get('content-security-policy'), /sandbox/)
    const ticket = new URL(opened.contentUrl, 'http://x').searchParams.get('t')
    assert.equal((await app.request('GET', `/a/${other}/raw?t=${encodeURIComponent(ticket)}`, { token: null, raw: true })).status, 401)
  })

  it('marks the person\'s own documents in doc_find', async () => {
    const found = (await mcp(app, 'doc_find', {})).structuredContent
    assert.ok(found.items.length >= 1)
    for (const item of found.items) assert.equal(typeof item.mine, 'boolean')
  })
})

describe('view tickets', () => {
  const signer = new Signer('fixture'.repeat(6))
  it('belong to one document and expire', () => {
    const now = Date.now()
    const ticket = issueViewTicket(signer, 'plan-a1', now)
    assert.equal(viewTicketValid(signer, ticket, 'plan-a1', now), true)
    assert.equal(viewTicketValid(signer, ticket, 'other-b2', now), false)
    assert.equal(viewTicketValid(signer, ticket, 'plan-a1', now + 301_000), false)
    assert.equal(viewTicketValid(signer, 'garbage', 'plan-a1', now), false)
  })
})
