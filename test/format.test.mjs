import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import vm from 'node:vm'

// The Markdown model of the text editor is plain script for the page; here its pure parts run without a DOM.
const window = {}
vm.runInNewContext(readFileSync(new URL('../web/docs/md.js', import.meta.url), 'utf8'), { window, document: {} })
const DX = window.DX
const plain = (value) => (value ? { ...value } : value)

describe('colour and underline kept as inline HTML', () => {
  it('lets only colour and background-colour through, and only real colours', () => {
    assert.deepEqual(plain(DX.safeStyle('style="color:#e5484d"')), { color: '#e5484d' })
    assert.deepEqual(plain(DX.safeStyle('style="color: rgb(1, 2, 3); background-color:rgba(250,204,21,0.38)"')), { color: 'rgb(1,2,3)', 'background-color': 'rgba(250,204,21,0.38)' })
    assert.equal(DX.safeStyle('style="position:fixed;top:0"'), null)
    assert.equal(DX.safeStyle('style="background:url(http://x/y)"'), null)
    assert.equal(DX.safeStyle('style="color:url(http://x/y)"'), null)
    assert.equal(DX.safeStyle('style="color:var(--x)"'), null)
    assert.equal(DX.safeStyle('style="color:inherit"'), null)
    assert.equal(DX.safeStyle(''), null)
  })

  it('does not make a paragraph that begins with them a raw HTML block', () => {
    const [u, span, div] = ['<u>a</u> b', '<span style="color:red">a</span> b', '<div>a</div>'].map((text) => DX.parseMarkdown(text)[0])
    assert.equal(u.type, 'para')
    assert.equal(span.type, 'para')
    assert.equal(div.type, 'raw')
  })

  it('gives an untouched block back byte for byte', () => {
    const text = 'a <span style="color:#e5484d">b</span> <u>c</u>\n'
    assert.equal(DX.toMarkdown(DX.parseMarkdown(text)), text)
  })
})
