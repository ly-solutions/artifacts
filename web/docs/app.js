/* The documents app (`/app`, HRN-1479): a site that reads its own catalog by the person's session cookie and opens a
 * document in the same frame. The harnessly bridge is optional and used for four things: the theme, the object harnessly
 * asks to open, the first sign-in (`doc_signin`, a one-time pass the page trades for the cookie), and the chat — a question
 * or an @agent mention goes to the conversation as the person's message; what is open and selected is told with `publish`
 * (HRN-1391). Nothing of the catalog waits for harnessly. */
;(function () {
  'use strict'
  var DX = window.DX
  var h = DX.h
  var root = document.getElementById('app')
  var BRIDGE_WAIT_MS = 6000
  var FIRST_WAIT_MS = 800
  var TABS = [['all', 'Все'], ['mine', 'Мои'], ['shared', 'Общие']]

  var theme = { mode: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = theme.mode

  // ---- The bridge ----

  var bridge = null
  function connect() {
    if (bridge) return bridge
    bridge = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no bridge')) }, BRIDGE_WAIT_MS)
      if (!window.harnessly || !window.harnessly.connect) return reject(new Error('no bridge'))
      window.harnessly.connect({ protocol: 2 }).then(function (hl) {
        clearTimeout(timer)
        resolve(hl)
      }, reject)
    })
    bridge.catch(function () {})
    return bridge
  }

  function textOf(res) {
    return ((res && res.content) || []).map(function (c) { return c.text || '' }).join('\n')
  }

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
    var clear = function () { entering = null }
    entering.then(clear, clear)
    return entering
  }

  /** Every server call signs in once when the server does not know the person yet ({__unauthorized} when that fails). */
  var rawFetch = DX.fetchJson
  function own(path, opts) {
    return rawFetch(path, opts).then(function (body) {
      if (!body.__unauthorized) return body
      return signIn().then(function () { return rawFetch(path, opts) }, function () { return { __unauthorized: true } })
    })
  }
  DX.fetchJson = own

  function tell(space) {
    connect().then(function (hl) { if (hl.publish) return hl.publish({ space: space }) }, function () {}).catch(function () {})
  }

  function chat(text) {
    return connect().then(function (hl) {
      if (!hl.chat || !hl.chat.send) throw new Error('no chat')
      return hl.chat.send(text)
    })
  }

  // ---- Screens ----

  var current = null // { destroy }
  // ---- harnessly's own actions (HRN-1498) ----
  // harnessly draws no bar above the app: share, the right pane and its menu come into our ⋯. None without harnessly or
  // on a harnessly that does not offer them; the ⋯ then is as it was.

  var HOST_ICON = { share: 'share', 'panel-right': 'layout-dashboard', info: 'info', settings: 'pencil', bug: 'code-xml', x: 'x', plus: 'plus' }
  function hostActions() {
    if (!window.harnessly) return Promise.resolve([])
    return connect()
      .then(function (hl) { return hl.host ? hl.host.actions() : null })
      .then(function (r) { return (r && Array.isArray(r.actions) && r.actions) || [] })
      .catch(function () { return [] })
  }
  function hostRun(id) {
    connect().then(function (hl) { if (hl.host && id) return hl.host.run(id) }).catch(function () {})
  }
  /** harnessly's actions as menu rows, before the app's own; `close` closes the menu first. */
  function hostRows(list, close) {
    if (!list.length) return null
    var box = h('div')
    list.forEach(function (a) {
      box.appendChild(DX.mi(HOST_ICON[a.icon] || 'ellipsis', a.label, function () { close(); hostRun(a.id) }, { danger: Boolean(a.danger), on: Boolean(a.pressed) }))
    })
    box.appendChild(h('div.msep'))
    return box
  }

  var shell = {
    theme: function () { return theme.mode },
    hostActions: hostActions,
    hostRows: hostRows,
    tell: tell,
    chat: chat,
    back: function () { go(null) },
    navigate: function (slug, v) { go(slug, v) },
    needSignIn: needSignIn,
    fail: function (title, text) { message(title, text, function () { go(null) }) },
    failed: failed,
  }

  function message(title, text, retry) {
    root.textContent = ''
    var box = h('div.dx-fail', h('b', title), text ? h('p', text) : null)
    if (retry) box.appendChild(h('button.btn.soft', { type: 'button', onClick: retry }, 'Повторить'))
    root.appendChild(box)
  }
  function failed(error) {
    message('Сервис документов сейчас не отвечает', 'Документы и ссылки на них на месте — попробуйте позже.', route)
    if (window.console) console.warn(error)
  }
  function needSignIn() {
    message('Не получилось войти в документы', 'Вход идёт через harnessly: откройте приложение ещё раз или повторите.', route)
  }

  function params() {
    var q = new URLSearchParams(location.search)
    var slug = q.get('doc')
    return { slug: slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null, v: /^\d+$/.test(q.get('v') || '') ? q.get('v') : null }
  }

  function go(slug, v) {
    var p = params()
    if (p.slug === slug && p.v === (v ? String(v) : null)) return
    var url = slug ? '?doc=' + encodeURIComponent(slug) + (v ? '&v=' + v : '') : location.pathname
    history.pushState(null, '', url)
    route()
  }

  function route() {
    if (current) {
      current.destroy()
      current = null
    }
    DX.closePopovers()
    var p = params()
    if (!p.slug) tell(null)
    if (p.slug) {
      root.textContent = ''
      current = DX.openDoc(root, p.slug, shell, p.v)
    } else current = home()
  }

  // ---- The list ----

  var view = { tab: 'all', query: '', rows: null, canCreate: false, hub: false, next: null }

  function home() {
    var state = view
    var dead = false
    var asked = 0
    root.textContent = ''
    var lst = h('div.lst')
    var search = h('input', { type: 'search', placeholder: 'Найти по тексту', 'aria-label': 'Найти по тексту', value: state.query })
    var newBtn = h('button.btn.pri', { type: 'button', onClick: function () { newMenu(newBtn) } }, DX.icon('plus'), h('span', 'Новый документ'))
    var moreBtn = DX.ib('ellipsis', 'Ещё', function () { listMenu(moreBtn) }, { tp: 'dl' })
    moreBtn.hidden = true
    var head = h('div.lhd', h('h1', 'Документы'), h('label.srch', DX.icon('search'), search, h('kbd', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K')), moreBtn, newBtn)
    function listMenu(anchor) {
      hostActions().then(function (list) {
        DX.popover(anchor, function (close) {
          return h('div', hostRows(list, close), state.hub ? DX.mi('trash-2', 'Корзина', function () { close(); trashMenu(anchor, fetchRows) }) : null)
        }, { align: 'end' })
      })
    }
    hostActions().then(function (list) { if (list.length) moreBtn.hidden = false })
    var seg = h('div.seg.sm', { role: 'tablist' })
    TABS.forEach(function (t) {
      seg.appendChild(h('button', { type: 'button', role: 'tab', 'data-tab': t[0], onClick: function () { state.tab = t[0]; draw() } }, t[1]))
    })
    var sub = h('div.lsub', seg)
    var scroll = h('div.lscroll')
    lst.appendChild(head)
    lst.appendChild(sub)
    lst.appendChild(scroll)
    root.appendChild(lst)

    var timer = 0
    search.addEventListener('input', function () {
      clearTimeout(timer)
      timer = setTimeout(function () {
        state.query = search.value.trim()
        fetchRows()
      }, 250)
    })
    document.addEventListener('keydown', onKey)
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.focus()
      }
    }

    function shown() {
      return (state.rows || []).filter(function (r) {
        if (state.tab === 'mine') return r.mine
        if (state.tab === 'shared') return !r.mine
        return true
      })
    }

    function draw() {
      Array.prototype.forEach.call(seg.children, function (b) { b.dataset.on = String(b.dataset.tab === state.tab) })
      newBtn.hidden = false
      scroll.textContent = ''
      if (state.rows === null) {
        for (var i = 0; i < 5; i += 1) scroll.appendChild(h('div.skel'))
        return
      }
      var rows = shown()
      if (!rows.length) {
        scroll.appendChild(h('div.empty', h('b', state.query || state.tab !== 'all' ? 'Ничего не нашлось' : 'Документов пока нет'), state.query || state.tab !== 'all' ? 'Попробуйте другие слова или вкладку.' : 'Создайте первый или попросите агента в чате написать его.'))
        return
      }
      var groups = {}
      var order = []
      rows.forEach(function (r) {
        var g = state.query ? 'Найдено' : DX.group(r.updatedAt)
        if (!groups[g]) {
          groups[g] = []
          order.push(g)
        }
        groups[g].push(r)
      })
      order.forEach(function (g) {
        scroll.appendChild(h('div.lbl', g))
        groups[g].forEach(function (r) { scroll.appendChild(row(r, redrawRows)) })
      })
      if (state.next !== null) scroll.appendChild(h('div', { style: 'text-align:center;padding:16px' }, h('button.btn.soft', { type: 'button', onClick: more }, 'Показать ещё')))
    }
    function redrawRows() { draw() }

    function more() {
      own('/app/docs?limit=50&offset=' + state.next + '&q=' + encodeURIComponent(state.query)).then(function (found) {
        if (dead || found.__unauthorized) return
        state.rows = state.rows.concat(found.items || [])
        state.next = found.nextOffset
        draw()
      })
    }

    function fetchRows() {
      var mine = (asked += 1)
      own('/app/docs?limit=50&q=' + encodeURIComponent(state.query)).then(
        function (found) {
          if (dead || mine !== asked) return
          if (found.__unauthorized) return needSignIn()
          state.rows = found.items || []
          state.canCreate = !!found.canCreate
          state.hub = !!found.hub
          if (state.hub) moreBtn.hidden = false
          state.next = found.nextOffset
          draw()
        },
        function (error) { if (!dead && mine === asked) failed(error) },
      )
    }

    function newMenu(anchor) {
      DX.popover(anchor, function (close) {
        var box = h('div')
        if (state.canCreate) {
          box.appendChild(h('button.mi.tall', { type: 'button', onClick: function () { close(); create(null) } }, DX.icon('file-text'), h('span.tx', h('span', 'Пустой'), h('em', 'чистая страница'))))
          box.appendChild(h('button.mi.tall', { type: 'button', onClick: function () { close(); templates(anchor) } }, DX.icon('file-plus'), h('span.tx', h('span', 'Из шаблона'), h('em', 'встреча, план, разбор'))))
        }
        box.appendChild(h('button.mi.tall', { type: 'button', onClick: function () { close(); askAgentNew() } }, DX.icon('sparkles'), h('span.tx', h('span', 'Попросить агента'), h('em', 'опишите, что нужно написать'))))
        return box
      }, { align: 'end' })
    }

    var TEMPLATES = [
      { id: 'meeting', title: 'Заметки встречи', icon: 'users', body: '# Заметки встречи\n\n**Когда:** \n**Кто:** \n\n## Повестка\n\n- \n\n## Решения\n\n- \n\n## Что делаем дальше\n\n| Что | Кто | Когда |\n| --- | --- | --- |\n|  |  |  |\n' },
      { id: 'plan', title: 'План работ', icon: 'list-ordered', body: '# План работ\n\n> [!NOTE] Цель одним предложением.\n\n## Шаги\n\n1. \n2. \n3. \n\n## Риски\n\n- \n' },
      { id: 'review', title: 'Разбор', icon: 'file-pen', body: '# Разбор\n\n## Что случилось\n\n## Почему\n\n## Что сделаем\n\n- \n' },
    ]
    function templates(anchor) {
      DX.popover(anchor, function (close) {
        var box = h('div', h('div.mlab', 'Шаблоны'))
        TEMPLATES.forEach(function (t) {
          box.appendChild(DX.mi(t.icon, t.title, function () { close(); create(t) }))
        })
        return box
      }, { align: 'end' })
    }

    function create(t, spaceId) {
      var body = state.hub
        ? (t ? { template: t.id } : { title: 'Новый документ' })
        : (t ? { title: t.title, markdown: t.body } : { title: 'Новый документ' })
      var chosen = spaceId || DX.pref.get('space', '')
      if (state.hub && chosen) body.spaceId = chosen
      DX.fetchJson('/app/docs', { method: 'POST', body: body }).then(function (res) {
        if (res.__unauthorized) return needSignIn()
        go(res.slug)
      }, function (e) {
        var spaces = e.code === 'space_required' ? spacesOf(e.message) : []
        if (spaces.length) return chooseSpace(newBtn, spaces, function (id) { DX.pref.set('space', id); create(t, id) })
        DX.toast(e.message)
      })
    }

    function askAgentNew() {
      chat('Напиши новый документ: ').then(function () { DX.toast('Опишите в чате harnessly, что написать') }, function () { DX.toast('Агент доступен в harnessly: откройте документы внутри него') })
    }

    draw()
    fetchRows()
    return { destroy: function () { dead = true; document.removeEventListener('keydown', onKey); clearTimeout(timer) } }
  }

  /** One document in the list. */
  function row(r, redraw) {
    var el = h('div.drow', { tabindex: '0', role: 'link', 'data-slug': r.slug })
    var thumb = h('div.ic-doc' + (r.kind === 'html' ? '.html' : ''))
    if (r.kind === 'html') thumb.appendChild(h('i', { style: 'top:9px;height:5px;width:22px;right:auto' }))
    ;[[r.kind === 'html' ? 22 : 12, 4], [r.kind === 'html' ? 30 : 18, 4], [r.kind === 'html' ? 36 : 24, 4], [r.kind === 'html' ? 42 : 30, 4]].forEach(function (p) { thumb.appendChild(h('i', { style: 'top:' + p[0] + 'px;' + (p[0] % 2 ? 'right:14px' : '') })) })
    if (r.kind === 'html') thumb.appendChild(h('i.b', { style: 'top:44px;left:7px' }))
    var title = h('b', r.title)
    var tx = h('div.tx', title, h('p', r.preview || 'Пустой документ'))
    var tagLabel = r.board ? 'Из доски' : r.kind === 'html' ? 'HTML' : 'Текст'
    var tag = h('span.tag', DX.icon(r.board ? 'layout-dashboard' : r.kind === 'html' ? 'code-xml' : 'file-text'), tagLabel)
    var wh = h('div.wh', h('span', DX.when(r.updatedAt)), r.updatedBy ? r.updatedBy : r.author || '')
    var ac = h('div.ac')
    ac.appendChild(DX.ib('eye', 'Открыть', function (e) { e.stopPropagation(); go(r.slug) }, { tp: 'd' }))
    if (r.canWrite !== false) ac.appendChild(DX.ib('pencil', 'Править', function (e) { e.stopPropagation(); open(r.slug, true) }, { tp: 'd' }))
    var more = DX.ib('ellipsis', 'Ещё', function (e) { e.stopPropagation(); rowMenu(r, more, title, redraw, el) }, { tp: 'dl' })
    ac.appendChild(more)
    el.appendChild(thumb)
    el.appendChild(tx)
    el.appendChild(tag)
    var who = r.people && r.people.length ? r.people : r.author ? [r.author] : []
    if (who.length) {
      var avs = h('div.avs')
      who.forEach(function (n) { avs.appendChild(DX.avatar(n, /^(агент|agent)$/i.test(n) ? 'agent' : 'person', 20)) })
      el.appendChild(avs)
    }
    el.appendChild(wh)
    el.appendChild(ac)
    el.addEventListener('click', function (e) {
      if (e.target.closest('.ac, .rn')) return
      go(r.slug)
    })
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target === el) go(r.slug)
    })
    return el
  }

  var editNext = false
  shell.wantEdit = function () {
    var w = editNext
    editNext = false
    return w
  }
  function open(slug, edit) {
    editNext = !!edit
    go(slug)
  }

  function rowMenu(r, anchor, titleEl, redraw, rowEl) {
    rowEl.dataset.hv = 'true'
    DX.popover(anchor, function (close) {
      var box = h('div')
      if (r.canWrite !== false) {
        box.appendChild(DX.mi('pencil', 'Переименовать', function () { close(); rename(r, titleEl, redraw) }))
      }
      box.appendChild(DX.mi('link', 'Копировать ссылку', function () {
        close()
        var url = r.url || location.origin + '/a/' + r.slug
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { DX.toast('Ссылка скопирована') })
      }))
      if (view.canCreate && (view.hub || r.canWrite !== false)) {
        box.appendChild(DX.mi('copy', 'Сделать копию', function () {
          close()
          duplicate(r)
        }))
      }
      box.appendChild(DX.mi('file-down', 'Скачать', function () { close(); download(r) }))
      if (view.hub || (view.canCreate && r.canWrite !== false)) {
        box.appendChild(h('div.msep'))
        box.appendChild(DX.mi('trash-2', view.hub ? 'В корзину' : 'Удалить', function () { close(); remove(r, redraw) }, { danger: true }))
      }
      return box
    }, { align: 'end', onClose: function () { delete rowEl.dataset.hv } })
  }

  function rename(r, titleEl, redraw) {
    var input = h('input.rn', { value: r.title, 'aria-label': 'Название' })
    titleEl.replaceWith(input)
    input.focus()
    input.select()
    var done = false
    function finish(save) {
      if (done) return
      done = true
      var next = input.value.trim()
      if (!save || !next || next === r.title) return redraw()
      DX.fetchJson('/app/doc', { method: 'PATCH', body: { slug: r.slug, title: next } }).then(function (res) {
        r.title = res.title
        redraw()
      }, function (e) { DX.toast(e.message); redraw() })
    }
    input.addEventListener('click', function (e) { e.stopPropagation() })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', function () { finish(true) })
  }

  function duplicate(r) {
    DX.fetchJson('/app/doc/duplicate', { method: 'POST', body: { slug: r.slug, spaceId: view.hub ? DX.pref.get('space', '') || undefined : undefined } }).then(function (res) {
      if (res.__unauthorized) return needSignIn()
      go(res.slug)
    }, function (e) {
      var spaces = e.code === 'space_required' ? spacesOf(e.message) : []
      if (spaces.length) {
        return chooseSpace({ x: window.innerWidth / 2 - 130, y: window.innerHeight / 3, w: 260, h: 10 }, spaces, function (id) {
          DX.pref.set('space', id)
          duplicate(r)
        })
      }
      DX.toast(e.message)
    })
  }

  /** «id (Название), id2 (Название 2)» in the hub's words → [{id, name}]. */
  function spacesOf(text) {
    var out = []
    var re = /([\w-]+) \(([^)]*)\)/g
    var m
    var tail = String(text).split('—').pop()
    while ((m = re.exec(tail))) out.push({ id: m[1], name: m[2] })
    return out
  }

  function chooseSpace(anchor, spaces, pick) {
    DX.popover(anchor, function (close) {
      var box = h('div', h('div.mlab', 'В каком пространстве?'))
      spaces.forEach(function (sp) { box.appendChild(DX.mi('folder', sp.name, function () { close(); pick(sp.id) })) })
      return box
    }, { align: 'end' })
  }

  function download(r) {
    DX.fetchJson('/app/doc?slug=' + encodeURIComponent(r.slug)).then(function (d) {
      var text = d.kind === 'text' ? d.markdown : d.html
      if (text === undefined) return DX.toast('Скачать страницу можно из самого документа: ⋯ → Экспорт')
      var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      var a = h('a', { href: url, download: d.title.replace(/[\\/:*?"<>|]+/g, '-') + (d.kind === 'text' ? '.md' : '.html') })
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
    })
  }

  function remove(r, redraw) {
    if (view.hub) return toTrash(r, redraw)
    DX.popover({ x: window.innerWidth / 2 - 130, y: window.innerHeight / 3, w: 260, h: 10 }, function (close) {
      return h('div', { style: 'padding:8px;min-width:260px' }, h('div', { style: 'padding:4px 6px 10px' }, 'Удалить «' + r.title + '»? Это нельзя отменить.'), h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
        h('button.btn.sm.ghost', { type: 'button', onClick: close }, 'Отмена'),
        h('button.btn.sm', { type: 'button', style: 'background:var(--dx-danger);color:#fff', onClick: function () {
          DX.fetchJson('/app/doc?slug=' + encodeURIComponent(r.slug), { method: 'DELETE' }).then(function () {
            close()
            view.rows = view.rows.filter(function (x) { return x.slug !== r.slug })
            redraw()
            DX.toast('Документ удалён')
          }, function (e) { DX.toast(e.message) })
        } }, 'Удалить')))
    }, { keep: function () { return false } })
  }

  /** Into the hub's trash: no question asked, «Отменить» in the toast brings it back. */
  function toTrash(r, redraw) {
    DX.fetchJson('/app/doc?slug=' + encodeURIComponent(r.slug), { method: 'DELETE' }).then(function (res) {
      if (res.__unauthorized) return needSignIn()
      var at = view.rows.findIndex(function (x) { return x.slug === r.slug })
      view.rows = view.rows.filter(function (x) { return x.slug !== r.slug })
      redraw()
      DX.toast('«' + r.title + '» в корзине', { label: 'Отменить', run: function () { fromTrash(r.slug, at, r, redraw) } })
    }, function (e) { DX.toast(e.message) })
  }

  function fromTrash(slug, at, row, redraw) {
    return DX.fetchJson('/app/trash/restore', { method: 'POST', body: { slug: slug } }).then(function () {
      if (row && view.rows && !view.rows.some(function (x) { return x.slug === slug })) view.rows.splice(at < 0 ? 0 : at, 0, row)
      if (redraw) redraw()
    }, function (e) { DX.toast(e.message) })
  }

  /** The trash, quietly: what the person may take out again. */
  function trashMenu(anchor, refetch) {
    DX.popover(anchor, function () {
      var box = h('div.trash', h('div.mlab', 'Корзина'))
      var list = h('div.tl', h('div.hint', 'Загружаю…'))
      box.appendChild(list)
      DX.fetchJson('/app/trash').then(function (res) {
        list.textContent = ''
        var docs = (res && res.docs) || []
        if (!docs.length) return list.appendChild(h('div.hint', 'В корзине пусто'))
        docs.forEach(function (d) {
          var line = h('div.tr', h('span.tn', d.title || d.slug), h('em', (d.trashedBy ? d.trashedBy + ' · ' : '') + (d.trashedAt ? DX.when(d.trashedAt) : '')))
          line.appendChild(h('button.btn.sm.ghost', { type: 'button', onClick: function () {
            fromTrash(d.slug, -1, null, null).then(function () { line.remove(); if (refetch) refetch(); DX.toast('«' + (d.title || d.slug) + '» возвращён') })
          } }, 'Вернуть'))
          list.appendChild(line)
        })
      }, function (e) {
        list.textContent = ''
        list.appendChild(h('div.hint', e.message))
      })
      return box
    }, { align: 'end', cls: 'trashpop' })
  }

  // ---- Start ----

  window.addEventListener('popstate', route)
  var started = false
  function start(object) {
    if (started) return
    started = true
    if (object && !params().slug) history.replaceState(null, '', '?doc=' + encodeURIComponent(object))
    route()
  }
  if (params().slug || !window.harnessly) start(null)
  else setTimeout(function () { start(null) }, FIRST_WAIT_MS)

  connect().then(
    function (hl) {
      function follow(mode) {
        if ((mode !== 'dark' && mode !== 'light') || mode === theme.mode) return
        theme.mode = mode
        document.documentElement.dataset.theme = mode
      }
      follow(hl.context.theme && hl.context.theme.mode)
      hl.on('theme', function (next) { follow(next && next.mode ? next.mode : hl.context.theme.mode) })
      // What harnessly asks to open. harnessly keeps one window of the app alive while the person goes between boards,
      // documents and their lists (HRN-1469): a later ask comes as a `context` event. Only a new ask moves the view: the
      // same context again (the theme changed) leaves the document the person opened.
      var asked = null
      function ask(data) {
        var object = data && typeof data.object === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(data.object) ? data.object : null
        var key = object || ''
        if (key === asked) return
        var first = asked === null
        asked = key
        if (!started) return start(object)
        // The first ask does not take the person away from a document they opened before harnessly answered.
        if (object && !(first && params().slug)) go(object)
        else if (!object && !first && params().slug) go(null)
      }
      // A fast voice edit saved by harnessly (HRN-1466): the open document takes the new version and lights the place.
      hl.on('event', function (e) {
        if (!e || e.kind !== 'quick-edit' || e.object !== params().slug || !current || !current.quickEdit) return
        current.quickEdit(e.hint)
      })
      ask(hl.context.data)
      hl.on('context', function (ctx) { ask(ctx && ctx.data) })
    },
    function () { start(null) },
  )
})()
