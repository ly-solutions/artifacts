import { loadConfig } from '../../src/config.mjs'
import { createApp } from '../../src/server.mjs'
import { FsStorage } from '../../src/storage/fs.mjs'
import { tempDir } from './tmp.mjs'

export const TOKEN = 'editor-token-0123456789abcdef'
export const READ_TOKEN = 'reader-token-0123456789abcdef'

export { tempDir } from './tmp.mjs'

export function testConfig(env = {}) {
  return loadConfig({
    ARTIFACTS_STORAGE: 'fs',
    ARTIFACTS_AUTH: 'token',
    ARTIFACTS_TOKEN: TOKEN,
    ARTIFACTS_READ_TOKEN: READ_TOKEN,
    ARTIFACTS_SECRET: 'fixture'.repeat(6),
    ARTIFACTS_PUBLIC_URL: 'http://artifacts.test',
    ARTIFACTS_INDEX_REFRESH: '0s',
    ...env,
  })
}

/** Starts the HTTP app on a random port with fs storage (or the given storage). */
export async function startApp(env = {}, { storage, fetchImpl, plugins } = {}) {
  const tmp = await tempDir()
  const config = testConfig(env)
  const store = storage ?? new FsStorage({ dir: tmp.dir })
  const { server, service, auth } = await createApp(config, { storage: store, log: () => {}, fetchImpl, plugins })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, { body, token = TOKEN, headers = {}, raw = false } = {}) => {
    const h = { ...headers }
    if (token) h.authorization = `Bearer ${token}`
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json'
    const response = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' })
    const text = await response.text()
    let data = null
    if (!raw) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return { status: response.status, headers: response.headers, text, data }
  }
  return {
    base,
    config,
    service,
    auth,
    storage: store,
    request,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await tmp.cleanup()
    },
  }
}
