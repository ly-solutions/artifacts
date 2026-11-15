/* A text document: Markdown shown (and edited) as blocks.
 *
 * View: a column of text, the contents as strips on the left, a popover over the selection (it never covers the words it
 * is about). Edit: every block is editable in place; a handle on the left (drag, the block's menu), «/» on an empty line
 * opens the insert menu, a bar of formatting appears over a selection; every change is saved by the app a moment later.
 * Comment threads are marks on the words they were made on and a pin beside the block.
 */
;(function () {
  'use strict'
  var DX = window.DX
  var h = DX.h

  var SLASH = [
    { id: 'para', icon: 'pilcrow', label: 'Текст', key: 'текст text' },
    { id: 'h1', icon: 'heading-1', label: 'Заголовок 1', key: 'заголовок heading h1' },
    { id: 'h2', icon: 'heading-2', label: 'Заголовок 2', key: 'заголовок heading h2' },
    { id: 'h3', icon: 'type', label: 'Заголовок 3', key: 'заголовок heading h3' },
    { id: 'ul', icon: 'list', label: 'Маркированный список', key: 'список list bullet' },
    { id: 'ol', icon: 'list-ordered', label: 'Нумерованный список', key: 'список нумерованный number' },
    { id: 'quote', icon: 'text-quote', label: 'Цитата', key: 'цитата quote' },
    { id: 'callout', icon: 'info', label: 'Выноска', key: 'выноска callout' },
    { id: 'code', icon: 'code-xml', label: 'Код', key: 'код code' },
    { id: 'table', icon: 'table', label: 'Таблица', key: 'таблица table' },
    { id: 'image', icon: 'image', label: 'Картинка', key: 'картинка image фото' },
    { id: 'rule', icon: 'minus', label: 'Разделитель', key: 'разделитель rule hr' },
    { id: 'html', icon: 'file-pen', label: 'HTML-блок', key: 'html блок' },
  ]
  DX.SLASH_ITEMS = SLASH

  var PLACEHOLDER = { para: 'Напишите что-нибудь или нажмите «/»', heading: 'Заголовок', quote: 'Цитата', callout: 'Мысль, которую нельзя пропустить' }

  function textOf(node) {
    return (node.textContent || '').replace(/\s+/g, ' ').trim()
  }

  DX.TextDoc = function (ctx, host) {
    var blocks = []
    var page, scroller, tocEl
    var mode = 'view'
    var editing = false
    var onDirty = function () {}
    var selPop = null
    var selTimer = 0
    var slash = null
    var rev = 0
    var savedRev = 0
    var ctrl = {}

    // ---- Building the page ----

    function build() {
      scroller = h('div.dscroll')
      page = h('article.page')
      scroller.appendChild(page)
      host.appendChild(scroller)
      tocEl = h('nav.toc', { 'aria-label': 'Оглавление' })
      host.appendChild(tocEl)
      scroller.addEventListener('mouseup', function () {
        setTimeout(checkSelection, 0)
      })
      scroller.addEventListener('keyup', function (e) {
        if (e.shiftKey || /Arrow|Home|End/.test(e.key)) checkSelection()
      })
      document.addEventListener('selectionchange', onSelectionChange)
      scroller.addEventListener('scroll', DX.debounce(updateToc, 60))
      page.addEventListener('input', onInput)
      page.addEventListener('keydown', onKeyDown)
      page.addEventListener('click', onClick)
      page.addEventListener('paste', onPaste)
      page.addEventListener('dragstart', function (e) {
        if (editing) e.preventDefault()
      })
    }

    function showsTitle() {
      return !(blocks[0] && blocks[0].type === 'heading' && blocks[0].level === 1)
    }

    function render() {
      page.textContent = ''
      page.appendChild(headerEl())
      blocks.forEach(function (b, i) {
        page.appendChild(blockEl(b, i))
      })
      var tail = h('div.tail', { onClick: addAtEnd })
      page.appendChild(tail)
      applyMode()
      renderThreads()
      renderToc()
    }

    function headerEl() {
      var d = ctx.data
      var by = h('div.by', DX.avatar(d.author || 'Автор', 'person', 20), h('span', (d.author || '') + (d.author ? ' · ' : '') + 'изменён ' + DX.when(d.updatedAt)), h('span', 'версия ' + d.version.n))
      var wrap = h('div.doc-head')
      if (showsTitle()) wrap.appendChild(h('div.doc-title', d.title))
      wrap.appendChild(by)
      return wrap
    }

    function bc(tag, b) {
      var el = h(tag + '.bc', { 'data-ph': PLACEHOLDER[b.type] || '' })
      return el
    }

    function blockEl(b, index) {
      var el = h('div.blk', { 'data-id': b.id, 'data-t': b.type })
      var body
      switch (b.type) {
        case 'heading':
          body = bc('h' + Math.min(b.level, 6), b)
          DX.renderInline(b.text, body)
          if (b.level <= 3) body.id = 'h-' + b.id
          break
        case 'para':
          body = bc('p', b)
          DX.renderInline(b.text, body)
          break
        case 'quote':
          body = bc('blockquote', b)
          DX.renderInline(b.text, body)
          break
        case 'callout':
          body = h('div.callout', DX.icon('info'), (function () {
            var c = bc('div', b)
            DX.renderInline(b.text, c)
            return c
          })())
          break
        case 'list':
          body = h((b.ordered ? 'ol' : 'ul') + '.bc')
          b.items.forEach(function (it) {
            var li = h('li', { 'data-d': it.depth || 0 })
            DX.renderInline(it.text, li)
            body.appendChild(li)
          })
          break
        case 'code':
          body = h('pre.bc', { 'data-lang': b.lang }, h('code', b.code))
          break
        case 'table':
          body = h('table.bct', h('thead', h('tr', b.head.map(function (c, ix) { return cell('th', c, b.align && b.align[ix]) }))), h('tbody', b.rows.map(function (r) {
            return h('tr', b.head.map(function (_, ix) { return cell('td', r[ix] || '', b.align && b.align[ix]) }))
          })))
          break
        case 'rule':
          body = h('hr')
          break
        case 'image':
          body = h('figure.fig', imageEl(b), b.alt ? h('figcaption', b.alt) : null)
          break
        default:
          body = h('div.rawblk', h('div.rb-bar', DX.icon('code-xml'), h('span', 'HTML или особая разметка · как написано')), h('div.bc', { 'data-ph': 'HTML' }, b.text))
      }
      el.appendChild(body)
      if (index !== undefined) el.appendChild(gutter())
      return el
    }

    function imageEl(b) {
      var ok = /^(https?:\/\/|data:image\/|\/)/i.test(b.url)
      if (!ok) return h('div.hint', 'Картинка: ' + b.url)
      var img = h('img', { src: b.url, alt: b.alt || '', loading: 'lazy' })
      return img
    }

    function cell(tag, text, align) {
      var el = h(tag)
      if (align) el.style.textAlign = align
      DX.renderInline(text, el)
      return el
    }

    function gutter() {
      return h('div.gr', { contenteditable: 'false' }, h('button', { type: 'button', 'data-act': 'add', 'data-tip': 'Добавить блок ниже' }, DX.icon('plus')), h('button', { type: 'button', 'data-act': 'grip', 'data-tip': 'Перетащить · меню блока' }, DX.icon('grip-vertical')))
    }

    function bcOf(blk) {
      return blk.querySelector('.bc, .bct')
    }
    function blockById(id) {
      for (var i = 0; i < blocks.length; i += 1) if (blocks[i].id === id) return i
      return -1
    }
    function blkOf(node) {
      var el = node && (node.nodeType === 1 ? node : node.parentElement)
      return el && el.closest ? el.closest('.blk') : null
    }

    function applyMode() {
      editing = mode === 'edit' && ctx.canWrite()
      page.classList.toggle('editing', editing)
      page.querySelectorAll('.gr').forEach(function (g) {
        g.hidden = !editing
      })
      page.querySelectorAll('.bc').forEach(function (el) {
        if (editing && el.closest('.blk').dataset.t !== 'rule') el.setAttribute('contenteditable', el.tagName === 'PRE' ? 'plaintext-only' : 'true')
        else el.removeAttribute('contenteditable')
        el.spellcheck = editing
      })
      page.querySelectorAll('.bct th, .bct td').forEach(function (c) {
        if (editing) c.setAttribute('contenteditable', 'true')
        else c.removeAttribute('contenteditable')
      })
    }

    // ---- Reading the DOM back into the model ----

    function sync(blk) {
      var i = blockById(blk.dataset.id)
      if (i < 0) return
      var b = blocks[i]
      var body = bcOf(blk)
      switch (b.type) {
        case 'heading':
        case 'para':
        case 'quote':
        case 'callout':
          b.text = DX.inlineFromDom(blk.querySelector('.bc'))
          break
        case 'raw':
          b.text = blk.querySelector('.bc').textContent
          break
        case 'code':
          b.code = body.textContent.replace(/\n$/, '')
          break
        case 'list':
          b.items = Array.prototype.map.call(body.children, function (li) {
            return { depth: Number(li.dataset.d || 0), text: DX.inlineFromDom(li) }
          })
          break
        case 'table':
          b.head = Array.prototype.map.call(blk.querySelectorAll('thead th'), function (c) { return DX.inlineFromDom(c) })
          b.rows = Array.prototype.map.call(blk.querySelectorAll('tbody tr'), function (tr) {
            return Array.prototype.map.call(tr.children, function (c) { return DX.inlineFromDom(c) })
          })
          break
        default:
      }
      b.dirty = true
    }

    function changed() {
      rev += 1
      onDirty()
    }

    // ---- Events: typing, keys, clicks ----

    function onInput(e) {
      var blk = blkOf(e.target)
      if (!blk) return
      sync(blk)
      changed()
      var b = blocks[blockById(blk.dataset.id)]
      // «/» in an empty line: the insert menu. A line that is only «/word» keeps it filtered.
      if (b && b.type === 'para') {
        var t = blk.querySelector('.bc').textContent
        if (/^\/[^\s]*$/.test(t)) openSlash(blk, t.slice(1))
        else closeSlash()
      } else closeSlash()
    }

    function onKeyDown(e) {
      if (!editing) return
      var blk = blkOf(e.target)
      if (slash && slashKey(e)) return
      if (!blk) return
      var i = blockById(blk.dataset.id)
      var b = blocks[i]
      if (!b) return
      var isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        document.execCommand('bold')
      } else if (isMod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        document.execCommand('italic')
      } else if (e.key === 'Enter' && !e.shiftKey && (b.type === 'heading' || b.type === 'para' || b.type === 'quote' || b.type === 'callout')) {
        e.preventDefault()
        splitBlock(blk, b, i)
      } else if (e.key === 'Enter' && b.type === 'list') {
        var li = e.target.closest ? e.target.closest('li') : null
        if (li && !li.textContent.trim() && li === li.parentNode.lastElementChild) {
          e.preventDefault()
          li.remove()
          sync(blk)
          insertBlockAfter(blk, DX.newBlock('para', { text: '' }), true)
        }
      } else if (e.key === 'Tab' && b.type === 'list') {
        e.preventDefault()
        var cur = e.target.closest('li') || getSelection().anchorNode.parentElement.closest('li')
        if (cur) {
          var d = Number(cur.dataset.d || 0) + (e.shiftKey ? -1 : 1)
          cur.dataset.d = String(Math.max(0, Math.min(2, d)))
          sync(blk)
          changed()
        }
      } else if (e.key === 'Backspace' && (b.type === 'para' || b.type === 'heading') && !bcOf(blk).textContent && blocks.length > 1) {
        e.preventDefault()
        var prev = blk.previousElementSibling
        removeBlock(blk)
        var focusEl = prev && prev.classList.contains('blk') ? prev : null
        if (focusEl) focusEnd(bcOf(focusEl))
      } else if (e.key === 'Backspace' && b.type !== 'para' && b.type !== 'heading' && b.type !== 'list' && b.type !== 'code' && b.type !== 'table' && b.type !== 'raw' && !bcOf(blk).textContent) {
        e.preventDefault()
        transform(blk, 'para')
      } else if (e.key === 'ArrowUp' && atEdge(e.target, true)) {
        var p = blk.previousElementSibling
        if (p && p.classList.contains('blk') && bcOf(p)) {
          e.preventDefault()
          focusEnd(bcOf(p))
        }
      } else if (e.key === 'ArrowDown' && atEdge(e.target, false)) {
        var n = blk.nextElementSibling
        if (n && n.classList.contains('blk') && bcOf(n)) {
          e.preventDefault()
          focusEnd(bcOf(n), true)
        }
      }
    }

    function atEdge(target, top) {
      var sel = getSelection()
      if (!sel.rangeCount || !sel.isCollapsed) return false
      var el = target.closest ? target.closest('.bc, td, th') : null
      if (!el) return false
      var r = sel.getRangeAt(0).cloneRange()
      var rect = r.getClientRects()[0] || el.getBoundingClientRect()
      var box = el.getBoundingClientRect()
      return top ? rect.top - box.top < 14 : box.bottom - rect.bottom < 14
    }

    function focusEnd(el, start) {
      if (!el) return
      el.focus()
      var range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(!!start)
      var sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }

    function splitBlock(blk, b, i) {
      var el = blk.querySelector('.bc')
      var sel = getSelection()
      var rest = ''
      if (sel.rangeCount) {
        var range = sel.getRangeAt(0)
        var tail = document.createRange()
        tail.selectNodeContents(el)
        tail.setStart(range.endContainer, range.endOffset)
        var frag = tail.extractContents()
        var holder = h('div')
        holder.appendChild(frag)
        rest = DX.inlineFromDom(holder)
        if (b.type === 'heading') el.normalize()
      }
      sync(blk)
      var nb = DX.newBlock('para', { text: rest })
      insertBlockAfter(blk, nb, true, i)
      changed()
    }

    function insertBlockAfter(blk, nb, focus, index) {
      var i = index !== undefined ? index : blockById(blk.dataset.id)
      blocks.splice(i + 1, 0, nb)
      var el = blockEl(nb, i + 1)
      blk.after(el)
      applyMode()
      renderToc()
      if (focus && bcOf(el)) focusEnd(bcOf(el), true)
      changed()
      return el
    }

    function addAtEnd() {
      if (!editing) return
      var last = page.querySelector('.blk:last-of-type')
      var lb = blocks[blocks.length - 1]
      if (lb && lb.type === 'para' && !lb.text.trim()) return focusEnd(bcOf(last))
      var nb = DX.newBlock('para', { text: '' })
      blocks.push(nb)
      var el = blockEl(nb, blocks.length - 1)
      page.insertBefore(el, page.querySelector('.tail'))
      applyMode()
      focusEnd(bcOf(el))
      changed()
    }

    function removeBlock(blk) {
      var i = blockById(blk.dataset.id)
      if (i < 0) return
      blocks.splice(i, 1)
      blk.remove()
      if (!blocks.length) {
        var nb = DX.newBlock('para', { text: '' })
        blocks.push(nb)
        page.insertBefore(blockEl(nb, 0), page.querySelector('.tail'))
        applyMode()
      }
      renderToc()
      renderThreads()
      changed()
    }

    function onPaste(e) {
      if (!editing) return
      var text = (e.clipboardData || window.clipboardData).getData('text/plain')
      if (!text) return
      e.preventDefault()
      if (text.indexOf('\n\n') !== -1 && blkOf(e.target) && !bcOf(blkOf(e.target)).textContent.trim()) {
        // Several paragraphs into an empty block: they become blocks.
        var parsed = DX.parseMarkdown(text)
        if (parsed.length > 1) {
          var blk = blkOf(e.target)
          var i = blockById(blk.dataset.id)
          parsed.forEach(function (pb) { pb.dirty = true })
          blocks.splice.apply(blocks, [i, 1].concat(parsed))
          render()
          changed()
          return
        }
      }
      document.execCommand('insertText', false, text)
    }

    function onClick(e) {
      var t = e.target
      var gr = t.closest && t.closest('.gr button')
      if (gr) {
        var blk = blkOf(gr)
        if (gr.dataset.act === 'add') {
          var nb = DX.newBlock('para', { text: '' })
          var el = insertBlockAfter(blk, nb, true)
          openSlash(el, '')
        } else blockMenu(blk, gr)
        return
      }
      var mark = t.closest && t.closest('.cm')
      if (mark) {
        ctx.openThread(mark.dataset.thread)
        return
      }
      var pin = t.closest && t.closest('.cpin')
      if (pin) ctx.openThread(pin.dataset.thread)
    }

    // ---- The insert menu (/) ----

    function openSlash(blk, query) {
      var q = query.toLowerCase()
      var items = SLASH.filter(function (it) {
        return !q || it.label.toLowerCase().indexOf(q) !== -1 || it.key.indexOf(q) !== -1
      })
      if (!items.length) return closeSlash()
      var anchor = bcOf(blk)
      if (slash && slash.blk === blk) {
        slash.items = items
        slash.at = Math.min(slash.at, items.length - 1)
        slash.draw()
        return
      }
      closeSlash()
      slash = { blk: blk, items: items, at: 0 }
      slash.pop = DX.popover(
        anchor,
        function () {
          var box = h('div.sugg')
          slash.draw = function () {
            box.textContent = ''
            slash.items.forEach(function (it, ix) {
              var row = DX.mi(it.icon, it.label, function () {
                pick(it.id)
              })
              if (ix === slash.at) row.dataset.hl = 'true'
              row.addEventListener('mousedown', function (ev) { ev.preventDefault() })
              box.appendChild(row)
            })
          }
          slash.draw()
          return box
        },
        { cls: 'slash', onClose: function () { slash = null }, keep: function () { return true } },
      )
    }

    function closeSlash() {
      if (slash) slash.pop.close()
      slash = null
    }

    function slashKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        slash.at = (slash.at + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length
        slash.draw()
        return true
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pick(slash.items[slash.at].id)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlash()
        return true
      }
      return false
    }

    function pick(id) {
      var blk = slash && slash.blk
      closeSlash()
      if (blk) transform(blk, id, true)
    }

    // ---- Turning a block into another kind ----

    function textOfBlock(b) {
      switch (b.type) {
        case 'list':
          return b.items.map(function (it) { return it.text }).join('\n')
        case 'code':
          return b.code
        case 'table':
          return b.head.join(' | ')
        case 'image':
          return b.alt || ''
        case 'rule':
          return ''
        default:
          return b.text || ''
      }
    }

    function transform(blk, kind, fromSlash) {
      var i = blockById(blk.dataset.id)
      if (i < 0) return
      var old = blocks[i]
      var text = fromSlash ? '' : textOfBlock(old)
      var nb
      if (kind === 'para') nb = DX.newBlock('para', { text: text })
      else if (/^h[1-3]$/.test(kind)) nb = DX.newBlock('heading', { level: Number(kind[1]), text: text })
      else if (kind === 'ul' || kind === 'ol') nb = DX.newBlock('list', { ordered: kind === 'ol', items: (text || '').split('\n').map(function (t) { return { depth: 0, text: t } }) })
      else if (kind === 'quote') nb = DX.newBlock('quote', { text: text })
      else if (kind === 'callout') nb = DX.newBlock('callout', { tone: 'note', text: text })
      else if (kind === 'code') nb = DX.newBlock('code', { lang: '', code: text })
      else if (kind === 'table') nb = DX.newBlock('table', { head: ['Столбец 1', 'Столбец 2', 'Столбец 3'], align: [], rows: [['', '', ''], ['', '', '']] })
      else if (kind === 'rule') nb = DX.newBlock('rule', {})
      else if (kind === 'html') nb = DX.newBlock('raw', { text: '<div>HTML</div>' })
      else if (kind === 'image') {
        askImage(blk, i)
        return
      }
      if (!nb) return
      blocks[i] = nb
      var el = blockEl(nb, i)
      blk.replaceWith(el)
      applyMode()
      renderThreads()
      renderToc()
      var target = bcOf(el)
      if (target) focusEnd(target, !fromSlash)
      if (kind === 'rule') addAfterRule(el)
      changed()
    }

    function addAfterRule(el) {
      if (!el.nextElementSibling || !el.nextElementSibling.classList.contains('blk')) insertBlockAfter(el, DX.newBlock('para', { text: '' }), true)
    }

    function askImage(blk, i) {
      var input = h('input', { type: 'url', placeholder: 'Адрес картинки: https://…', 'aria-label': 'Адрес картинки' })
      DX.popover(bcOf(blk) || blk, function (close) {
        input.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return
          var url = input.value.trim()
          if (!/^(https?:\/\/|\/)/.test(url)) return
          close()
          var nb = DX.newBlock('image', { alt: '', url: url })
          blocks[i] = nb
          var el = blockEl(nb, i)
          blk.replaceWith(el)
          applyMode()
          changed()
        })
        setTimeout(function () { input.focus() }, 30)
        return h('div.cmp', input)
      })
    }

    // ---- The block's menu, and moving blocks ----

    function blockMenu(blk, anchor) {
      var i = blockById(blk.dataset.id)
      var b = blocks[i]
      if (!b) return
      DX.popover(anchor, function (close) {
        var box = h('div', h('div.mlab', 'Превратить в'))
        ;['para', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'callout', 'code'].forEach(function (id) {
          var it = SLASH.filter(function (s) { return s.id === id })[0]
          box.appendChild(
            DX.mi(it.icon, it.label, function () {
              close()
              transform(blk, id)
            }),
          )
        })
        box.appendChild(h('div.msep'))
        box.appendChild(
          DX.mi('copy', 'Дублировать', function () {
            close()
            sync(blk)
            var copy = JSON.parse(JSON.stringify(b))
            var nb = DX.newBlock(copy.type, copy)
            nb.src = ''
            delete nb.id
            nb.id = 'b' + Math.random().toString(36).slice(2, 8)
            insertBlockAfter(blk, nb, false)
          }),
        )
        box.appendChild(
          DX.mi('message-square', 'Комментарий', function () {
            close()
            var rect = blk.getBoundingClientRect()
            ctx.openComposer({ kind: 'text', quote: textOf(blk).slice(0, 300), block: i }, { x: rect.left, y: rect.top, w: rect.width, h: Math.min(rect.height, 40) })
          }),
        )
        box.appendChild(
          DX.mi('sparkles', 'Спросить агента', function () {
            close()
            ctx.ask(textOf(blk).slice(0, 600))
          }),
        )
        box.appendChild(h('div.msep'))
        box.appendChild(
          DX.mi(
            'trash-2',
            'Удалить блок',
            function () {
              close()
              removeBlock(blk)
            },
            { danger: true },
          ),
        )
        return box
      }, { align: 'start' })
    }

    // The block handle drags: a line shows where it lands.
    function startDrag(e) {
      var grip = e.target.closest && e.target.closest('.gr button[data-act="grip"]')
      if (!grip || !editing || e.button !== 0) return
      var blk = blkOf(grip)
      var startY = e.clientY
      var moved = false
      var line = null
      var target = null
      function move(ev) {
        if (!moved && Math.abs(ev.clientY - startY) < 5) return
        if (!moved) {
          moved = true
          blk.classList.add('dragging')
          document.body.style.cursor = 'grabbing'
          line = h('div.dropline')
          page.appendChild(line)
        }
        var els = Array.prototype.slice.call(page.querySelectorAll('.blk')).filter(function (b) { return b !== blk })
        var best = null
        var pos = 0
        els.forEach(function (b) {
          var r = b.getBoundingClientRect()
          var mid = r.top + r.height / 2
          if (ev.clientY < mid && !best) {
            best = b
            pos = r.top
          }
        })
        target = best
        if (!best && els.length) pos = els[els.length - 1].getBoundingClientRect().bottom
        line.style.top = pos - page.getBoundingClientRect().top + 'px'
      }
      function up() {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        if (!moved) return
        blk.classList.remove('dragging')
        line.remove()
        var i = blockById(blk.dataset.id)
        var b = blocks.splice(i, 1)[0]
        var to = target ? blockById(target.dataset.id) : blocks.length
        blocks.splice(to, 0, b)
        b.dirty = true
        if (target) target.before(blk)
        else page.insertBefore(blk, page.querySelector('.tail'))
        // The blocks around keep their own text, but their place in the file changed: write all out.
        blocks.forEach(function (x) { x.dirty = true })
        renderToc()
        renderThreads()
        changed()
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
      e.preventDefault()
    }

    // ---- Selection: the popover over it ----

    var lastSel = null
    function selectionInfo() {
      var sel = getSelection()
      if (!sel || !sel.rangeCount || sel.isCollapsed) return null
      var range = sel.getRangeAt(0)
      var node = range.commonAncestorContainer
      var el = node.nodeType === 1 ? node : node.parentElement
      if (!el || !page.contains(el) || el.closest('.gr, .toc')) return null
      var text = String(sel).replace(/\s+/g, ' ').trim()
      if (!text) return null
      var first = blkOf(range.startContainer)
      var rect = range.getBoundingClientRect()
      return {
        text: text.slice(0, 600),
        block: first ? blockById(first.dataset.id) : null,
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        within: el.closest('.bc, td, th, li') || null,
      }
    }

    function onSelectionChange() {
      clearTimeout(selTimer)
      selTimer = setTimeout(checkSelection, 140)
    }

    function checkSelection() {
      if (!page.isConnected) return
      var info = selectionInfo()
      if (!info) {
        lastSel = lastSel && selPop ? null : lastSel
        if (selPop) {
          selPop.close()
          selPop = null
        }
        return
      }
      lastSel = info
      ctx.selectionChanged(info)
      showSelPop(info)
    }

    function showSelPop(info) {
      var key = info.text + '|' + Math.round(info.rect.x) + '|' + Math.round(info.rect.y)
      if (selPop && selPop.key === key) return
      if (selPop) selPop.close()
      var tip = function (icon, label, fn, extra) {
        var b = h('button.cell', { type: 'button', 'data-tip': label, onClick: fn, onMousedown: function (ev) { ev.preventDefault() } }, DX.icon(icon), extra ? h('span', extra) : null)
        return b
      }
      selPop = DX.popover(
        info.rect,
        function () {
          var bar = h('div.fmtbar')
          bar.style.display = 'contents'
          if (editing && info.within) {
            bar.appendChild(tip('bold', 'Жирный · ⌘B', function () { document.execCommand('bold'); changedFromCommand() }))
            bar.appendChild(tip('italic', 'Курсив · ⌘I', function () { document.execCommand('italic'); changedFromCommand() }))
            bar.appendChild(tip('code-xml', 'Код', wrapCode))
            bar.appendChild(tip('link', 'Ссылка', function () { askLink(info) }))
            bar.appendChild(h('span.vs'))
            bar.appendChild(typeMenuButton(info))
            bar.appendChild(h('span.vs'))
          }
          bar.appendChild(
            h('button.cell.btn.sm.ghost', { type: 'button', onMousedown: function (ev) { ev.preventDefault() }, onClick: function () { comment(info) } }, DX.icon('message-square'), h('span', 'Комментарий')),
          )
          bar.appendChild(
            h('button.cell.btn.sm.accent', { type: 'button', onMousedown: function (ev) { ev.preventDefault() }, onClick: function () { ctx.ask(info.text) } }, DX.icon('sparkles'), h('span', 'Спросить')),
          )
          if (!editing)
            bar.appendChild(
              h('button.cell', { type: 'button', 'data-tip': 'Копировать ссылку', onMousedown: function (ev) { ev.preventDefault() }, onClick: function () { ctx.copyLink(info.text) } }, DX.icon('link')),
            )
          return bar
        },
        { side: 'above', align: 'center', cls: 'sel', keep: function () { return true } },
      )
      selPop.key = key
    }

    function changedFromCommand() {
      var blk = blkOf(getSelection().anchorNode)
      if (blk) sync(blk)
      changed()
    }

    function wrapCode() {
      var sel = getSelection()
      if (!sel.rangeCount) return
      var range = sel.getRangeAt(0)
      var code = document.createElement('code')
      code.appendChild(range.extractContents())
      range.insertNode(code)
      changedFromCommand()
    }

    function askLink(info) {
      var range = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null
      var input = h('input', { type: 'url', placeholder: 'https://…', 'aria-label': 'Адрес ссылки' })
      DX.popover(info.rect, function (close) {
        input.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return
          var url = input.value.trim()
          if (!/^(https?:\/\/|mailto:|\/)/.test(url)) return
          close()
          if (range) {
            var sel = getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
          }
          document.execCommand('createLink', false, url)
          changedFromCommand()
        })
        setTimeout(function () { input.focus() }, 30)
        return h('div.cmp', input)
      }, { side: 'above', align: 'center' })
    }

    function typeMenuButton(info) {
      var b = h('button.cell', { type: 'button', 'data-tip': 'Тип блока', onMousedown: function (ev) { ev.preventDefault() } }, h('span', 'Текст'), DX.icon('chevron-down'))
      var blk = info.within && blkOf(info.within)
      var cur = blk && blocks[blockById(blk.dataset.id)]
      if (cur) b.firstChild.textContent = cur.type === 'heading' ? 'Заголовок ' + Math.min(cur.level, 3) : cur.type === 'list' ? 'Список' : cur.type === 'quote' ? 'Цитата' : cur.type === 'callout' ? 'Выноска' : 'Текст'
      b.addEventListener('click', function () {
        DX.popover(b, function (close) {
          var box = h('div')
          ;['para', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'callout'].forEach(function (id) {
            var it = SLASH.filter(function (s) { return s.id === id })[0]
            box.appendChild(DX.mi(it.icon, it.label, function () {
              close()
              if (selPop) selPop.close()
              if (blk) transform(blk, id)
            }))
          })
          return box
        }, { side: 'below' })
      })
      return b
    }

    function comment(info) {
      var anchor = { kind: 'text', quote: info.text, block: info.block }
      var rect = info.rect
      if (selPop) selPop.close()
      selPop = null
      ctx.openComposer(anchor, rect)
    }

    // ---- Marks and pins of the comment threads ----

    function unmark() {
      page.querySelectorAll('.cm').forEach(function (m) {
        var parent = m.parentNode
        while (m.firstChild) parent.insertBefore(m.firstChild, m)
        parent.removeChild(m)
        parent.normalize()
      })
      page.querySelectorAll('.cpin').forEach(function (p) { p.remove() })
    }

    function markQuote(root, quote, thread) {
      var words = quote.replace(/\s+/g, ' ').trim()
      if (!words) return false
      var needle = words.slice(0, 160)
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      var nodes = []
      var text = ''
      var n
      while ((n = walker.nextNode())) {
        if (n.parentElement.closest('.gr, .cm')) continue
        nodes.push({ node: n, start: text.length })
        text += n.nodeValue
      }
      var flat = text.replace(/\s+/g, ' ')
      // Map a position in the collapsed text back to the original.
      var map = []
      var prevSpace = false
      for (var i = 0; i < text.length; i += 1) {
        var space = /\s/.test(text[i])
        if (space && prevSpace) continue
        map.push(i)
        prevSpace = space
      }
      var at = flat.indexOf(needle)
      if (at === -1) return false
      var endFlat = Math.min(flat.length, at + words.length)
      var from = map[at]
      var to = (map[endFlat - 1] !== undefined ? map[endFlat - 1] : text.length - 1) + 1
      nodes.forEach(function (item) {
        var s = Math.max(from, item.start)
        var e = Math.min(to, item.start + item.node.nodeValue.length)
        if (e <= s) return
        var range = document.createRange()
        range.setStart(item.node, s - item.start)
        range.setEnd(item.node, e - item.start)
        var m = h('span.cm', { 'data-thread': thread.id, 'data-resolved': thread.status === 'resolved' ? '1' : '0' })
        try {
          range.surroundContents(m)
        } catch (err) {}
      })
      return true
    }

    function renderThreads() {
      if (!page) return
      // The block being typed in keeps its caret: its marks are redone when it loses focus.
      var activeBlk = editing && document.activeElement && blkOf(document.activeElement)
      unmark()
      var perBlock = {}
      var open = 0
      ctx.threads().forEach(function (t) {
        if (t.anchor.kind !== 'text') return
        var blk = null
        var hint = t.anchor.block
        if (hint !== null && hint !== undefined && blocks[hint]) {
          var cand = page.querySelector('.blk[data-id="' + blocks[hint].id + '"]')
          if (cand && textOf(cand).indexOf(t.anchor.quote.replace(/\s+/g, ' ').slice(0, 40)) !== -1) blk = cand
        }
        if (!blk) {
          var all = page.querySelectorAll('.blk')
          for (var k = 0; k < all.length; k += 1) {
            if (textOf(all[k]).indexOf(t.anchor.quote.replace(/\s+/g, ' ').slice(0, 40)) !== -1) {
              blk = all[k]
              break
            }
          }
        }
        if (!blk) return
        if (!(activeBlk && blk === activeBlk)) markQuote(bcOf(blk) || blk, t.anchor.quote, t)
        ;(perBlock[blk.dataset.id] = perBlock[blk.dataset.id] || []).push(t)
        open += t.status === 'open' ? 1 : 0
      })
      Object.keys(perBlock).forEach(function (id) {
        var blk = page.querySelector('.blk[data-id="' + id + '"]')
        var list = perBlock[id]
        var openOnes = list.filter(function (t) { return t.status === 'open' })
        var main = openOnes[0] || list[0]
        var pin = h('button.cpin', { type: 'button', contenteditable: 'false', 'data-thread': main.id, 'data-resolved': openOnes.length ? '0' : '1', 'data-tip': list.length + ' ' + (list.length === 1 ? 'комментарий' : 'комментариев'), 'data-tp': 'l' }, String(list.length))
        blk.appendChild(pin)
      })
    }

    function renderToc() {
      if (!tocEl) return
      tocEl.textContent = ''
      var items = []
      blocks.forEach(function (b, i) {
        if (b.type === 'heading' && b.level <= 3 && !(i === 0 && b.level === 1)) items.push(b)
      })
      tocEl.hidden = items.length < 2
      items.forEach(function (b) {
        var row = h('button.ti', { type: 'button', 'data-d': b.level > 2 ? 1 : 0, 'data-id': b.id, onClick: function () {
          var el = page.querySelector('.blk[data-id="' + b.id + '"]')
          if (el) scroller.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' })
        } }, h('i'), h('span', DX.plainInline(b.text) || 'Без названия'))
        tocEl.appendChild(row)
      })
      updateToc()
    }

    function updateToc() {
      if (!tocEl) return
      var top = scroller.scrollTop + 120
      var cur = null
      blocks.forEach(function (b) {
        if (b.type !== 'heading') return
        var el = page.querySelector('.blk[data-id="' + b.id + '"]')
        if (el && el.offsetTop <= top) cur = b.id
      })
      tocEl.querySelectorAll('.ti').forEach(function (t) {
        t.dataset.on = String(t.dataset.id === cur)
      })
    }

    // ---- The controller ----

    ctrl.mount = function () {
      build()
      blocks = DX.parseMarkdown(ctx.data.markdown)
      page.addEventListener('mousedown', startDrag)
      page.addEventListener('focusout', function (e) {
        // Marks of the block just left are put back.
        if (e.relatedTarget && page.contains(e.relatedTarget)) return
        setTimeout(function () {
          if (!page.contains(document.activeElement)) renderThreads()
        }, 0)
      })
      render()
    }
    ctrl.setMode = function (m) {
      mode = m
      closeSlash()
      if (selPop) selPop.close()
      selPop = null
      applyMode()
      renderThreads()
    }
    ctrl.onDirty = function (fn) {
      onDirty = fn
    }
    ctrl.revision = function () {
      return rev
    }
    ctrl.dirty = function () {
      return rev !== savedRev
    }
    ctrl.markSaved = function (at) {
      savedRev = at
    }
    ctrl.markdown = function () {
      return DX.toMarkdown(blocks)
    }
    /** New content from the server: shown at once, the changed blocks lit for a few seconds. */
    ctrl.reload = function (markdown, opts) {
      var old = blocks.map(function (b) { return b.src })
      var next = DX.parseMarkdown(markdown)
      savedRev = rev
      var keepTop = scroller.scrollTop
      blocks = next
      render()
      scroller.scrollTop = keepTop
      if (opts && opts.flash) {
        var oldSet = {}
        old.forEach(function (s) { oldSet[s] = (oldSet[s] || 0) + 1 })
        var lit = []
        blocks.forEach(function (b) {
          if (oldSet[b.src]) oldSet[b.src] -= 1
          else lit.push(b)
        })
        lit.forEach(function (b) {
          var el = page.querySelector('.blk[data-id="' + b.id + '"]')
          if (el) el.classList.add('fresh')
        })
        if (lit.length) {
          var first = page.querySelector('.blk.fresh')
          if (first && opts.scroll !== false) scroller.scrollTo({ top: Math.max(0, first.offsetTop - 140), behavior: 'smooth' })
          setTimeout(function () {
            page.querySelectorAll('.blk.fresh').forEach(function (el) { el.classList.add('fade') })
            setTimeout(function () { page.querySelectorAll('.blk.fresh').forEach(function (el) { el.classList.remove('fresh', 'fade') }) }, 900)
          }, 4500)
        }
      }
    }
    ctrl.renderThreads = renderThreads
    ctrl.refreshHeader = function () {
      var head = page.querySelector('.doc-head')
      if (head) head.replaceWith(headerEl())
    }
    /** Where a thread's words are: scrolls there and lights them. */
    ctrl.reveal = function (thread) {
      var el = page.querySelector('.cm[data-thread="' + thread.id + '"]') || page.querySelector('.cpin[data-thread="' + thread.id + '"]')
      if (!el) return false
      scroller.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scroller.scrollTop - 160), behavior: 'smooth' })
      page.querySelectorAll('.cm').forEach(function (m) { m.classList.toggle('on', m.dataset.thread === thread.id) })
      return true
    }
    /** The place an agent's edit was made (its new words), lit. */
    ctrl.revealText = function (text) {
      var needle = String(text).replace(/\s+/g, ' ').trim().slice(0, 50)
      var all = page.querySelectorAll('.blk')
      for (var i = 0; i < all.length; i += 1) {
        if (needle && textOf(all[i]).indexOf(needle) !== -1) {
          scroller.scrollTo({ top: Math.max(0, all[i].offsetTop - 140), behavior: 'smooth' })
          all[i].classList.remove('flash')
          void all[i].offsetWidth
          all[i].classList.add('flash')
          return true
        }
      }
      return false
    }
    ctrl.lastSelection = function () {
      return lastSel
    }
    ctrl.clearSelection = function () {
      lastSel = null
    }
    ctrl.activeBlockText = function () {
      var sel = getSelection()
      var blk = sel && sel.anchorNode && blkOf(sel.anchorNode)
      return blk ? textOf(blk) : ''
    }
    ctrl.destroy = function () {
      document.removeEventListener('selectionchange', onSelectionChange)
      closeSlash()
      if (selPop) selPop.close()
    }
    ctrl.focusFirst = function () {
      var first = page.querySelector('.blk .bc')
      if (first) focusEnd(first, true)
    }
    return ctrl
  }
})()
