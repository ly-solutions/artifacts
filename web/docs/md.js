/* The Markdown block model of a text document.
 *
 * A document is a list of blocks (heading, paragraph, list, quote, callout, code, table, rule, image, raw). A block keeps
 * the Markdown it was read from (`src`) and gives it back byte for byte until somebody edits it, so opening and saving a
 * document an agent wrote never reformats what the person did not touch. The page is built from blocks with DOM calls
 * (never innerHTML), so nothing in a document can become code of the page.
 */
;(function () {
  'use strict'
  var DX = (window.DX = window.DX || {})
  var nextId = 1

  function block(type, props, src) {
    var b = { id: 'b' + nextId++, type: type, src: src, dirty: false }
    for (var k in props) b[k] = props[k]
    return b
  }

  var RE = {
    fence: /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/,
    heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
    rule: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^\s{0,3}>\s?(.*)$/,
    ul: /^(\s*)([-*+])\s+(.*)$/,
    ol: /^(\s*)(\d+)[.)]\s+(.*)$/,
    image: /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/,
    html: /^\s{0,3}<\/?(?!(?:u|span)\b)[a-zA-Z!][^>]*>/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  }

  function splitRow(line) {
    var s = line.trim()
    if (s[0] === '|') s = s.slice(1)
    if (s[s.length - 1] === '|' && s[s.length - 2] !== '\\') s = s.slice(0, -1)
    var cells = []
    var cur = ''
    for (var i = 0; i < s.length; i += 1) {
      if (s[i] === '\\' && s[i + 1] === '|') {
        cur += '|'
        i += 1
      } else if (s[i] === '|') {
        cells.push(cur.trim())
        cur = ''
      } else cur += s[i]
    }
    cells.push(cur.trim())
    return cells
  }

  var CALLOUT = /^\[!(NOTE|TIP|INFO|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i

  /** markdown → blocks */
  DX.parseMarkdown = function (markdown) {
    var lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
    var out = []
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      if (!line.trim()) {
        i += 1
        continue
      }
      var start = i
      var m
      if ((m = RE.fence.exec(line))) {
        var fence = m[2]
        var body = []
        i += 1
        while (i < lines.length && !new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
          body.push(lines[i])
          i += 1
        }
        i += 1
        out.push(block('code', { lang: m[3] || '', code: body.join('\n') }, lines.slice(start, i).join('\n')))
        continue
      }
      if ((m = RE.heading.exec(line))) {
        i += 1
        out.push(block('heading', { level: m[1].length, text: m[2] }, line))
        continue
      }
      if (RE.rule.test(line) && !RE.ul.test(line)) {
        i += 1
        out.push(block('rule', {}, line))
        continue
      }
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
        var head = splitRow(line)
        var align = splitRow(lines[i + 1]).map(function (c) {
          return /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''
        })
        var rows = []
        i += 2
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          rows.push(splitRow(lines[i]))
          i += 1
        }
        out.push(block('table', { head: head, align: align, rows: rows }, lines.slice(start, i).join('\n')))
        continue
      }
      if (RE.quote.test(line)) {
        var q = []
        while (i < lines.length && RE.quote.test(lines[i])) {
          q.push(RE.quote.exec(lines[i])[1])
          i += 1
        }
        var first = CALLOUT.exec(q[0])
        if (first) {
          var rest = [first[2]].concat(q.slice(1)).join('\n').trim()
          out.push(block('callout', { tone: first[1].toLowerCase(), text: rest }, lines.slice(start, i).join('\n')))
        } else out.push(block('quote', { text: q.join('\n') }, lines.slice(start, i).join('\n')))
        continue
      }
      if ((m = RE.ul.exec(line)) || (m = RE.ol.exec(line))) {
        var ordered = !!RE.ol.exec(line) && !RE.ul.exec(line)
        var items = []
        while (i < lines.length) {
          var l = lines[i]
          var u = RE.ul.exec(l)
          var o = RE.ol.exec(l)
          if ((u && !ordered) || (o && ordered)) {
            var mm = u || o
            items.push({ depth: Math.floor(mm[1].replace(/\t/g, '    ').length / 2), text: mm[3] })
            i += 1
          } else if (l.trim() && /^\s+\S/.test(l) && items.length && !u && !o) {
            items[items.length - 1].text += '\n' + l.trim()
            i += 1
          } else if (!l.trim() && i + 1 < lines.length && ((ordered ? RE.ol : RE.ul).test(lines[i + 1]) || false)) {
            i += 1
          } else break
        }
        out.push(block('list', { ordered: ordered, items: items }, lines.slice(start, i).join('\n')))
        continue
      }
      if ((m = RE.image.exec(line))) {
        i += 1
        out.push(block('image', { alt: m[1], url: m[2] }, line))
        continue
      }
      if (RE.html.test(line)) {
        var raw = []
        while (i < lines.length && lines[i].trim()) {
          raw.push(lines[i])
          i += 1
        }
        out.push(block('raw', { text: raw.join('\n') }, raw.join('\n')))
        continue
      }
      var para = []
      while (i < lines.length && lines[i].trim() && !RE.fence.test(lines[i]) && !RE.heading.test(lines[i]) && !(RE.rule.test(lines[i]) && para.length) && !RE.quote.test(lines[i]) && !(RE.ul.test(lines[i]) && para.length === 0)) {
        if (para.length && (RE.ul.test(lines[i]) || RE.ol.test(lines[i]))) break
        para.push(lines[i])
        i += 1
      }
      if (!para.length) {
        para.push(lines[i])
        i += 1
      }
      out.push(block('para', { text: para.join('\n').trim() }, para.join('\n')))
    }
    return out
  }

  DX.newBlock = function (type, props) {
    var b = block(type, props || {}, '')
    b.dirty = true
    return b
  }

  function inlineSource(text) {
    return String(text)
  }

  /** One block → its Markdown (its own text until it is edited). */
  DX.blockMarkdown = function (b) {
    if (!b.dirty) return b.src
    switch (b.type) {
      case 'heading':
        return '#'.repeat(b.level) + ' ' + inlineSource(b.text)
      case 'para':
      case 'raw':
        return inlineSource(b.text)
      case 'quote':
        return String(b.text).split('\n').map(function (l) { return '> ' + l }).join('\n')
      case 'callout':
        return '> [!' + String(b.tone || 'note').toUpperCase() + '] ' + String(b.text).split('\n').join('\n> ')
      case 'code':
        return '```' + (b.lang || '') + '\n' + b.code + '\n```'
      case 'rule':
        return '---'
      case 'image':
        return '![' + (b.alt || '') + '](' + b.url + ')'
      case 'list':
        var n = 0
        return b.items
          .map(function (it) {
            var pad = ' '.repeat(it.depth * 2)
            if (b.ordered) {
              n += 1
              return pad + n + '. ' + it.text
            }
            return pad + '- ' + it.text
          })
          .join('\n')
      case 'table':
        var esc = function (c) { return String(c).replace(/\|/g, '\\|') }
        var sep = b.head.map(function (_, ix) {
          var a = b.align && b.align[ix]
          return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
        })
        return ['| ' + b.head.map(esc).join(' | ') + ' |', '| ' + sep.join(' | ') + ' |']
          .concat(
            b.rows.map(function (r) {
              return '| ' + r.map(esc).join(' | ') + ' |'
            }),
          )
          .join('\n')
      default:
        return b.src
    }
  }

  /** blocks → Markdown, with one blank line between blocks. */
  DX.toMarkdown = function (blocks) {
    return blocks.map(DX.blockMarkdown).join('\n\n') + '\n'
  }

  // ---- Inline: **bold**, *italic*, `code`, ~~strike~~, [text](link), \escapes ----

  var SAFE_URL = /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i

  /** Inline Markdown → DOM nodes appended to `parent`. */
  DX.renderInline = function (text, parent) {
    var s = String(text)
    var buf = ''
    function flush() {
      if (buf) parent.appendChild(document.createTextNode(buf))
      buf = ''
    }
    var i = 0
    while (i < s.length) {
      var c = s[i]
      if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(s[i + 1])) {
        buf += s[i + 1]
        i += 2
        continue
      }
      if (c === '\n') {
        flush()
        parent.appendChild(document.createElement('br'))
        i += 1
        continue
      }
      if (c === '`') {
        var end = s.indexOf('`', i + 1)
        if (end > i + 1) {
          flush()
          var code = document.createElement('code')
          code.textContent = s.slice(i + 1, end)
          parent.appendChild(code)
          i = end + 1
          continue
        }
      }
      if (c === '<') {
        var open = /^<(u|span)((?:\s+style="[^"<>]*")?)>/i.exec(s.slice(i, i + 300))
        var tagName = open && open[1].toLowerCase()
        var css = tagName === 'span' ? DX.safeStyle(open[2]) : null
        var closeAt = open && (tagName === 'u' ? !open[2] : !!css) ? closeOf(s, i + open[0].length, tagName) : -1
        if (closeAt > -1) {
          flush()
          var mark = document.createElement(tagName)
          if (css) DX.paint(mark, css)
          DX.renderInline(s.slice(i + open[0].length, closeAt), mark)
          parent.appendChild(mark)
          i = closeAt + tagName.length + 3
          continue
        }
      }
      var two = s.slice(i, i + 2)
      if ((two === '**' || two === '__' || two === '~~') && s.indexOf(two, i + 2) > i + 2) {
        var close = s.indexOf(two, i + 2)
        flush()
        var tag = two === '~~' ? 's' : 'strong'
        var el = document.createElement(tag)
        DX.renderInline(s.slice(i + 2, close), el)
        parent.appendChild(el)
        i = close + 2
        continue
      }
      if ((c === '*' || c === '_') && s[i + 1] !== ' ') {
        var j = i + 1
        while (j < s.length && (s[j] !== c || s[j - 1] === '\\')) j += 1
        if (j < s.length && j > i + 1 && (c === '*' || !/\w/.test(s[j + 1] || ' ')) && (c === '*' || !/\w/.test(s[i - 1] || ' '))) {
          flush()
          var em = document.createElement('em')
          DX.renderInline(s.slice(i + 1, j), em)
          parent.appendChild(em)
          i = j + 1
          continue
        }
      }
      if (c === '[') {
        var rb = s.indexOf('](', i)
        var rp = rb === -1 ? -1 : s.indexOf(')', rb)
        if (rb > i && rp > rb && s.slice(i + 1, rb).indexOf('\n\n') === -1) {
          var href = s.slice(rb + 2, rp).trim().replace(/\s+"[^"]*"$/, '')
          flush()
          var a = document.createElement('a')
          DX.renderInline(s.slice(i + 1, rb), a)
          if (SAFE_URL.test(href)) {
            a.href = href
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
          }
          parent.appendChild(a)
          i = rp + 1
          continue
        }
      }
      if (c === 'h' && /^https?:\/\/[^\s<)]+/.test(s.slice(i))) {
        var url = /^https?:\/\/[^\s<)]+[^\s<).,;:!?]/.exec(s.slice(i))
        if (url) {
          flush()
          var link = document.createElement('a')
          link.textContent = url[0]
          link.href = url[0]
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          parent.appendChild(link)
          i += url[0].length
          continue
        }
      }
      buf += c
      i += 1
    }
    flush()
  }

  /** Where the `</tag>` that closes the one opened just before `from` is (nested ones of the same tag counted), or -1. */
  function closeOf(s, from, tag) {
    var re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi')
    var depth = 1
    var hit
    re.lastIndex = from
    while ((hit = re.exec(s))) {
      depth += hit[1] ? -1 : 1
      if (!depth) return hit.index
    }
    return -1
  }

  // ---- Colour and underline: inline HTML kept in the Markdown, with a white list of what a style may say ----

  var COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(\s*[\d.%\s,/]+\)|[a-z]{3,24})$/i
  var COLOR_KEYWORD_NO = /^(inherit|initial|unset|revert|currentcolor)$/i

  /** A colour the page may paint with, or null. */
  /**
   * Sets the colours of a span as they were written and, beside them, as custom properties the stylesheet reads: on a
   * dark page a dark text colour or a bright marker is brought to a level that reads there (the file keeps what was written).
   */
  DX.paint = function (el, css) {
    if (css.color) {
      el.style.setProperty('color', css.color)
      el.style.setProperty('--dx-tc', css.color)
    }
    if (css['background-color']) {
      el.style.setProperty('background-color', css['background-color'])
      el.style.setProperty('--dx-bc', css['background-color'])
    }
  }
  DX.unpaint = function (el, prop) {
    el.style.removeProperty(prop)
    el.style.removeProperty(prop === 'color' ? '--dx-tc' : '--dx-bc')
  }

  DX.safeColor = function (value) {
    var v = String(value || '').trim()
    if (!COLOR.test(v) || COLOR_KEYWORD_NO.test(v)) return null
    if (window.CSS && CSS.supports && !CSS.supports('color', v)) return null
    return v.replace(/\s+/g, '')
  }

  /** `style="color:…; background-color:…"` → {color, background-color}; nothing else gets through. null when empty. */
  DX.safeStyle = function (attr) {
    var m = /style="([^"]*)"/i.exec(String(attr || ''))
    if (!m) return null
    var out = {}
    var any = false
    m[1].split(';').forEach(function (decl) {
      var at = decl.indexOf(':')
      if (at < 1) return
      var prop = decl.slice(0, at).trim().toLowerCase()
      if (prop !== 'color' && prop !== 'background-color') return
      var value = DX.safeColor(decl.slice(at + 1))
      if (value) {
        out[prop] = value
        any = true
      }
    })
    return any ? out : null
  }

  function hex(c) {
    var m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(c)
    if (!m) return c
    return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + Math.min(255, +n).toString(16)).slice(-2) }).join('')
  }

  var ESCAPE = /([\\`*_[\]~])/g

  /** The Markdown of what a contenteditable holds (the reverse of renderInline). */
  DX.inlineFromDom = function (root) {
    function walk(node, plain) {
      var out = ''
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) {
          out += plain ? n.nodeValue : n.nodeValue.replace(/ /g, ' ').replace(ESCAPE, '\\$1').replace(/<(?=[a-zA-Z/!])/g, '\\<')
          return
        }
        if (n.nodeType !== 1) return
        var tag = n.tagName
        if (tag === 'BR') out += n.getAttribute('data-end') ? '' : '\n'
        else if (tag === 'STRONG' || tag === 'B') out += '**' + walk(n) + '**'
        else if (tag === 'EM' || tag === 'I') out += '*' + walk(n) + '*'
        else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') out += '~~' + walk(n) + '~~'
        else if (tag === 'U') out += '<u>' + walk(n) + '</u>'
        else if (tag === 'SPAN' || tag === 'FONT') {
          var inner2 = walk(n, plain)
          var color = DX.safeColor(tag === 'FONT' ? n.getAttribute('color') : n.style.color)
          var back = DX.safeColor(n.style.backgroundColor)
          var under = n.style.textDecorationLine === 'underline' || /underline/.test(n.style.textDecoration || '')
          if (!plain && inner2) {
            if (under) inner2 = '<u>' + inner2 + '</u>'
            var decl = (color ? 'color:' + hex(color) + ';' : '') + (back ? 'background-color:' + hex(back) + ';' : '')
            if (decl) inner2 = '<span style="' + decl.slice(0, -1) + '">' + inner2 + '</span>'
          }
          out += inner2
        }
        else if (tag === 'CODE') out += '`' + walk(n, true) + '`'
        else if (tag === 'A') {
          var inner = walk(n)
          var href = n.getAttribute('href')
          out += href ? '[' + inner + '](' + href + ')' : inner
        } else if (tag === 'DIV' || tag === 'P') out += (out && !out.endsWith('\n') ? '\n' : '') + walk(n)
        else out += walk(n, plain)
      })
      return out
    }
    return walk(root).replace(/\n+$/, '')
  }

  /** The plain text of inline Markdown (headings in the contents, quotes for comments). */
  DX.plainInline = function (text) {
    var holder = document.createElement('div')
    DX.renderInline(text, holder)
    return holder.textContent
  }
})()
