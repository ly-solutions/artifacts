import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inlineImages, main, parseArgs } from '../src/cli.mjs'
import { TOKEN, startApp, tempDir } from './helpers/setup.mjs'

/** Runs the CLI in-process and captures stdout and stderr. */
async function cli(args, env) {
  const out = []
  const err = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // The test runner reports through stdout as binary chunks; the CLI writes strings.
  process.stdout.write = (chunk) => (typeof chunk === 'string' ? out.push(chunk) : origOut(chunk)) && true
  process.stderr.write = (chunk) => err.push(String(chunk)) && true
  try {
    const code = await main(args, { ARTIFACTS_AUTHOR: 'cli-tester', ...env })
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

describe('cli', () => {
  let app
  let tmp
  let env
  before(async () => {
    app = await startApp()
    tmp = await tempDir()
    env = { ARTIFACTS_URL: app.base, ARTIFACTS_TOKEN: TOKEN, ARTIFACTS_SESSION: 'conv-77' }
  })
  after(async () => {
    await app.close()
    await tmp.cleanup()
  })

  it('parses flags', () => {
    assert.deepEqual(parseArgs(['publish', '--file', 'a.html', '--title=T = x', '--new', '--add-tag', 'a', '--add-tag', 'b', 'extra']), { _: ['publish', 'extra'], file: 'a.html', title: 'T = x', new: true, 'add-tag': ['a', 'b'] })
    assert.throws(() => parseArgs(['--file']))
  })

  it('inlines local images and leaves remote ones', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    await writeFile(join(tmp.dir, 'shot.png'), png)
    const html = await inlineImages('<img src="./shot.png"><img src="https://example.com/x.png">![a](shot.png)', tmp.dir)
    assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/)
    assert.match(html, /https:\/\/example\.com\/x\.png/)
    assert.match(html, /!\[a\]\(data:image\/png;base64,/)
  })

  it('publishes, refuses a copy, updates the same slug, lists versions, finds, edits, shares and reads', async () => {
    const file = join(tmp.dir, 'plan.md')
    await writeFile(file, '# Launch plan\n\nStep one.')
    const first = await cli(['publish', '--file', file, '--tags', 'plan,launch'], env)
    assert.equal(first.code, 0, first.err)
    const viewUrl = first.out.trim()
    const slug = viewUrl.split('/a/')[1]
    assert.match(first.err, /published .*version 1, author cli-tester/)

    const dup = await cli(['publish', '--file', file, '--title', 'Launch plan (final)'], env)
    assert.equal(dup.code, 1)
    assert.match(dup.err, new RegExp(slug))

    await writeFile(file, '# Launch plan\n\nStep one. Step two.')
    assert.equal((await cli(['publish', '--file', file, '--note', 'no slug'], env)).code, 2)
    const second = await cli(['publish', '--slug', slug, '--file', file, '--note', 'added step two'], env)
    assert.equal(second.code, 0, second.err)
    assert.match(second.err, /updated .*version 2/)

    const versions = await cli(['versions', slug], env)
    assert.match(versions.out, /^1 · .* · cli-tester · —\n2 · .* · cli-tester · added step two\n$/)

    const found = await cli(['find', 'step', 'two'], env)
    assert.match(found.out, new RegExp(`^${slug} — Launch plan · v2`))
    const bySession = await cli(['find', '--session', 'conv-77', '--json'], env)
    assert.equal(JSON.parse(bySession.out).items[0].slug, slug)

    const meta = await cli(['meta', slug, '--add-tag', 'q4', '--task', 'PROJ-1', '--link', 'https://example.com/pr/9'], env)
    assert.match(meta.out, /tags plan, launch, q4, task PROJ-1/)

    const share = await cli(['share', slug, '--expires', '1d'], env)
    assert.match(share.out, /^http:\/\/artifacts\.test\/s\/[\w-]+\.[\w-]+\n$/)
    assert.equal((await cli(['unshare', slug], env)).code, 0)

    const md = await cli(['get', slug, '--v', '1', '--format', 'markdown'], env)
    assert.equal(md.out, '# Launch plan\n\nStep one.')

    assert.equal((await cli(['delete', slug], env)).code, 2)
    assert.equal((await cli(['delete', slug, '--yes'], env)).code, 0)
    assert.equal((await cli(['versions', slug], env)).code, 1)
  })

  it('reports problems from the server and connection errors', async () => {
    const bad = await cli(['meta', 'some-slug', '--link', 'not a url'], env)
    assert.equal(bad.code, 1)
    assert.match(bad.err, /link: an http\(s\) URL/)
    const down = await cli(['find', 'x'], { ARTIFACTS_URL: 'http://127.0.0.1:1', ARTIFACTS_TOKEN: TOKEN })
    assert.equal(down.code, 2)
    assert.match(down.err, /cannot reach/)
    assert.equal((await cli(['nope'], env)).code, 2)
    assert.equal((await cli(['--version'], env)).out.trim(), '0.1.0')
  })
})
