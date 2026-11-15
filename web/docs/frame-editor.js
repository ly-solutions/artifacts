/* The editor's half that lives inside a document's sandboxed frame (HRN-1479).
 *
 * The server inlines this file into the pages it serves to the app view (the frame has no allow-same-origin, so the page
 * around it never touches its DOM). It sleeps until the parent page sends a mode, and then it:
 *   - «edit»: outlines the element under the pointer with a dashed line and its `tag · .class` label, selects on click,
 *     edits the text of a leaf on double click, and applies the style commands the parent sends;
 *   - «comment»: the click picks the element a thread is pinned to; pins are drawn on the elements that have threads;
 *   - always: tells the parent the document's height and forwards ⌘Z / ⇧⌘Z.
 * An element is named by its path: the child indexes from the root (`body`, or `main.doc` for a wrapped fragment).
 * Messages are accepted only from the parent window and only when they come from the page's own origin.
 * The server fills in the parent's origin and whether the page is a wrapped fragment before serving. No data leaves the frame but what is posted to the parent.
 */
;(function () {
  'use strict'
  var PARENT = __DX_ORIGIN__
  var WRAPPED = __DX_WRAPPED__
  var mode = 'view'
  var hovered = null
  var selected = null
  var editing = null
  var pins = []
  var overlay, hoverBox, selBox, label, pinLayer

  function post(message) {
    try {
      window.parent.postMessage(message, PARENT)
    } catch (e) {}
  }

  function root() {
    return (WRAPPED && document.querySelector('main.doc')) || document.body
  }

  function pathOf(node) {
    var path = []
    var base = root()
    while (node && node !== base && node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node))
      node = node.parentElement
    }
    return node === base ? path : null
  }

  function byPath(path) {
    var node = root()
    for (var i = 0; i < path.length; i += 1) {
      node = node && node.children[path[i]]
    }
    return node || null
  }

  function isOurs(node) {
    return !!(node && (node === overlay || (overlay && overlay.contains(node)) || (node.closest && node.closest('#dx-overlay'))))
  }

  function mine(node) {
    return node && node.nodeType === 1 && node !== document.documentElement && node !== document.body && !isOurs(node) && node.tagName !== 'SCRIPT'
  }

  function nameOf(node) {
    var cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean)[0] : ''
    return node.tagName.toLowerCase() + (cls ? ' · .' + cls : '')
  }

  // ---- The overlay: drawn in the page, never part of it ----

  function ensureOverlay() {
    if (overlay) return
    var style = document.createElement('style')
    style.id = 'dx-overlay-style'
    style.textContent =
      '#dx-overlay{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;font:600 11px/1 ui-monospace,Menlo,monospace}' +
      '#dx-overlay .dx-box{position:absolute;box-sizing:border-box;border-radius:3px;display:none}' +
      '#dx-overlay .dx-hov{outline:1.5px dashed rgba(123,97,255,.8);outline-offset:3px}' +
      '#dx-overlay .dx-sel{outline:1.5px solid #7b61ff;outline-offset:3px}' +
      '#dx-overlay .dx-label{position:absolute;display:none;height:20px;padding:0 7px;align-items:center;border-radius:6px 6px 6px 0;background:#7b61ff;color:#fff;white-space:nowrap}' +
      '#dx-overlay .dx-pin{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50% 50% 50% 4px;background:#f6d860;color:#3b3200;display:grid;place-items:center;font:700 11px/1 system-ui,sans-serif;box-shadow:0 4px 10px -2px rgba(0,0,0,.4);pointer-events:auto;cursor:pointer}' +
      '#dx-overlay .dx-pin[data-resolved="1"]{opacity:.45}' +
      '[data-dx-editing="1"]{outline:2px solid #7b61ff !important;outline-offset:3px;cursor:text}' +
      '.dx-flash{animation:dx-flash 1.8s ease-out}@keyframes dx-flash{0%,55%{background-color:rgba(123,97,255,.28)!important;box-shadow:0 0 0 6px rgba(123,97,255,.28)}100%{box-shadow:0 0 0 0 transparent}}'
    ;(document.head || document.documentElement).appendChild(style)
    overlay = document.createElement('div')
    overlay.id = 'dx-overlay'
    overlay.setAttribute('aria-hidden', 'true')
    hoverBox = document.createElement('div')
    hoverBox.className = 'dx-box dx-hov'
    selBox = document.createElement('div')
    selBox.className = 'dx-box dx-sel'
    label = document.createElement('div')
    label.className = 'dx-label'
    pinLayer = document.createElement('div')
    overlay.appendChild(hoverBox)
    overlay.appendChild(selBox)
    overlay.appendChild(label)
    overlay.appendChild(pinLayer)
    document.documentElement.appendChild(overlay)
  }

  function rectOf(node) {
    var r = node.getBoundingClientRect()
    return { x: r.left + window.pageXOffset, y: r.top + window.pageYOffset, w: r.width, h: r.height }
  }

  function place(box, node) {
    if (!node || !node.isConnected) {
      box.style.display = 'none'
      return null
    }
    var r = rectOf(node)
    box.style.display = 'block'
    box.style.left = r.x + 'px'
    box.style.top = r.y + 'px'
    box.style.width = r.w + 'px'
    box.style.height = r.h + 'px'
    return r
  }

  function draw() {
    if (!overlay) return
    if (mode === 'view') {
      hoverBox.style.display = selBox.style.display = label.style.display = 'none'
    } else {
      place(hoverBox, hovered && hovered !== selected ? hovered : null)
      var r = place(selBox, selected)
      var shown = hovered && hovered !== selected ? hovered : selected
      var lr = shown === selected ? r : shown ? rectOf(shown) : null
      if (shown && lr) {
        label.textContent = nameOf(shown)
        label.style.display = 'flex'
        label.style.left = Math.max(2, lr.x - 4) + 'px'
        label.style.top = Math.max(2, lr.y - 31) + 'px'
      } else label.style.display = 'none'
    }
    drawPins()
  }

  function drawPins() {
    pinLayer.textContent = ''
    pins.forEach(function (pin) {
      var node = byPath(pin.path)
      if (!node) return
      var r = rectOf(node)
      var el = document.createElement('div')
      el.className = 'dx-pin'
      el.textContent = String(pin.n)
      el.dataset.resolved = pin.resolved ? '1' : '0'
      el.style.left = Math.min(r.x + r.w, document.documentElement.scrollWidth - 14) + 'px'
      el.style.top = Math.max(r.y, 14) + 'px'
      el.addEventListener('click', function (event) {
        event.stopPropagation()
        post({ t: 'pin-click', id: pin.id })
      })
      pinLayer.appendChild(el)
    })
  }

  // ---- What the parent needs to know about an element ----

  function px(value) {
    var n = parseFloat(value)
    return isNaN(n) ? 0 : Math.round(n * 100) / 100
  }

  function describe(node) {
    var cs = getComputedStyle(node)
    var cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : []
    var same = 0
    if (cls.length) {
      try {
        same = document.querySelectorAll('.' + cls.map(function (c) { return CSS.escape(c) }).join('.')).length
      } catch (e) {}
    }
    var fs = px(cs.fontSize)
    var lh = cs.lineHeight === 'normal' ? 1.2 : Math.round((px(cs.lineHeight) / (fs || 16)) * 100) / 100
    return {
      path: pathOf(node),
      tag: node.tagName.toLowerCase(),
      cls: cls,
      label: nameOf(node),
      text: (node.innerText || node.textContent || '').trim().slice(0, 160),
      leaf: !node.children.length,
      same: same,
      rect: rectOf(node),
      style: {
        fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        fontSize: fs,
        fontWeight: cs.fontWeight,
        lineHeight: lh,
        letterSpacing: px(cs.letterSpacing),
        textAlign: cs.textAlign === 'start' ? 'left' : cs.textAlign,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        marginTop: px(cs.marginTop),
        marginBottom: px(cs.marginBottom),
        padding: px(cs.paddingTop),
        width: Math.round(node.getBoundingClientRect().width),
        borderRadius: px(cs.borderTopLeftRadius),
      },
    }
  }

  /** The colours the page uses most: for the swatches. */
  function palette() {
    var count = {}
    var nodes = document.body.querySelectorAll('*')
    for (var i = 0; i < nodes.length && i < 600; i += 1) {
      if (isOurs(nodes[i])) continue
      var cs = getComputedStyle(nodes[i])
      ;[cs.color, cs.backgroundColor].forEach(function (c) {
        if (!c || /^rgba\(.*,\s*0\)$/.test(c) || c === 'transparent') return
        count[c] = (count[c] || 0) + 1
      })
    }
    return Object.keys(count)
      .sort(function (a, b) {
        return count[b] - count[a]
      })
      .slice(0, 6)
  }

  function select(node) {
    selected = node
    draw()
    if (!node) return post({ t: 'deselect' })
    post({ t: 'selected', info: describe(node), palette: palette() })
  }

  // ---- Pointer ----

  function target(event) {
    var node = event.target
    while (node && node.nodeType !== 1) node = node.parentNode
    return mine(node) ? node : null
  }

  document.addEventListener(
    'mousemove',
    function (event) {
      if (mode === 'view' || editing) return
      var node = target(event)
      if (node !== hovered) {
        hovered = node
        draw()
      }
    },
    true,
  )
  document.addEventListener('mouseleave', function () {
    hovered = null
    draw()
  })

  document.addEventListener(
    'click',
    function (event) {
      if (mode === 'view') return
      var node = target(event)
      if (isOurs(event.target)) return
      if (editing && node === editing) return
      event.preventDefault()
      event.stopPropagation()
      if (editing) finishText()
      if (!node) return mode === 'edit' ? select(null) : undefined
      if (mode === 'comment') {
        return post({ t: 'comment-at', info: { path: pathOf(node), label: nameOf(node), text: (node.innerText || '').trim().slice(0, 160), rect: rectOf(node) } })
      }
      select(node)
    },
    true,
  )

  document.addEventListener(
    'dblclick',
    function (event) {
      if (mode !== 'edit') return
      var node = target(event)
      if (!node || !textual(node)) return
      event.preventDefault()
      startText(node)
    },
    true,
  )

  /** Text can be edited in place where there is only text and inline marks inside. */
  function textual(node) {
    if (!(node.textContent || '').trim() && !node.children.length) return false
    for (var i = 0; i < node.children.length; i += 1) {
      if (!/^(A|B|I|EM|STRONG|SPAN|BR|SMALL|CODE|U|S|MARK|SUP|SUB|ABBR|TIME)$/.test(node.children[i].tagName)) return false
    }
    return true
  }

  function startText(node) {
    if (editing) finishText()
    editing = node
    node.dataset.dxEditing = '1'
    node.dataset.dxBefore = node.innerHTML
    node.contentEditable = 'true'
    node.focus()
    try {
      var range = document.createRange()
      range.selectNodeContents(node)
      var sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    } catch (e) {}
    draw()
    node.addEventListener('blur', finishText, { once: true })
    node.addEventListener('keydown', onEditKey)
  }

  function onEditKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      editing.innerHTML = editing.dataset.dxBefore
      finishText()
    } else if (event.key === 'Enter' && !event.shiftKey && !/^(DIV|LI|BLOCKQUOTE|TD|TH)$/.test(editing.tagName)) {
      event.preventDefault()
      finishText()
    }
  }

  function finishText() {
    var node = editing
    if (!node) return
    editing = null
    node.removeEventListener('keydown', onEditKey)
    node.removeAttribute('contenteditable')
    delete node.dataset.dxEditing
    var before = node.dataset.dxBefore
    delete node.dataset.dxBefore
    var after = node.innerHTML
    if (node.getAttribute('style') === '') node.removeAttribute('style')
    if (after !== before) post({ t: 'text-changed', path: pathOf(node), before: before, after: after })
    draw()
    if (selected === node) post({ t: 'selected', info: describe(node), palette: palette() })
  }

  // ---- Commands from the parent ----

  function pageCss(css) {
    var tag = document.getElementById('dx-page-css')
    if (!tag) {
      tag = document.createElement('style')
      tag.id = 'dx-page-css'
      ;(document.head || document.documentElement).appendChild(tag)
    }
    tag.textContent = css
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== PARENT) return
    var m = event.data
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return
    ensureOverlay()
    if (m.t === 'mode') {
      if (editing) finishText()
      mode = m.mode === 'edit' || m.mode === 'comment' ? m.mode : 'view'
      if (mode === 'view') {
        hovered = null
        selected = null
      }
      document.documentElement.style.cursor = mode === 'comment' ? 'crosshair' : ''
      draw()
    } else if (m.t === 'style') {
      var node = byPath(m.path || [])
      if (node) {
        if (m.value === '' || m.value === null) node.style.removeProperty(m.prop)
        else node.style.setProperty(m.prop, m.value)
        if (node.getAttribute('style') === '') node.removeAttribute('style')
        draw()
        if (m.report && selected === node) post({ t: 'selected', info: describe(node), palette: palette() })
      }
    } else if (m.t === 'html') {
      var target = byPath(m.path || [])
      if (target) {
        target.innerHTML = m.html
        draw()
      }
    } else if (m.t === 'css') {
      pageCss(String(m.css || ''))
      draw()
      if (selected) post({ t: 'selected', info: describe(selected), palette: palette() })
    } else if (m.t === 'select') {
      var pick = m.path ? byPath(m.path) : null
      select(pick)
      if (pick && m.scroll) pick.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (m.t === 'pins') {
      pins = Array.isArray(m.items) ? m.items : []
      draw()
    } else if (m.t === 'flash') {
      var f = byPath(m.path || [])
      if (f) {
        f.scrollIntoView({ block: 'center', behavior: 'smooth' })
        f.classList.remove('dx-flash')
        void f.offsetWidth
        f.classList.add('dx-flash')
        setTimeout(function () {
          f.classList.remove('dx-flash')
        }, 2000)
      }
    } else if (m.t === 'scroll') {
      window.scrollTo({ top: Number(m.y) || 0, behavior: 'smooth' })
    }
  })

  // ⌘Z and ⇧⌘Z inside the page belong to the editor around it.
  document.addEventListener(
    'keydown',
    function (event) {
      if (mode !== 'edit' || editing) return
      var key = String(event.key).toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
        event.preventDefault()
        post({ t: 'undo-key', redo: key === 'y' || event.shiftKey })
      } else if (key === 'escape') {
        select(null)
      }
    },
    true,
  )

  function sizeNow() {
    post({ t: 'size', height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })
    if (mode !== 'view' || pins.length) draw()
  }
  window.addEventListener('resize', sizeNow)
  window.addEventListener('load', sizeNow)
  window.addEventListener('scroll', function () {
    post({ t: 'scrolled', y: window.pageYOffset })
  })
  document.addEventListener('DOMContentLoaded', function () {
    ensureOverlay()
    post({ t: 'ready', wrapped: WRAPPED })
    sizeNow()
  })
  if (document.readyState !== 'loading') {
    ensureOverlay()
    post({ t: 'ready', wrapped: WRAPPED })
  }
})()
