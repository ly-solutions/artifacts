import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { main } from '../src/cli.mjs'
import { PluginHost, loadPluginModules, parseAttributes } from '../src/plugins.mjs'
import { READ_TOKEN, TOKEN, startApp, tempDir } from './helpers/setup.mjs'

const EXAMPLE = new URL('../examples/plugins/github-issue/index.mjs', import.meta.url).pathname

describe('plugin host', () => {
  it('parses widget attributes', () => {
    assert.deepEqual(parseAttributes(` type="status" ref='a&amp;b' data-x=1 hidden`), { type: 'status', ref: 'a&b', 'data-x': '1', hidden: '' })
  })

  it('refuses widgets and routes that would clash or escape their namespace', async () => {
    const host = new PluginHost()
    const tryRegister = (register) => new PluginHost().register([{ name: 'bad', register }])
    await assert.rejects(tryRegister((api) => api.addWidget('kpi', () => '')), /built in/)
    await assert.rejects(tryRegister((api) => api.addWidget('Bad Type', () => '')), /lowercase/)
    await assert.rejects(tryRegister((api) => api.addRoute('GET', '/api/v1/artifacts', () => {})), /plugin routes live under/)
    await assert.rejects(tryRegister((api) => api.addRoute('GET', '/a/:slug/raw', () => {})), /plugin routes live under/)
    await assert.rejects(tryRegister((api) => api.addRoute('TRACE', '/x/a', () => {})), /method/)
    await assert.rejects(tryRegister((api) => api.on('artifact.read', () => {})), /unknown event/)
    await assert.rejects(new PluginHost().register([{ name: 'v2', apiVersion: 2, register() {} }]), /needs plugin API 2/)
    await host.register([{ name: 'one', register: (api) => api.addWidget('chip', () => 'x') }])
    await assert.rejects(host.register([{ name: 'two', register: (api) => api.addWidget('chip', () => 'y') }]), /already registered by plugin "one"/)
  })

  it('keeps the placeholder when a widget returns nothing, throws or hangs', async () => {
    const host = new PluginHost({ widgetTimeoutMs: 50 })
    await host.register([
      {
        name: 'w',
        register(api) {
          api.addWidget('ok', ({ ref }) => `<b>${api.html.escape(ref)}</b>`)
          api.addWidget('none', () => null)
          api.addWidget('boom', () => {
            throw new Error('down')
          })
          api.addWidget('slow', () => new Promise(() => {}))
        },
      },
    ])
    const html = '<p><artifact-widget type="ok" ref="<1>"></artifact-widget> <artifact-widget type="none" ref="a">A</artifact-widget> <artifact-widget type="boom"/> <artifact-widget type="slow"></artifact-widget> <artifact-widget type="unknown"></artifact-widget></p>'
    const out = await host.renderWidgets(html, { phase: 'read', slug: 's' })
    assert.equal(out, '<p><b>&lt;1&gt;</b> <artifact-widget type="none" ref="a">A</artifact-widget> <artifact-widget type="boom"/> <artifact-widget type="slow"></artifact-widget> <artifact-widget type="unknown"></artifact-widget></p>')
  })

  it('reports a module that does not load', async () => {
    await assert.rejects(loadPluginModules(['./no/such/plugin.mjs']), /plugin "\.\/no\/such\/plugin\.mjs" could not be loaded/)
  })
})

describe('plugins in the server', () => {
  let app
  const events = []
  const seen = {}
  before(async () => {
    const recorder = {
      name: 'recorder',
      register(api) {
        api.addWidget('live', {
          phase: 'read',
          render: (ctx) => {
            seen.live = ctx
            return `<span class="live">${ctx.shared ? 'public view' : `v${ctx.version.n} of ${api.html.escape(ctx.slug)}`}</span>`
          },
        })
        api.onPublish((draft, ctx) => {
          seen.publish = ctx
          if (draft.html?.includes('FORBIDDEN')) throw api.error(422, 'refused_by_policy', 'no forbidden words')
          if (draft.markdown) draft.markdown = draft.markdown.replace('{{stamp}}', 'stamped')
        })
        api.onRead((page, ctx) => page.html.replace('</main>', `<footer data-version="${ctx.version.n}"></footer></main>`))
        api.on('artifact.published', (event) => events.push(event))
        api.on('*', (event) => events.push({ any: event.event }))
        api.addRoute('GET', '/api/v1/x/recorder/count', async (ctx) => ({ total: (await ctx.artifacts.list()).total, who: ctx.principal.role }))
        api.addRoute('POST', '/api/v1/x/recorder/echo', async (ctx) => ({ got: await ctx.readJson() }), { auth: 'write' })
        api.addRoute('GET', '/x/recorder/hello', (ctx) => ctx.html(200, '<p>hello</p>'), { auth: 'none' })
        api.addRoute('GET', '/a/:slug/x/summary', async (ctx) => {
          const artifact = await ctx.artifacts.get(ctx.params.slug)
          if (!artifact) throw api.error(404, 'not_found')
          return { title: artifact.title, versions: artifact.versionCount }
        })
        api.addRoute('GET', '/x/recorder/crash', () => {
          throw new Error('bug')
        }, { auth: 'none' })
      },
    }
    const examples = await loadPluginModules([EXAMPLE])
    app = await startApp({}, { plugins: [...examples, recorder] })
  })
  after(() => app.close())

  it('renders a publish widget into the stored version (the example plugin)', async () => {
    const created = await app.request('POST', '/api/v1/artifacts', { body: { title: 'With an issue', slug: 'with-issue', html: '<p>See <artifact-widget type="github-issue" ref="ly-solutions/artifacts#12" title="Pagination"></artifact-widget> and <artifact-widget type="github-issue" ref="not a ref">x</artifact-widget></p>' } })
    assert.equal(created.status, 201)
    const source = await app.request('GET', '/api/v1/artifacts/with-issue/content', { raw: true })
    assert.match(source.text, /<a class="artifact-chip" href="https:\/\/github\.com\/ly-solutions\/artifacts\/issues\/12" target="_blank" rel="noopener noreferrer"><svg[^>]*>.*<\/svg><span>ly-solutions\/artifacts#12 · Pagination<\/span><\/a>/)
    assert.match(source.text, /<artifact-widget type="github-issue" ref="not a ref">x<\/artifact-widget>/, 'an invalid reference stays a placeholder')
    const link = await app.request('GET', `/api/v1/x/github-issue/link?ref=${encodeURIComponent('a/b#3')}`)
    assert.deepEqual(link.data, { ref: 'a/b#3', url: 'https://github.com/a/b/issues/3' })
    assert.equal((await app.request('GET', '/api/v1/x/github-issue/link?ref=nope')).status, 400)
  })

  it('renders publish widgets of a Markdown-only version at read time', async () => {
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Markdown issue', slug: 'markdown-issue', markdown: '# Markdown issue\n\n<artifact-widget type="github-issue" ref="o/r#1"></artifact-widget>\n' } })
    const raw = await app.request('GET', '/a/markdown-issue/raw', { raw: true })
    assert.match(raw.text, /href="https:\/\/github\.com\/o\/r\/issues\/1"/)
    const source = await app.request('GET', '/api/v1/artifacts/markdown-issue/content?format=markdown', { raw: true })
    assert.match(source.text, /<artifact-widget/, 'the Markdown source is kept as written')
  })

  it('renders read widgets and read hooks on every view, telling members from link holders', async () => {
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Live doc', slug: 'live-doc', html: '<p><artifact-widget type="live"></artifact-widget></p>' } })
    const source = await app.request('GET', '/api/v1/artifacts/live-doc/content', { raw: true })
    assert.match(source.text, /<artifact-widget type="live">/, 'read widgets are not stored')
    const member = await app.request('GET', '/a/live-doc/raw', { token: READ_TOKEN, raw: true })
    assert.match(member.text, /<span class="live">v1 of live-doc<\/span>/)
    assert.match(member.text, /<footer data-version="1"><\/footer><\/main>/)
    assert.equal(seen.live.phase, 'read')
    assert.equal(seen.live.version.n, 1)
    const { url } = await app.service.share('live-doc')
    const shared = await app.request('GET', `${new URL(url).pathname}/raw`, { token: null, raw: true })
    assert.match(shared.text, /<span class="live">public view<\/span>/)
  })

  it('lets publish hooks change and refuse documents', async () => {
    const refused = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Bad', html: '<p>FORBIDDEN</p>' } })
    assert.equal(refused.status, 422)
    assert.deepEqual(refused.data, { error: 'refused_by_policy', hint: 'no forbidden words' })
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Stamped', slug: 'stamped-doc', markdown: '# Stamped\n\n{{stamp}}' } })
    const md = await app.request('GET', '/api/v1/artifacts/stamped-doc/content?format=markdown', { raw: true })
    assert.match(md.text, /stamped$/)
    assert.equal(seen.publish.principal.role, 'editor')
    assert.equal(seen.publish.existing, null)
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Stamped', slug: 'stamped-doc', markdown: '# Stamped\n\nagain' } })
    assert.equal(seen.publish.existing.slug, 'stamped-doc')
  })

  it('delivers change events', async () => {
    await app.request('POST', '/api/v1/artifacts', { body: { title: 'Evented', slug: 'evented', markdown: '# e' } })
    await new Promise((resolve) => setImmediate(resolve))
    const published = events.find((event) => event.event === 'artifact.published' && event.artifact.slug === 'evented')
    assert.ok(published)
    assert.equal(published.artifact.viewUrl, 'http://artifacts.test/a/evented')
    assert.ok(events.some((event) => event.any === 'artifact.published'))
  })

  it('serves plugin routes with their declared access', async () => {
    const count = await app.request('GET', '/api/v1/x/recorder/count', { token: READ_TOKEN })
    assert.equal(count.status, 200)
    assert.equal(count.data.who, 'viewer')
    assert.ok(count.data.total >= 1)
    assert.equal((await app.request('GET', '/api/v1/x/recorder/count', { token: null })).status, 401)
    assert.equal((await app.request('GET', '/api/v1/x/recorder/count', { token: null, raw: true, headers: { accept: 'text/html' } })).status, 401, 'API paths answer JSON, not a sign-in redirect')

    assert.equal((await app.request('POST', '/api/v1/x/recorder/echo', { token: READ_TOKEN, body: { a: 1 } })).status, 403)
    assert.deepEqual((await app.request('POST', '/api/v1/x/recorder/echo', { body: { a: 1 } })).data, { got: { a: 1 } })

    const hello = await app.request('GET', '/x/recorder/hello', { token: null, raw: true })
    assert.equal(hello.text, '<p>hello</p>')
    assert.match(hello.headers.get('content-security-policy'), /script-src 'self'/)
    const head = await fetch(`${app.base}/x/recorder/hello`, { method: 'HEAD' })
    assert.equal(head.status, 200)

    assert.deepEqual((await app.request('GET', '/a/live-doc/x/summary')).data, { title: 'Live doc', versions: 1 })
    assert.equal((await app.request('GET', '/a/missing-doc/x/summary')).status, 404)
    assert.equal((await app.request('GET', '/a/live-doc/x/nothing-here', { raw: true })).status, 404)
    const loginRedirect = await app.request('GET', '/a/live-doc/x/summary', { token: null, raw: true, headers: { accept: 'text/html' } })
    assert.equal(loginRedirect.status, 302, 'a browser without a session is sent to sign in')

    const crash = await app.request('GET', '/x/recorder/crash', { token: null })
    assert.equal(crash.status, 500)
    assert.equal(crash.data.error, 'plugin_error')
  })
})

describe('serve with plugins', () => {
  it('loads ARTIFACTS_PLUGINS at start and refuses to start with a broken one', async () => {
    const tmp = await tempDir()
    const broken = join(tmp.dir, 'broken.mjs')
    await writeFile(broken, 'export default function register (api) { api.addWidget("kpi", () => "") }\n')
    const errors = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => (typeof chunk === 'string' && chunk.includes('"level":"error"') ? errors.push(chunk) : write(chunk)) && true
    try {
      const env = { ARTIFACTS_STORAGE: 'fs', ARTIFACTS_DATA_DIR: tmp.dir, ARTIFACTS_TOKEN: TOKEN, ARTIFACTS_PORT: '0', ARTIFACTS_HOST: '127.0.0.1', ARTIFACTS_LOG_LEVEL: 'error' }
      assert.equal(await main(['serve'], { ...env, ARTIFACTS_PLUGINS: './missing-plugin.mjs' }), 2)
      assert.equal(await main(['serve'], { ...env, ARTIFACTS_PLUGINS: broken }), 2)
    } finally {
      process.stdout.write = write
      await tmp.cleanup()
    }
    assert.ok(errors.some((line) => line.includes('missing-plugin.mjs')))
    assert.ok(errors.some((line) => line.includes('is built in')))
  })
})
