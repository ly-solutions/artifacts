/* An HTML document edited like in Sinopia: the page lives in a sandboxed frame (no access to this page), and the editor
 * talks to it with postMessage. Hover outlines an element, a click selects it, the island «Стиль» changes it, a double
 * click edits a text in place. Every change is an operation that is applied twice — to the live frame and to the document's
 * own source (parsed here without running anything) — so what is saved is the real HTML file, with an undo and a redo. */
;(function () {
  'use strict'
  var DX = window.DX
  var h = DX.h

  var FAMILIES = ['Inter', 'system-ui', 'Georgia', 'Times New Roman', 'Helvetica Neue', 'Arial', 'Courier New', 'monospace']
  var WEIGHTS = [['300', 'Лёгкий'], ['400', 'Обычный'], ['500', 'Средний'], ['600', 'Полужирный'], ['700', 'Жирный'], ['800', 'Сверхжирный']]
  var KEBAB = { fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', lineHeight: 'line-height', letterSpacing: 'letter-spacing', textAlign: 'text-align', color: 'color', backgroundColor: 'background-color', marginTop: 'margin-top', marginBottom: 'margin-bottom', padding: 'padding', width: 'width', borderRadius: 'border-radius' }

  function rgbToHex(rgb) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(rgb || '')
    if (!m) return null
    if (m[4] !== undefined && Number(m[4]) === 0) return null
    return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + Number(n).toString(16)).slice(-2) }).join('')
  }

  /** Sets (or adds) one declaration in one rule of a stylesheet text, keeping the rest as it is. */
  DX.setRuleProp = function (css, selector, prop, value) {
    var esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    var re = new RegExp('(^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm')
    var decl = prop + ':' + value + ' !important'
    var m = re.exec(css)
    if (!m) return (css && !css.endsWith('\n') ? css + '\n' : css) + selector + ' { ' + (value === '' ? '' : decl + ';') + ' }\n'
    var body = m[2]
    var propRe = new RegExp('(^|;)\\s*' + prop.replace(/-/g, '\\-') + '\\s*:[^;]*;?', 'i')
    if (value === '') body = body.replace(propRe, '$1')
    else if (propRe.test(body)) body = body.replace(propRe, '$1 ' + decl + ';')
    else body = body.replace(/\s*$/, '') + (body.trim() && !/;\s*$/.test(body.trim()) ? ';' : '') + ' ' + decl + '; '
    return css.slice(0, m.index) + m[1] + ' ' + selector + ' {' + body + '}' + css.slice(m.index + m[0].length)
  }

  DX.HtmlDoc = function (ctx, host) {
    var ctrl = {}
    var wrap, frame, stageEl, insp
    var mode = 'view'
    var tool = 'select' // select | comment (in edit and in view)
    var device = 'desktop'
    var srcDoc = null
    var hadDoctype = true
    var fragment = false
    var history = []
    var at = 0
    var rev = 0
    var savedRev = 0
    var selected = null
    var palette = []
    var applyAll = false
    var cssText = ''
    var cssOpen = false
    var open = { text: true, color: true, space: false }
    var ready = false
    var frameScroll = 0
    var onDirty = function () {}
    var onSelect = function () {}

    // ---- The source: parsed, never run ----

    var parsed = false
    /** The source is parsed when the first edit needs it: a document that is only read never is. */
    function ensureParsed() {
      if (parsed) return
      parsed = true
      parse(ctx.data.html || '')
    }

    // The page's own policy refuses `style="…"` the moment a parser meets one, even in a document nobody sees (a
    // console error each time). The source is parsed with the attribute under another name and given its name back
    // when it is written: a document's text round-trips, and nothing is reported.
    var GUARD_ATTR = /(<[a-zA-Z][^<>]*?\s)style(\s*=)/g
    var guard = function (html) { return String(html).replace(GUARD_ATTR, function (all, head, eq) { return head + 'data-dx-style' + eq }) }
    var unguard = function (html) { return String(html).replace(/(\s)data-dx-style(\s*=)/g, '$1style$2') }
    /** The inline style of a node of the source as a style object (built off page, by the CSS object model). */
    function inlineStyle(node) {
      var probe = document.createElement('div')
      probe.style.cssText = node.getAttribute('data-dx-style') || ''
      return probe.style
    }
    function writeInlineStyle(node, st) {
      if (st.cssText) node.setAttribute('data-dx-style', st.cssText)
      else node.removeAttribute('data-dx-style')
    }

    function parse(html) {
      hadDoctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype/i.test(html)
      fragment = !!ctx.data.wrapped
      srcDoc = new DOMParser().parseFromString(guard(html), 'text/html')
      var tag = srcDoc.getElementById('dx-page-css')
      cssText = tag ? tag.textContent : ''
    }

    function serialize() {
      if (!parsed) return ctx.data.html || ''
      if (fragment) return unguard(srcDoc.body.innerHTML)
      return (hadDoctype ? '<!doctype html>\n' : '') + unguard(srcDoc.documentElement.outerHTML)
    }

    function nodeAt(path) {
      var node = srcDoc.body
      for (var i = 0; i < path.length; i += 1) {
        node = node && node.children[path[i]]
      }
      return node || null
    }

    // ---- Operations: applied to the frame and to the source, and kept for undo ----

    function send(msg) {
      if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, '*')
    }
    // The frame has an opaque origin; it checks that messages come from its parent window and from our origin.

    function applyOp(op, forward) {
      ensureParsed()
      var value = forward ? op.after : op.before
      if (op.k === 'style') {
        var el = nodeAt(op.path)
        if (el) {
          var st = inlineStyle(el)
          if (value === '' || value === null) st.removeProperty(op.prop)
          else st.setProperty(op.prop, value)
          writeInlineStyle(el, st)
        }
        send({ t: 'style', path: op.path, prop: op.prop, value: value, report: !op.quiet })
      } else if (op.k === 'html') {
        var t = nodeAt(op.path)
        if (t) t.innerHTML = guard(value)
        send({ t: 'html', path: op.path, html: value })
      } else if (op.k === 'css') {
        cssText = value
        var tag = srcDoc.getElementById('dx-page-css')
        if (!tag) {
          tag = srcDoc.createElement('style')
          tag.id = 'dx-page-css'
          ;(srcDoc.head || srcDoc.documentElement).appendChild(tag)
        }
        tag.textContent = value
        send({ t: 'css', css: value })
      }
    }

    function record(op) {
      var last = history[at - 1]
      // Typing in one field is one step.
      if (last && last.k === op.k && last.merge && op.merge && last.merge === op.merge && Date.now() - last.time < 1500) {
        last.after = op.after
        last.time = Date.now()
        applyOp(op, true)
      } else {
        history = history.slice(0, at)
        op.time = Date.now()
        history.push(op)
        at = history.length
        applyOp(op, true)
      }
      rev += 1
      onDirty()
      ctrl.refreshTools()
    }

    ctrl.undo = function () {
      if (at < 1) return
      at -= 1
      applyOp(history[at], false)
      rev += 1
      onDirty()
      ctrl.refreshTools()
    }
    ctrl.redo = function () {
      if (at >= history.length) return
      applyOp(history[at], true)
      at += 1
      rev += 1
      onDirty()
      ctrl.refreshTools()
    }
    ctrl.canUndo = function () { return at > 0 }
    ctrl.canRedo = function () { return at < history.length }
    ctrl.refreshTools = function () {
      ctx.toolsChanged()
    }

    function setStyle(prop, value, quiet) {
      if (!selected) return
      ensureParsed()
      var cssProp = KEBAB[prop] || prop
      if (applyAll && selected.cls.length) {
        var selector = '.' + selected.cls[0]
        record({ k: 'css', before: cssText, after: DX.setRuleProp(cssText, selector, cssProp, value), merge: 'rule:' + selector + cssProp })
        return
      }
      var node = nodeAt(selected.path)
      var before = node ? inlineStyle(node).getPropertyValue(cssProp) : ''
      if (before === value) return
      record({ k: 'style', path: selected.path, prop: cssProp, before: before, after: value, quiet: !!quiet, merge: 'style:' + selected.path.join('.') + cssProp })
    }

    // ---- The frame ----

    ctrl.mount = function () {
      stageEl = h('div.stage')
      wrap = h('div.frame-wrap', { 'data-dev': device })
      frame = h('iframe', { title: ctx.data.title, sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads', src: ctx.data.contentUrl })
      wrap.appendChild(frame)
      stageEl.appendChild(wrap)
      host.appendChild(stageEl)
      window.addEventListener('message', onMessage)
    }

    function onMessage(event) {
      if (!frame || event.source !== frame.contentWindow) return
      var m = event.data || {}
      if (m.t === 'ready') {
        ready = true
        send({ t: 'mode', mode: effectiveMode() })
        ctrl.pins()
      } else if (m.t === 'selected') {
        selected = m.info
        palette = (m.palette || []).map(rgbToHex).filter(Boolean)
        drawInsp()
        onSelect(selected)
      } else if (m.t === 'deselect') {
        selected = null
        drawInsp()
        onSelect(null)
      } else if (m.t === 'text-changed') {
        record({ k: 'html', path: m.path, before: m.before, after: m.after })
        // The frame already shows the new text: only the source and history take the step.
      } else if (m.t === 'comment-at') {
        var r = m.info.rect
        var box = frame.getBoundingClientRect()
        ctx.openComposer({ kind: 'element', path: m.info.path, label: m.info.label, text: m.info.text }, { x: box.left + r.x, y: box.top + r.y - frameScroll, w: r.w, h: r.h })
        ctrl.setTool('select')
      } else if (m.t === 'pin-click') {
        ctx.openThread(m.id)
      } else if (m.t === 'undo-key') {
        if (m.redo) ctrl.redo()
        else ctrl.undo()
      } else if (m.t === 'scrolled') {
        frameScroll = m.y
      }
    }

    function effectiveMode() {
      if (tool === 'comment') return 'comment'
      return mode === 'edit' && ctx.canWrite() ? 'edit' : 'view'
    }

    ctrl.setMode = function (m) {
      mode = m
      if (m === 'edit' && ctx.canWrite()) ensureParsed()
      host.dataset.edit = mode === 'edit' && ctx.canWrite() ? '1' : '0'
      if (ready) send({ t: 'mode', mode: effectiveMode() })
      if (mode !== 'edit') {
        selected = null
        closeInsp()
      } else drawInsp()
      ctx.layout()
    }
    ctrl.setTool = function (t) {
      tool = t
      if (ready) send({ t: 'mode', mode: effectiveMode() })
      ctx.toolsChanged()
    }
    ctrl.tool = function () { return tool }
    ctrl.setDevice = function (d) {
      device = d
      wrap.dataset.dev = d
      ctx.toolsChanged()
      setTimeout(function () { send({ t: 'mode', mode: effectiveMode() }) }, 320)
    }
    ctrl.device = function () { return device }
    ctrl.pins = function () {
      if (!ready) return
      var items = []
      var n = 0
      ctx.threads().forEach(function (t) {
        n += 1
        if (t.anchor.kind === 'element') items.push({ id: t.id, path: t.anchor.path, n: n, resolved: t.status === 'resolved' })
      })
      // The pin carries the thread's number in the whole list.
      send({ t: 'pins', items: items })
    }
    ctrl.renderThreads = ctrl.pins
    ctrl.reveal = function (thread) {
      if (thread.anchor.kind !== 'element') return false
      send({ t: 'flash', path: thread.anchor.path })
      return true
    }
    ctrl.revealText = function () { return false }
    ctrl.revision = function () { return rev }
    ctrl.dirty = function () { return rev !== savedRev }
    ctrl.markSaved = function (v) { savedRev = v }
    ctrl.html = serialize
    ctrl.onDirty = function (fn) { onDirty = fn }
    ctrl.onSelect = function (fn) { onSelect = fn }
    ctrl.reload = function (data) {
      ctx.data = data
      history = []
      at = 0
      rev = 0
      savedRev = 0
      selected = null
      ready = false
      parsed = false
      frame.src = data.contentUrl
      drawInsp()
    }
    ctrl.refreshHeader = function () {}
    ctrl.lastSelection = function () { return null }
    ctrl.clearSelection = function () {}
    ctrl.destroy = function () {
      window.removeEventListener('message', onMessage)
    }
    ctrl.resized = function () { send({ t: 'mode', mode: effectiveMode() }) }

    // ---- The island «Стиль» ----

    function closeInsp() {
      if (!insp) return
      var gone = insp
      insp = null
      gone.dataset.ph = 'closing'
      setTimeout(function () { gone.remove() }, 200)
    }

    function drawInsp() {
      if (mode !== 'edit' || !ctx.canWrite()) return closeInsp()
      var fresh = !insp
      if (!insp) {
        insp = h('aside.insp', { 'aria-label': 'Стиль' })
        host.appendChild(insp)
      }
      var keep = insp.scrollTop
      var active = document.activeElement
      var activeKey = active && insp.contains(active) && active.getAttribute ? active.getAttribute('aria-label') : null
      insp.textContent = ''
      if (!selected) {
        insp.appendChild(h('div.ih', h('b', 'Стиль')))
        insp.appendChild(h('div.none', h('b', 'Выберите элемент'), 'Наведите на страницу и щёлкните по заголовку, кнопке или блоку. Двойной щелчок по тексту правит слова.'))
        insp.appendChild(cssSection())
        return
      }
      var s = selected.style
      insp.appendChild(h('div.ih', h('b', 'Стиль'), h('code', selected.label)))
      insp.appendChild(section('text', 'Текст', function () {
        var box = h('div.secb')
        box.appendChild(h('div.f2', menuField(s.fontFamily, FAMILIES.map(function (f) { return [f, f] }), function (v) { setStyle('fontFamily', v.indexOf(' ') !== -1 ? '"' + v + '"' : v) }), menuField(weightLabel(s.fontWeight), WEIGHTS, function (v) { setStyle('fontWeight', v) })))
        box.appendChild(h('div.f2', numField('Размер', s.fontSize, 'px', 1, function (v) { setStyle('fontSize', v + 'px') }), numField('Интервал', s.lineHeight, '', 0.05, function (v) { setStyle('lineHeight', String(v)) })))
        box.appendChild(h('div.f2', numField('Трекинг', s.letterSpacing, 'px', 0.1, function (v) { setStyle('letterSpacing', v + 'px') }), h('div')))
        var al = h('div.alr')
        ;[['left', 'align-left', 'По левому краю'], ['center', 'align-center', 'По центру'], ['right', 'align-right', 'По правому краю']].forEach(function (a) {
          al.appendChild(DX.ib(a[1], a[2], function () { setStyle('textAlign', a[0]) }, { on: s.textAlign === a[0] }))
        })
        box.appendChild(al)
        return box
      }))
      insp.appendChild(section('color', 'Цвет', function () {
        var box = h('div.secb')
        box.appendChild(swatches('Текст', s.color, 'color'))
        box.appendChild(swatches('Фон', s.backgroundColor, 'backgroundColor'))
        return box
      }))
      insp.appendChild(section('space', 'Отступы и размер', function () {
        var box = h('div.secb')
        box.appendChild(h('div.f2', numField('Сверху', s.marginTop, 'px', 1, function (v) { setStyle('marginTop', v + 'px') }), numField('Снизу', s.marginBottom, 'px', 1, function (v) { setStyle('marginBottom', v + 'px') })))
        box.appendChild(h('div.f2', numField('Внутри', s.padding, 'px', 1, function (v) { setStyle('padding', v + 'px') }), numField('Скругл.', s.borderRadius, 'px', 1, function (v) { setStyle('borderRadius', v + 'px') })))
        box.appendChild(h('div.f2', numField('Ширина', s.width, 'px', 1, function (v) { setStyle('width', v + 'px') }), h('div')))
        return box
      }))
      var hasClass = selected.cls.length > 0
      var tg = h('button.tg', { type: 'button', disabled: !hasClass, onClick: function () { applyAll = !applyAll; drawInsp() } },
        h('span', h('b', 'У всех таких же'), h('small', hasClass ? 'Стиль класса .' + selected.cls[0] + ' · ' + selected.same + ' на странице' : 'У элемента нет класса')),
        h('span.sw2', { 'data-on': String(applyAll && hasClass) }))
      insp.appendChild(tg)
      insp.appendChild(cssSection())
      if (!fresh) insp.scrollTop = keep
      if (activeKey) {
        var again = insp.querySelector('input[aria-label="' + activeKey.replace(/"/g, '') + '"]')
        if (again && again.type === 'text') {
          again.focus()
          again.select()
        }
      }
    }

    function weightLabel(w) {
      var f = WEIGHTS.filter(function (x) { return x[0] === String(w) })[0]
      return f ? f[1] : String(w)
    }

    function section(id, title, body) {
      var wrapEl = h('div.sec')
      var head = h('button.sech', { type: 'button', 'data-open': String(!!open[id]), onClick: function () { open[id] = !open[id]; drawInsp() } }, h('span', title), DX.icon('chevron-down'))
      wrapEl.appendChild(head)
      if (open[id]) wrapEl.appendChild(body())
      return wrapEl
    }

    function numField(label, value, unit, step, onChange) {
      var input = h('input', { type: 'text', inputmode: 'decimal', value: String(Math.round(value * 100) / 100), 'aria-label': label })
      function commit() {
        var v = parseFloat(String(input.value).replace(',', '.'))
        if (isNaN(v)) return (input.value = String(value))
        onChange(Math.round(v * 100) / 100)
      }
      input.addEventListener('change', commit)
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') commit()
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          var v = (parseFloat(input.value) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)
          input.value = String(Math.round(v * 100) / 100)
          commit()
        }
      })
      return h('label.fld', h('em', label), input, unit ? h('em', unit) : null)
    }

    function menuField(current, options, onPick) {
      var f = h('button.fld.sel', { type: 'button', onClick: function () {
        DX.popover(f, function (close) {
          var box = h('div.sugg')
          options.forEach(function (o) { box.appendChild(DX.mi(null, o[1], function () { close(); onPick(o[0]) })) })
          return box
        })
      } }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, current), DX.icon('chevron-down'))
      return f
    }

    function swatches(label, current, prop) {
      var row = h('div.sws', h('span.lab', label))
      var cur = rgbToHex(current)
      var list = palette.slice(0, 5)
      if (cur && list.indexOf(cur) === -1) list.unshift(cur)
      list.slice(0, 6).forEach(function (c) {
        row.appendChild(h('i', { style: 'background:' + c, 'data-on': String(c === cur), 'data-tip': c, onClick: function () { setStyle(prop, c) } }))
      })
      var pick = h('input', { type: 'color', value: cur || '#000000', 'aria-label': label + ': свой цвет', onInput: function (e) { setStyle(prop, e.target.value, true) }, onChange: function () { send({ t: 'select', path: selected.path }) } })
      row.appendChild(pick)
      if (window.EyeDropper) {
        row.appendChild(DX.ib('pipette', 'Пипетка', function () {
          new window.EyeDropper().open().then(function (r) { setStyle(prop, r.sRGBHex) }, function () {})
        }))
      }
      return row
    }

    function cssSection() {
      var wrapEl = h('div')
      var btn = h('button.cssbtn', { type: 'button', onClick: function () { cssOpen = !cssOpen; drawInsp() } }, DX.icon('code-xml'), h('span', cssOpen ? 'Скрыть CSS страницы' : 'CSS страницы'))
      wrapEl.appendChild(btn)
      if (cssOpen) {
        var ta = h('textarea.cssta', { spellcheck: 'false', 'aria-label': 'CSS страницы', placeholder: '/* правила для всей страницы */' })
        ta.value = cssText
        ta.addEventListener('input', function () {
          record({ k: 'css', before: cssText, after: ta.value, merge: 'css-field' })
        })
        wrapEl.appendChild(h('div.secb', ta))
      }
      return wrapEl
    }

    ctrl.hasInspector = function () { return !!insp }
    return ctrl
  }
})()
