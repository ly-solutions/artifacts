// The documents' app view in harnessly (`/app`, render/ui.mjs appViewPage). With no object it is the home: a field
// whose text goes to the agent in the chat beside, then the library «All · Mine · Shared» with shelves by tag and a
// search. With an object (`hl.context.data.object`, a document's slug) it is the document itself: its content in a
// frame, by a short ticket from doc_open. Data comes through the app's MCP tools (`hl.tools.call`); the machine adds
// the person's token.
;(function () {
  'use strict'

  var root = document.getElementById('app')
  var TABS = [
    { id: 'all', label: 'Все' },
    { id: 'mine', label: 'Мои' },
    { id: 'shared', label: 'Общие' },
  ]
  var STARTERS = [
    'Итоги недели по проекту',
    'Спека новой функции: цель, сценарии, «готово когда»',
    'Разбор инцидента: что случилось, причина, что меняем',
    'План выката по шагам с откатом',
  ]
  var SHELVES = 6
  var PER_SHELF = 8
  var LIMIT = 50

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

  function call(hl, tool, args) {
    return hl.tools.call('docs.' + tool, args || {}).then(function (res) {
      if (hl.refused(res) || !res || res.isError) throw new Error(textOf(res) || 'refused')
      return res.structuredContent || JSON.parse(textOf(res))
    })
  }

  function when(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  }

  function failed(text) {
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var box = el('div', 'dv__fail hl-empty')
    box.appendChild(el('p', 'hl-h', 'Сервис документов сейчас не отвечает'))
    box.appendChild(el('p', 'hl-muted', text || 'Документы и ссылки на них на месте — попробуйте позже.'))
    root.appendChild(box)
  }

  // ---- An open document: only its content ----

  function openDoc(hl, slug) {
    root.className = 'dv dv--doc'
    var frame = null
    function load(mode) {
      return call(hl, 'doc_open', { slug: slug, theme: mode }).then(function (doc) {
        if (!frame) {
          frame = el('iframe', 'dv__content')
          // The content is untrusted HTML: the server sandboxes it as well.
          frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads')
          root.textContent = ''
          root.removeAttribute('aria-busy')
          root.appendChild(frame)
        }
        frame.title = doc.title
        frame.src = doc.contentUrl
      })
    }
    load(hl.context.theme.mode).catch(function (error) {
      failed(String((error && error.message) || ''))
    })
    // The theme changes in harnessly: the content is asked again in the new one.
    hl.on('theme', function (theme) {
      var mode = theme && theme.mode ? theme.mode : hl.context.theme.mode
      load(mode).catch(function () {})
    })
  }

  // ---- Home ----

  function card(hl, row) {
    var item = el('button', 'dv__card')
    item.type = 'button'
    item.appendChild(el('span', 'dv__name', row.title))
    if (row.description) item.appendChild(el('span', 'dv__desc hl-muted', row.description))
    var meta = [when(row.updatedAt), row.mine ? 'мой' : row.author || ''].filter(Boolean).join(' · ')
    item.appendChild(el('span', 'dv__meta hl-muted', meta))
    item.addEventListener('click', function () {
      hl.pane.open('object:' + row.slug)
    })
    return item
  }

  function grid(hl, rows) {
    var box = el('div', 'dv__grid')
    rows.forEach(function (row) {
      box.appendChild(card(hl, row))
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

  function home(hl) {
    root.className = 'dv dv--home'
    var state = { tab: 'all', query: '', rows: null }

    var head = el('header', 'dv__head')
    head.appendChild(el('h1', 'dv__title', 'Что напишем?'))
    var form = el('form', 'dv__ask')
    var field = el('textarea', 'dv__field hl-input')
    field.rows = 2
    field.placeholder = 'Опишите документ — агент напишет его в чате рядом'
    field.setAttribute('aria-label', 'Что напишем')
    var go = el('button', 'hl-btn hl-btn--primary dv__go', 'Написать')
    go.type = 'submit'
    form.appendChild(field)
    form.appendChild(go)
    form.addEventListener('submit', function (event) {
      event.preventDefault()
      var text = field.value.trim()
      if (!text) return
      go.disabled = true
      hl.chat
        .send('Подготовь документ: ' + text)
        .then(function (answer) {
          if (hl.refused(answer)) throw new Error(answer.message)
          field.value = ''
        })
        .catch(function () {
          if (hl.ui && hl.ui.toast) hl.ui.toast('Не получилось отправить в чат', { tone: 'error' })
        })
        .then(function () {
          go.disabled = false
        })
    })
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        form.requestSubmit()
      }
    })
    head.appendChild(form)
    var starters = el('div', 'dv__starters')
    STARTERS.forEach(function (line) {
      var chip = el('button', 'hl-btn hl-btn--ghost hl-btn--sm', line)
      chip.type = 'button'
      chip.addEventListener('click', function () {
        field.value = line
        field.focus()
      })
      starters.appendChild(chip)
    })
    head.appendChild(starters)

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
    root.appendChild(head)
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
          el(
            'p',
            'hl-empty',
            state.query || state.tab !== 'all' ? 'Ничего не нашлось.' : 'Документов пока нет — опишите первый в поле выше.',
          ),
        )
        return
      }
      if (state.query || state.tab !== 'all') {
        body.appendChild(grid(hl, rows))
        return
      }
      shelves(rows).forEach(function (shelf) {
        var section = el('section', 'dv__shelf')
        section.appendChild(el('h2', 'dv__shelf-title hl-h', shelf.title))
        section.appendChild(grid(hl, shelf.rows))
        body.appendChild(section)
      })
    }

    var asked = 0
    function fetchRows() {
      var mine = (asked += 1)
      call(hl, 'doc_find', { query: state.query, limit: LIMIT })
        .then(function (found) {
          if (mine !== asked) return
          state.rows = found.items || []
          draw()
        })
        .catch(function (error) {
          if (mine === asked) failed(String((error && error.message) || ''))
        })
    }

    draw()
    root.removeAttribute('aria-busy')
    fetchRows()
  }

  window.harnessly
    .connect({ protocol: 2 })
    .then(function (hl) {
      var data = hl.context.data
      var object = data && typeof data.object === 'string' ? data.object : null
      if (object) openDoc(hl, object)
      else home(hl)
    })
    .catch(function () {
      failed('Этот вид открывается внутри harnessly.')
    })
})()
