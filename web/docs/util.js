/* Helpers of the documents app: DOM building, icons, dates, the server calls, popovers with an exit animation. */
;(function () {
  'use strict'
  var DX = (window.DX = window.DX || {})

  /** h('div.cls', {onClick, 'data-x': 1, style}, child, 'text', [children]) → element. Text is always a text node. */
  DX.h = function h(spec, props) {
    var m = /^([a-z0-9-]+)((?:\.[\w-]+)*)$/i.exec(spec)
    var el = document.createElement(m ? m[1] : 'div')
    if (m && m[2]) el.className = m[2].slice(1).replace(/\./g, ' ')
    if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
      Object.keys(props).forEach(function (key) {
        var value = props[key]
        if (value === null || value === undefined || value === false) return
        if (key.slice(0, 2) === 'on' && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
        else if (key === 'class') el.className += (el.className ? ' ' : '') + value
        else if (key === 'text') el.textContent = value
        else if (key === 'style') styleOf(el, String(value))
        else if (key === 'value') el.value = value
        else if (key === 'checked' || key === 'disabled') el[key] = !!value
        else el.setAttribute(key, value === true ? '' : String(value))
      })
      start = 2
    } else start = 1
    for (var i = start; i < arguments.length; i += 1) add(el, arguments[i])
    return el
    var start
  }
  /** A style attribute is blocked by the page's CSP: the declarations go in through the CSS object model instead. */
  function styleOf(el, text) {
    text.split(';').forEach(function (decl) {
      var at = decl.indexOf(':')
      if (at > 0) el.style.setProperty(decl.slice(0, at).trim(), decl.slice(at + 1).trim())
    })
  }
  function add(el, child) {
    if (child === null || child === undefined || child === false) return
    if (Array.isArray(child)) return child.forEach(function (c) { add(el, c) })
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  var h = DX.h

  DX.icon = function (name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.75')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''))
    // The inner markup is our own constant (icons.js), never document content.
    svg.innerHTML = (window.DX_ICONS && window.DX_ICONS[name]) || ''
    return svg
  }

  /** An icon button with a tooltip: label (and key) on hover after a moment. */
  DX.ib = function (icon, tip, onClick, opts) {
    opts = opts || {}
    var b = h('button.ib', { type: 'button', 'data-tip': tip, 'data-tp': opts.tp || null, 'aria-label': tip.replace(/\s·.*$/, ''), onClick: onClick }, DX.icon(icon))
    if (opts.on) b.dataset.on = 'true'
    if (opts.off) b.dataset.off = 'true'
    return b
  }

  // ---- Time and people ----

  var MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  var DAY = 86400000
  DX.startOfDay = function (d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  DX.when = function (iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    var diff = DX.startOfDay(new Date()) - DX.startOfDay(d)
    if (diff === 0) return 'сегодня, ' + hm
    if (diff === DAY) return 'вчера, ' + hm
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') + ', ' + hm
  }
  DX.ago = function (iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 45) return 'только что'
    if (s < 3600) return Math.round(s / 60) + ' мин назад'
    if (s < 86400) return Math.round(s / 3600) + ' ч назад'
    return DX.when(iso)
  }
  /** «Сегодня / На этой неделе / Раньше» for the list. */
  DX.group = function (iso) {
    var d = new Date(iso)
    var today = DX.startOfDay(new Date())
    var t = DX.startOfDay(d)
    if (t >= today) return 'Сегодня'
    var weekday = (new Date().getDay() + 6) % 7
    if (t >= today - weekday * DAY) return 'На этой неделе'
    return 'Раньше'
  }
  function pad(n) {
    return n < 10 ? '0' + n : String(n)
  }

  var PALETTE = ['#7b61ff', '#3b82f6', '#0ea5a4', '#d97706', '#db2777', '#16a34a']
  DX.colorOf = function (name) {
    var sum = 0
    for (var i = 0; i < String(name).length; i += 1) sum = (sum * 31 + String(name).charCodeAt(i)) >>> 0
    return PALETTE[sum % PALETTE.length]
  }
  DX.initials = function (name) {
    var parts = String(name || '?').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean)
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase()
  }
  /** A round avatar; the agent is the orb. */
  DX.avatar = function (name, kind, size) {
    var a = h('span.av' + (size ? '.s' + size : ''), { title: name })
    if (kind === 'agent') a.classList.add('agent')
    else {
      a.textContent = DX.initials(name)
      a.style.background = DX.colorOf(name)
    }
    return a
  }

  // ---- The server ----

  DX.fetchJson = function (path, opts) {
    opts = opts || {}
    var init = { credentials: 'same-origin', method: opts.method || 'GET', headers: { accept: 'application/json' } }
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body)
      init.headers['content-type'] = 'application/json'
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) return { __unauthorized: true }
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) {
          var error = new Error((data && (data.hint || data.error)) || 'HTTP ' + res.status)
          error.status = res.status
          error.code = data && data.error
          throw error
        }
        return data
      })
    })
  }

  // ---- Popovers: one layer, each closes with an animation (never vanishes at once) ----

  var layer
  var open = []
  function ensureLayer() {
    if (!layer || !layer.isConnected) {
      layer = h('div.layer')
      document.body.appendChild(layer)
    }
    return layer
  }

  /**
   * Opens a popover made by `build(close)` near `anchor` (an element or a {x,y,w,h} rect in viewport coordinates).
   * opts: side 'below'|'above' (default below), align 'start'|'end'|'center', cls, onClose, keep (do not close on outside click)
   */
  DX.popover = function (anchor, build, opts) {
    opts = opts || {}
    var host = h('div.pop' + (opts.cls ? '.' + opts.cls : ''), { role: 'menu' })
    var closed = false
    var pop = {
      el: host,
      close: function () {
        if (closed) return
        closed = true
        open = open.filter(function (p) { return p !== pop })
        document.removeEventListener('mousedown', outside, true)
        document.removeEventListener('keydown', onKey, true)
        host.dataset.ph = 'closing'
        setTimeout(function () { host.remove() }, 150)
        if (opts.onClose) opts.onClose()
      },
      place: function () { position(host, anchor, opts) },
    }
    function outside(event) {
      if (host.contains(event.target) || (anchor instanceof Element && anchor.contains(event.target))) return
      if (opts.keep && opts.keep(event.target)) return
      pop.close()
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        pop.close()
      }
    }
    host.appendChild(build(pop.close, pop))
    ensureLayer().appendChild(host)
    position(host, anchor, opts)
    open.push(pop)
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true)
    }, 0)
    document.addEventListener('keydown', onKey, true)
    return pop
  }

  function rectOf(anchor) {
    if (anchor instanceof Element) {
      var r = anchor.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    return anchor
  }

  function position(host, anchor, opts) {
    var r = rectOf(anchor)
    var vw = document.documentElement.clientWidth
    var vh = document.documentElement.clientHeight
    host.style.left = '0px'
    host.style.top = '0px'
    var w = host.offsetWidth
    var hh = host.offsetHeight
    var x = opts.align === 'end' ? r.x + r.w - w : opts.align === 'center' ? r.x + r.w / 2 - w / 2 : r.x
    var below = opts.side !== 'above'
    var y = below ? r.y + r.h + 8 : r.y - hh - 8
    if (below && y + hh > vh - 8 && r.y - hh - 8 > 8) y = r.y - hh - 8
    if (!below && y < 8) y = r.y + r.h + 8
    x = Math.max(8, Math.min(x, vw - w - 8))
    y = Math.max(8, Math.min(y, vh - hh - 8))
    host.style.left = Math.round(x) + 'px'
    host.style.top = Math.round(y) + 'px'
    host.style.setProperty('--ox', Math.round(Math.max(0, r.x + r.w / 2 - x)) + 'px')
  }

  DX.closePopovers = function () {
    open.slice().forEach(function (p) { p.close() })
  }

  /** A menu item row. */
  DX.mi = function (icon, label, onClick, opts) {
    opts = opts || {}
    var row = h('button.mi', { type: 'button', role: 'menuitem', onClick: onClick })
    if (icon) row.appendChild(DX.icon(icon))
    row.appendChild(h('span', label))
    if (opts.hint) row.appendChild(h('small', opts.hint))
    if (opts.danger) row.dataset.dg = 'true'
    if (opts.on) row.dataset.on = 'true'
    return row
  }

  // ---- A short message in the corner ----

  DX.toast = function (text, action) {
    var t = h('div.toast', { role: 'status' }, h('span', text))
    if (action) t.appendChild(h('button.link', { type: 'button', onClick: function () { action.run(); done() } }, action.label))
    ensureLayer().appendChild(t)
    var timer = setTimeout(done, action ? 8000 : 3200)
    function done() {
      clearTimeout(timer)
      t.dataset.ph = 'closing'
      setTimeout(function () { t.remove() }, 200)
    }
    return done
  }

  /** The preference store: per person's browser, never needed. */
  DX.pref = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem('dx.' + key)
        return v === null ? fallback : v
      } catch (e) {
        return fallback
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem('dx.' + key, value)
      } catch (e) {}
    },
  }

  DX.debounce = function (fn, ms) {
    var timer
    var wrapped = function () {
      var args = arguments
      clearTimeout(timer)
      timer = setTimeout(function () { fn.apply(null, args) }, ms)
    }
    wrapped.flush = function () { clearTimeout(timer) }
    return wrapped
  }
})()
