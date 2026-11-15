import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { replaceOnce } from '../src/app-api.mjs'
import { mentionsAgent } from '../src/comments.mjs'
import { TOKEN, startApp } from './helpers/setup.mjs'

async function mcp(app, name, args) {
  const response = await app.request('POST', '/mcp', {
    token: TOKEN,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers: { accept: 'application/json, text/event-stream' },
  })
  return response.data.result
}

describe('the agent in the comments', () => {
  let app
  let slug
  before(async () => {
    app = await startApp({ ARTIFACTS_APP_VIEW: 'true' })
    const created = await app.request('POST', '/api/v1/artifacts', {
      body: { title: 'План', markdown: '# План\n\nПереезжаем в субботу.\n\nКлючи у администратора. Ключи нужны всем.\n' },
    })
    assert.equal(created.status, 201, created.text)
    slug = created.data.artifact.slug
  })
  after(() => app.close())

  it('reads a thread, changes the text, answers in the thread, and the change can be told apart', async () => {
    const started = await mcp(app, 'doc_comment', { slug, quote: 'в субботу', text: 'Уточните дату' })
    assert.ok(!started.isError, JSON.stringify(started))
    const thread = started.structuredContent.thread

    const read = (await mcp(app, 'doc_comments', { slug })).structuredContent
    assert.equal(read.threads.length, 1)
    assert.equal(read.threads[0].anchor.quote, 'в субботу')
    assert.equal(read.threads[0].messages[0].by, 'agent')

    const noReply = await mcp(app, 'doc_edit', { slug, find: 'в субботу', replace: 'в субботу, 21 ноября', thread })
    assert.equal(noReply.isError, true)

    const edited = await mcp(app, 'doc_edit', { slug, find: 'в субботу', replace: 'в субботу, 21 ноября', thread, reply: 'Дописал дату' })
    assert.ok(!edited.isError, JSON.stringify(edited))
    assert.equal(edited.structuredContent.version, 2)
    assert.equal(typeof edited.structuredContent.edit, 'string')

    const shown = await app.request('GET', `/api/v1/artifacts/${slug}/content?format=markdown`, { raw: true })
    assert.match(shown.text, /в субботу, 21 ноября/)

    const after = (await mcp(app, 'doc_comments', { slug, status: 'all' })).structuredContent.threads[0]
    assert.equal(after.messages.length, 2)
  })

  it('refuses a fragment that is missing or occurs twice', async () => {
    const missing = await mcp(app, 'doc_edit', { slug, find: 'нет такого', replace: 'x' })
    assert.equal(missing.isError, true)
    const twice = await mcp(app, 'doc_edit', { slug, find: 'Ключи', replace: 'Ключ' })
    assert.equal(twice.isError, true)
  })

  it('gives an HTML page back an address to look at, and a text none', async () => {
    const page = await app.request('POST', '/api/v1/artifacts', { body: { title: 'Страница', html: '<p>Привет</p>' } })
    const edited = await mcp(app, 'doc_edit', { slug: page.data.artifact.slug, find: 'Привет', replace: 'Здравствуйте', note: 'Поздоровался вежливее' })
    assert.ok(!edited.isError, JSON.stringify(edited))
    assert.match(edited.structuredContent.look.url, new RegExp(page.data.artifact.slug))
    assert.match(edited.structuredContent.look.how, /picture/)
    const text = await mcp(app, 'doc_edit', { slug, find: 'Переезжаем', replace: 'Переезжаем все', note: 'Уточнил' })
    assert.equal(text.structuredContent.look, undefined)
  })

  it('resolves a thread with the reply', async () => {
    const thread = (await mcp(app, 'doc_comment', { slug, text: 'Вопрос по всему документу' })).structuredContent.thread
    const replied = await mcp(app, 'doc_reply', { slug, thread, text: 'Готово', resolve: true })
    assert.ok(!replied.isError, JSON.stringify(replied))
    const open = (await mcp(app, 'doc_comments', { slug })).structuredContent.threads
    assert.ok(!open.some((t) => t.id === thread))
  })
})

describe('fragment replacement', () => {
  it('replaces exactly one place', () => {
    assert.equal(replaceOnce('a b c', 'b', 'X'), 'a X c')
  })
  it('says why it cannot', () => {
    assert.throws(() => replaceOnce('a b b', 'b', 'X'), (error) => error.code === 'fragment_ambiguous')
    assert.throws(() => replaceOnce('a', 'z', 'X'), (error) => error.code === 'fragment_not_found')
    assert.throws(() => replaceOnce('a', '', 'X'))
  })
})

describe('the call of the agent', () => {
  it('is found in the text only as its own word', () => {
    assert.equal(mentionsAgent('@агент, поправь'), true)
    assert.equal(mentionsAgent('привет @agent'), true)
    assert.equal(mentionsAgent('почта a@агентство.ру'), false)
    assert.equal(mentionsAgent('@агентство'), false)
  })
})

describe('who owns a thread', () => {
  it('is a stable id, not a name', async () => {
    const { cleanAuthor, personId, mayComment } = await import('../src/comments.mjs')
    assert.equal(cleanAuthor({ name: 'Анна', kind: 'person', id: 'u1' }).id, 'u1')
    assert.equal(cleanAuthor({ name: 'Агент', kind: 'agent', id: 'u1' }).id, undefined)
    assert.equal(personId({ sub: 'u1', email: 'A@x.io' }), 'u1')
    assert.equal(personId({ email: 'A@x.io' }), 'a@x.io')
    assert.equal(personId({ name: 'Анна' }), null)
    assert.equal(mayComment({ read: true, right: 'read' }, { hub: true }), false)
    assert.equal(mayComment({ read: true, right: 'comment' }, { hub: true }), true)
    assert.equal(mayComment({ read: true }, { hub: false }), true)
  })
})
