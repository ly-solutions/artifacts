import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { loadConfig } from '../src/config.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

const SECRET = 'hub-events-secret-123'

/** A receiver of the events: keeps what came in. */
async function startReceiver() {
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(204).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const waitFor = async (count) => {
    for (let i = 0; i < 100 && received.length < count; i++) await new Promise((r) => setTimeout(r, 20))
    return received
  }
  return { received, waitFor, url: `http://127.0.0.1:${server.address().port}/events`, close: () => new Promise((r) => server.close(r)) }
}

const mcp = async (app, name, args) => (await app.request('POST', '/mcp', {
  token: TOKEN,
  body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  headers: { accept: 'application/json, text/event-stream' },
})).data.result

describe('comment events for the hub', () => {
  let receiver
  let people
  let agent
  const ada = { 'x-forwarded-user': 'ada', 'x-forwarded-email': 'Ada@Example.com', origin: 'http://artifacts.test' }

  before(async () => {
    receiver = await startReceiver()
    const env = { ARTIFACTS_HUB_EVENTS_URL: receiver.url, ARTIFACTS_HUB_EVENTS_SECRET: SECRET }
    people = await startApp({ ...env, ARTIFACTS_APP_VIEW: 'true', ARTIFACTS_AUTH: 'proxy', ARTIFACTS_EDITORS: '*', ARTIFACTS_PROXY_TRUSTED_CIDRS: '127.0.0.1/32,::1/128' })
    agent = await startApp({ ...env, ARTIFACTS_APP_VIEW: 'true' })
    for (const app of [people, agent]) {
      const created = await app.request('POST', '/api/v1/artifacts', { body: { title: 'План', markdown: '# План\n\nПереезжаем в субботу.\n' } })
      assert.equal(created.status, 201, created.text)
      app.slug = created.data.artifact.slug
    }
  })
  after(async () => {
    await people.close()
    await agent.close()
    await receiver.close()
  })

  it('has no events by default', () => {
    assert.deepEqual(loadConfig({ ARTIFACTS_AUTH: 'token', ARTIFACTS_TOKEN: TOKEN }).hubEvents, { url: '', secret: '' })
  })

  it('sends a thread of a person with @harnessly, then a reply, with the secret', async () => {
    const made = await people.request('POST', '/app/comments', { token: null, headers: ada, body: { slug: people.slug, anchor: { kind: 'text', quote: 'в субботу' }, text: 'Сделай @harnessly дату точнее' } })
    assert.equal(made.status, 201, made.text)
    const [created] = await receiver.waitFor(1)
    assert.equal(created.headers['x-boards-webhook-secret'], SECRET)
    assert.equal(created.headers['content-type'], 'application/json')
    const thread = made.data.thread
    assert.deepEqual(created.body, {
      kind: 'doc',
      event: 'thread.created',
      slug: people.slug,
      title: 'План',
      thread: { id: thread.id, anchor: { label: 'в субботу' } },
      message: {
        id: thread.messages[0].id,
        text: 'Сделай @harnessly дату точнее',
        author: 'ada',
        authorEmail: 'Ada@Example.com',
        authorKind: 'person',
        authorId: 'ada@example.com',
        mentions: [{ name: 'harnessly', agent: true }],
      },
    })

    const replied = await people.request('POST', '/app/comments/reply', { token: null, headers: ada, body: { slug: people.slug, thread: thread.id, text: 'Спасибо' } })
    assert.equal(replied.status, 200, replied.text)
    const second = (await receiver.waitFor(2))[1]
    assert.equal(second.body.event, 'thread.replied')
    assert.equal(second.body.thread.id, thread.id)
    assert.equal(second.body.message.id, replied.data.message.id)
    assert.deepEqual(second.body.message.mentions, [])
  })

  it('sends the answers of the agent from MCP: reply, comment and the answer of an edit', async () => {
    const before = receiver.received.length
    const started = await mcp(agent, 'doc_comment', { slug: agent.slug, text: 'Вопрос по документу' })
    const thread = started.structuredContent.thread
    await mcp(agent, 'doc_reply', { slug: agent.slug, thread, text: 'Готово' })
    await mcp(agent, 'doc_edit', { slug: agent.slug, find: 'в субботу', replace: 'в субботу, 21 ноября', thread, reply: 'Дату уточнил' })
    const got = (await receiver.waitFor(before + 3)).slice(before)
    assert.deepEqual(got.map((e) => e.body.event).sort(), ['thread.created', 'thread.replied', 'thread.replied'])
    for (const e of got) {
      assert.equal(e.headers['x-boards-webhook-secret'], SECRET)
      assert.equal(e.body.message.authorKind, 'agent')
      assert.equal(e.body.message.author, 'Агент')
      assert.equal(e.body.message.authorEmail, null)
      assert.equal(e.body.message.authorId, '')
      assert.equal(e.body.title, 'План')
    }
    assert.equal(got.find((e) => e.body.event === 'thread.created').body.thread.anchor.label, null)
    assert.deepEqual(got.map((e) => e.body.message.text).sort(), ['Вопрос по документу', 'Готово', 'Дату уточнил'])
  })

  it('sends nothing when the url is empty', async () => {
    const quiet = await startApp({ ARTIFACTS_APP_VIEW: 'true' })
    try {
      const created = await quiet.request('POST', '/api/v1/artifacts', { body: { title: 'Тишина', markdown: '# Тишина\n' } })
      const made = await mcp(quiet, 'doc_comment', { slug: created.data.artifact.slug, text: 'Привет @harnessly' })
      assert.ok(!made.isError, JSON.stringify(made))
      const count = receiver.received.length
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(receiver.received.length, count)
    } finally {
      await quiet.close()
    }
  })
})
