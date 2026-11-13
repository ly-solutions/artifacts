// The documents' app view in harnessly (`/app`, render/ui.mjs appViewPage), built as a site: it reads its own catalog
// from this server (`/app/docs`, by the person's session cookie) and opens a document in the same frame, with a way
// back. Nothing of that waits for harnessly. The harnessly bridge is used for three things only, when it is there: the
// theme, the object harnessly asks to open (`hl.context.data.object`), and the first sign-in — the app's MCP tool
// `doc_signin` answers a one-time pass the page trades for the session cookie, so the next opening needs no bridge at all.
;(function () {
  'use strict'

  var root = document.getElementById('app')
  var TABS = [
    { id: 'all', label: 'Все' },
    { id: 'mine', label: 'Мои' },
    { id: 'shared', label: 'Общие' },
  ]
  var SHELVES = 6
  var PER_SHELF = 8
  var LIMIT = 50
  var BRIDGE_WAIT_MS = 6000

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  function textOf(res) {
    return ((res && res.content) || [])
      .map(function (c) {
        return c.text || ''
      })
      .join('\n')
  }

  function when(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  }

  // ---- The theme: harnessly's when the bridge is there, the system's until then ----

  var theme = { mode: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = theme.mode

  // ---- The bridge: optional, asked once, never awaited by the catalog ----

  var bridge = null
  function connect() {
    if (bridge) return bridge
    bridge = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('no bridge'))
      }, BRIDGE_WAIT_MS)
      if (!window.harnessly || !window.harnessly.connect) return reject(new Error('no bridge'))
      window.harnessly.connect({ protocol: 2 }).then(function (hl) {
        clearTimeout(timer)
        resolve(hl)
      }, reject)
    })
    return bridge
  }

  // ---- Data: our own server, by the session cookie ----

  /** null: the server does not know the person (401). */
  function ask(path) {
    return fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (res) {
      if (res.status === 401) return null
      if (!res.ok) throw new Error(res.status === 404 ? 'not_found' : 'HTTP ' + res.status)
      return res.json()
    })
  }

  /** The first sign-in: harnessly's machine calls the app's MCP tool with the person's token; the answer sets our cookie. */
  var entering = null
  function signIn() {
    if (entering) return entering
    entering = connect()
      .then(function (hl) {
        return hl.tools.call('docs.doc_signin', {}).then(function (res) {
          if (hl.refused(res) || !res || res.isError) throw new Error(textOf(res) || 'refused')
          return (res.structuredContent || JSON.parse(textOf(res))).pass
        })
      })
      .then(function (pass) {
        if (typeof pass !== 'string' || !pass) throw new Error('no sign-in pass')
        return fetch('/app/enter', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: pass }) })
      })
      .then(function (res) {
        if (!res.ok) throw new Error('sign-in refused')
      })
    entering.then(
      function () {
        entering = null
      },
      function () {
        entering = null
      },
    )
    return entering
  }

  /** Asks the server, signing in once when it does not know the person yet. null: the person has to sign in. */
  function own(path) {
    return ask(path).then(function (body) {
      if (body) return body
      return signIn().then(
        function () {
          return ask(path)
        },
        function () {
          return null
        },
      )
    })
  }

  function message(title, text, retry) {
    root.className = 'dv'
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var box = el('div', 'dv__fail hl-empty')
    box.appendChild(el('p', 'hl-h', title))
    if (text) box.appendChild(el('p', 'hl-muted', text))
    if (retry) {
      var again = el('button', 'hl-btn', 'Повторить')
      again.type = 'button'
      again.addEventListener('click', retry)
      box.appendChild(again)
    }
    root.appendChild(box)
  }

  function failed(error) {
    message('Сервис документов сейчас не отвечает', 'Документы и ссылки на них на месте — попробуйте позже.', function () {
      route()
    })
    if (window.console) console.warn(error)
  }

  function needSignIn() {
    message('Не получилось войти в документы', 'Вход идёт через harnessly: откройте приложение ещё раз или повторите.', function () {
      route()
    })
  }

  // ---- Where we are: `?doc=<slug>` is an open document, nothing is the catalog ----

  function current() {
    var slug = new URLSearchParams(location.search).get('doc')
    return slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null
  }

  function go(slug) {
    if (current() === slug) return
    history.pushState(null, '', slug ? '?doc=' + encodeURIComponent(slug) : location.pathname)
    route()
  }

  var opened = null
  function route() {
    var slug = current()
    opened = null
    if (slug) openDoc(slug)
    else home()
  }

  // ---- An open document: a bar with the way back, and the content ----

  function openDoc(slug) {
    root.className = 'dv dv--doc'
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var bar = el('div', 'dv__top')
    var back = el('button', 'hl-btn hl-btn--ghost hl-btn--sm', '← Все документы')
    back.type = 'button'
    back.addEventListener('click', function () {
      go(null)
    })
    bar.appendChild(back)
    var title = el('span', 'dv__top-title', '')
    bar.appendChild(title)
    root.appendChild(bar)
    var frame = el('iframe', 'dv__content')
    // The content is untrusted HTML: the server sandboxes it as well.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads')
    root.appendChild(frame)
    var here = { slug: slug }
    opened = here
    function load() {
      return own('/app/doc?slug=' + encodeURIComponent(slug) + '&theme=' + theme.mode).then(function (doc) {
        if (opened !== here) return
        if (doc === null) return needSignIn()
        title.textContent = doc.title
        frame.title = doc.title
        frame.src = doc.contentUrl
        if (!here.out && doc.url) {
          here.out = el('a', 'hl-btn hl-btn--ghost hl-btn--sm', 'Открыть в новой вкладке')
          here.out.href = doc.url
          here.out.target = '_blank'
          here.out.rel = 'noopener'
          bar.appendChild(here.out)
        }
      })
    }
    here.reload = load
    load().catch(function (error) {
      if (opened !== here) return
      if (error && error.message === 'not_found') message('Такого документа нет', 'Или он вам недоступен.', function () { go(null) })
      else failed(error)
    })
  }

  // ---- The catalog ----

  function card(row) {
    var item = el('a', 'dv__card')
    item.href = '?doc=' + encodeURIComponent(row.slug)
    item.appendChild(el('span', 'dv__name', row.title))
    if (row.description) item.appendChild(el('span', 'dv__desc hl-muted', row.description))
    var meta = [when(row.updatedAt), row.mine ? 'мой' : row.author || ''].filter(Boolean).join(' · ')
    item.appendChild(el('span', 'dv__meta hl-muted', meta))
    item.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      go(row.slug)
    })
    return item
  }

  function grid(rows) {
    var box = el('div', 'dv__grid')
    rows.forEach(function (row) {
      box.appendChild(card(row))
    })
    return box
  }

  /** Shelves: the recent ones, then the most frequent tags. */
  function shelves(rows) {
    var out = [{ title: 'Недавние', rows: rows.slice(0, PER_SHELF) }]
    var count = {}
    rows.forEach(function (row) {
      ;(row.tags || []).forEach(function (tag) {
        count[tag] = (count[tag] || 0) + 1
      })
    })
    Object.keys(count)
      .filter(function (tag) {
        return count[tag] > 1
      })
      .sort(function (a, b) {
        return count[b] - count[a] || a.localeCompare(b)
      })
      .slice(0, SHELVES)
      .forEach(function (tag) {
        out.push({
          title: tag,
          rows: rows
            .filter(function (row) {
              return (row.tags || []).indexOf(tag) >= 0
            })
            .slice(0, PER_SHELF),
        })
      })
    return out
  }

  var view = { tab: 'all', query: '', rows: null }
  function home() {
    root.className = 'dv dv--home'
    var state = view

    var bar = el('div', 'dv__bar')
    var seg = el('div', 'hl-seg dv__tabs')
    seg.setAttribute('role', 'tablist')
    TABS.forEach(function (tab) {
      var b = el('button', 'dv__tab', tab.label)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.dataset.tab = tab.id
      b.addEventListener('click', function () {
        state.tab = tab.id
        draw()
      })
      seg.appendChild(b)
    })
    var search = el('input', 'hl-input dv__search')
    search.type = 'search'
    search.value = state.query
    search.placeholder = 'Поиск по документам'
    search.setAttribute('aria-label', 'Поиск по документам')
    var timer = null
    search.addEventListener('input', function () {
      clearTimeout(timer)
      // The search runs on the server (titles, tags and text), a moment after the last key.
      timer = setTimeout(function () {
        state.query = search.value.trim()
        fetchRows()
      }, 250)
    })
    bar.appendChild(seg)
    bar.appendChild(search)

    var body = el('div', 'dv__lib')
    root.textContent = ''
    root.appendChild(bar)
    root.appendChild(body)

    function shown() {
      return (state.rows || []).filter(function (row) {
        if (state.tab === 'mine') return row.mine
        if (state.tab === 'shared') return !row.mine
        return true
      })
    }

    function draw() {
      Array.prototype.forEach.call(seg.children, function (b) {
        b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
      })
      body.textContent = ''
      if (state.rows === null) {
        var wait = el('div', 'dv__grid')
        for (var i = 0; i < 6; i += 1) wait.appendChild(el('div', 'dv__card hl-skeleton'))
        body.appendChild(wait)
        return
      }
      var rows = shown()
      if (!rows.length) {
        body.appendChild(
          el('p', 'hl-empty', state.query || state.tab !== 'all' ? 'Ничего не нашлось.' : 'Документов пока нет — попросите агента в чате написать первый.'),
        )
        return
      }
      if (state.query || state.tab !== 'all') {
        body.appendChild(grid(rows))
        return
      }
      shelves(rows).forEach(function (shelf) {
        var section = el('section', 'dv__shelf')
        section.appendChild(el('h2', 'dv__shelf-title hl-h', shelf.title))
        section.appendChild(grid(shelf.rows))
        body.appendChild(section)
      })
    }

    var asked = 0
    function fetchRows() {
      var mine = (asked += 1)
      own('/app/docs?limit=' + LIMIT + '&q=' + encodeURIComponent(state.query))
        .then(function (found) {
          if (mine !== asked || current()) return
          if (found === null) return needSignIn()
          state.rows = found.items || []
          draw()
        })
        .catch(function (error) {
          if (mine === asked && !current()) failed(error)
        })
    }

    draw()
    root.removeAttribute('aria-busy')
    fetchRows()
  }

  // ---- Start: the catalog at once; harnessly, when it answers, gives the theme and the object to open ----

  window.addEventListener('popstate', route)
  route()

  connect()
    .then(function (hl) {
      function follow(mode) {
        if ((mode !== 'dark' && mode !== 'light') || mode === theme.mode) return
        theme.mode = mode
        // The content is asked again in the new theme.
        if (opened && opened.reload) opened.reload().catch(function () {})
      }
      follow(hl.context.theme && hl.context.theme.mode)
      hl.on('theme', function (next) {
        follow(next && next.mode ? next.mode : hl.context.theme.mode)
      })
      var data = hl.context.data
      if (data && typeof data.object === 'string' && !current()) go(data.object)
    })
    .catch(function () {
      // Opened outside harnessly, or harnessly did not answer: the site works by itself.
    })
})()
