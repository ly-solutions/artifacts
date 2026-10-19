#!/usr/bin/env node
/**
 * README screenshots of a running server, in light and dark, through headless Chrome's DevTools protocol.
 *
 *   ARTIFACTS_URL=http://localhost:8080 ARTIFACTS_TOKEN=… node scripts/screenshots.mjs <slug-for-the-reader> [out-dir]
 *
 * CHROME (default: google-chrome) picks the browser binary.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = (process.env.ARTIFACTS_URL || 'http://localhost:8080').replace(/\/$/, '')
const token = process.env.ARTIFACTS_TOKEN || ''
const slug = process.argv[2]
const outDir = process.argv[3] || 'docs/screenshots'
if (!slug) {
  console.error('usage: node scripts/screenshots.mjs <slug> [out-dir]')
  process.exit(2)
}

const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, next: '/' }) })
const cookie = login.headers.get('set-cookie')?.split(';')[0]
if (!cookie) throw new Error(`sign-in failed: ${login.status}`)
const [cookieName, cookieValue] = [cookie.slice(0, cookie.indexOf('=')), decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))]

const profile = await mkdtemp(join(tmpdir(), 'artifacts-shots-'))
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

try {
  let port
  for (let i = 0; i < 100 && !port; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]
  }
  if (!port) throw new Error('Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else listeners.forEach((fn) => fn(message))
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      pending.set(mine, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  const loaded = () => new Promise((resolve) => listeners.push((m) => m.method === 'Page.loadEventFired' && resolve()))

  await send('Page.enable')
  await send('Network.enable')
  await send('Network.setCookie', { name: cookieName, value: cookieValue, url: base })
  await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false })

  const shots = [
    ['catalog', '/'],
    ['search', '/?q=incident'],
    ['reader', `/a/${slug}`],
  ]
  for (const theme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    for (const [name, path] of shots) {
      const done = loaded()
      await send('Page.navigate', { url: `${base}${path}` })
      await done
      await new Promise((r) => setTimeout(r, 1200)) // fonts, the document frame, relative dates
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const file = join(outDir, `${name}-${theme}.png`)
      await writeFile(file, Buffer.from(data, 'base64'))
      console.log(file)
    }
  }
  ws.close()
} finally {
  const exited = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill()
  await exited
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
