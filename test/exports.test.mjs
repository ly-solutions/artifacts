import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('package entry points', () => {
  it('points every export at a published file', () => {
    for (const [entry, target] of Object.entries(pkg.exports)) {
      assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${entry} -> ${target} exists`)
      const top = target.replace(/^\.\//, '').split('/')[0]
      assert.ok(top === 'package.json' || pkg.files.includes(top), `${target} is in "files"`)
    }
  })

  it('exposes the server, storage and helpers by package name', async () => {
    const main = await import('@ly-solutions/artifacts')
    for (const name of ['createApp', 'loadConfig', 'validateConfig', 'ArtifactService', 'ApiError', 'FsStorage', 'S3Storage', 'createStorage', 'diffTexts', 'unifiedDiff', 'PluginHost', 'loadPluginModules', 'PLUGIN_API_VERSION', 'escapeHtml', 'fillUrlTemplate']) {
      assert.ok(main[name] !== undefined, `${name} is exported`)
    }
  })

  it('gives plugin packages their helpers', async () => {
    const kit = await import('@ly-solutions/artifacts/plugin')
    assert.equal(kit.PLUGIN_API_VERSION, 1)
    assert.equal(kit.escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;')
    assert.deepEqual(kit.parseAttributes('type="t" ref="r"'), { type: 't', ref: 'r' })
    const register = () => {}
    assert.equal(kit.definePlugin(register), register)
    assert.ok(new kit.ApiError(404, 'not_found') instanceof Error)
    const { unifiedDiff, diffTexts } = await import('@ly-solutions/artifacts/diff')
    assert.match(unifiedDiff(diffTexts('a\n', 'b\n').blocks), /-a\n\+b/)
    assert.equal((await import('@ly-solutions/artifacts/text')).isValidSlug('a-doc'), true)
  })

  it('keeps internal files private', async () => {
    await assert.rejects(import('@ly-solutions/artifacts/src/server.mjs'), (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  it('serves a plugin passed by package import end to end', async () => {
    const { createApp, loadConfig, FsStorage } = await import('@ly-solutions/artifacts')
    const { definePlugin } = await import('@ly-solutions/artifacts/plugin')
    const { tempDir } = await import('./helpers/tmp.mjs')
    const tmp = await tempDir()
    const plugin = { name: 'pkg-test', register: definePlugin((api) => api.addRoute('GET', '/x/pkg-test', () => ({ ok: true }), { auth: 'none' })) }
    const { server } = await createApp(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'none', ARTIFACTS_SECRET: 'x'.repeat(32) }), { storage: new FsStorage({ dir: tmp.dir }), log: () => {}, plugins: [plugin] })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/x/pkg-test`)
      assert.deepEqual(await res.json(), { ok: true })
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await tmp.cleanup()
    }
  })
})
