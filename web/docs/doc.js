/* An open document: the islands over it (back, title, «Просмотр · Правка», saved, people, comments, chat, ⋯), the text or HTML
 * editor inside, the right island with the threads, saving, and keeping up with what an agent or another person changes. */
;(function () {
  'use strict'
  var DX = window.DX
  var h = DX.h

  var POLL_MS = 3000
  var SAVE_MS = 1200
  var AGENT_WAIT_MS = 180000

  /** Opens `slug` in `root`. `shell` gives the app's links: back(), bridge, navigate(slug). Returns {destroy()}. */
  DX.openDoc = function (root, slug, shell, version) {
    var ctx = { data: null }
    var doc, ctrl, panel, titleEl, savedEl, toolsEl, rightEl, modeSeg
    var threads = []
    var rev = -1
    var seenVersion = 0
    var mode = 'view'
    var active = null
    var asked = []
    var chipText = ''
    var pending = {}
    var timers = { poll: 0, save: 0 }
    var dead = false
    var saving = null
    var conflict = false
    var bannerEl = null
    var turn = null // the agent's turn on this screen: {base, baseContent, to, at, targets, places, closed}
    var lastContent = ''
    var agentBar = null
    var turnCache = {}
    var pref = { w: DX.pref.get('width', 'normal'), f: DX.pref.get('font', 'sans') }

    // ---- Loading ----

    function load() {
      var q = '/app/doc?slug=' + encodeURIComponent(slug) + '&theme=' + shell.theme()
      if (version) q += '&v=' + encodeURIComponent(version)
      return DX.fetchJson(q).then(function (data) {
        if (data.__unauthorized) return shell.needSignIn()
        return data
      })
    }

    function start() {
      return Promise.all([load(), DX.fetchJson('/app/comments?slug=' + encodeURIComponent(slug))]).then(function (res) {
        if (dead) return
        var data = res[0]
        if (!data) return
        ctx.data = data
        threads = (res[1] && res[1].threads) || []
        rev = (res[1] && res[1].rev) || 0
        seenVersion = data.version.n
        lastContent = contentOf(data)
        build()
        resumeTurn()
        if (shell.wantEdit && shell.wantEdit() && ctx.canWrite()) setMode('edit')
        if (data.kind === 'html') window.addEventListener('message', onFrameMessage)
        schedulePoll()
        shell.tell({ kind: 'document', title: data.title, url: data.url || '', object: slug, selection: '', rect: null })
      })
    }

    // ---- The context the editors work with ----

    ctx.threads = function () { return threads }
    ctx.me = function () { return ctx.data.me.name }
    ctx.canWrite = function () { return !!(ctx.data && ctx.data.rights.write) }
    ctx.canComment = function () { return !!(ctx.data && ctx.data.rights.comment) }
    ctx.activeThread = function () { return active }
    ctx.pendingAgent = function (id) { return !!pending[id] }
    ctx.asked = function () { return asked }
    /** The agent was asked a moment ago and has not changed anything since: «печатает» in the chat. */
    ctx.chatBusy = function () {
      var a = asked[asked.length - 1]
      if (!a) return false
      var at = Date.parse(a.at)
      if (Date.now() - at > 90000) return false
      return !ctx.turns().some(function (t) { return t.last > at })
    }
    ctx.chip = function () { return chipText }
    ctx.dropChip = function () { chipText = ''; if (ctrl) ctrl.clearSelection() }
    ctx.layout = function () {
      drawRight()
      if (ctrl && ctrl.resized) setTimeout(ctrl.resized, 320)
    }
    ctx.toolsChanged = function () { drawTools() }

    ctx.selectionChanged = function (info) {
      chipText = info.text
      var r = info.rect
      shell.tell({ kind: 'document', title: ctx.data.title, url: ctx.data.url || '', object: slug, selection: info.text, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })
    }

    ctx.copyLink = function (quote) {
      var url = ctx.data.url + (quote ? '#:~:text=' + encodeURIComponent(quote.slice(0, 80)) : '')
      copy(url).then(function () { DX.toast('Ссылка скопирована') }, function () { DX.toast(url) })
    }

    function copy(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
      return new Promise(function (resolve, reject) {
        var ta = h('textarea', { style: 'position:fixed;opacity:0' })
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        var ok = document.execCommand('copy')
        ta.remove()
        if (ok) resolve()
        else reject(new Error('copy'))
      })
    }

    // ---- The chat of harnessly: a question, a mention ----

    function docLine() {
      return '«' + ctx.data.title + '» (slug: ' + slug + ')'
    }

    ctx.ask = function (text) {
      chipText = String(text || '').slice(0, 600)
      if (!panel.isOpen() || panel.tab() !== 'chat') panel.open('chat')
      else panel.render()
      setTimeout(function () { panel.focusChat() }, 60)
    }

    ctx.ask2 = function (question) {
      var sel = chipText
      var text = 'В документе ' + docLine() + (sel ? ' выделен фрагмент: «' + sel + '».' : '.') + ' ' + question + '\nПравь через doc_edit (новая версия того же документа), отвечай по-русски коротко.'
      return shell.chat(text).then(function () {
        asked.push({ text: (sel ? '«' + sel.slice(0, 80) + (sel.length > 80 ? '…' : '') + '» ' : '') + question, at: new Date().toISOString() })
        chipText = ''
        if (ctrl) ctrl.clearSelection()
        panel.render()
        setTimeout(function () { if (!dead && panel.isOpen()) panel.render() }, 91000)
      })
    }

    function wakeAgent(thread, text) {
      var quote = thread.anchor.kind === 'text' ? thread.anchor.quote : thread.anchor.kind === 'element' ? thread.anchor.label + (thread.anchor.text ? ' «' + thread.anchor.text + '»' : '') : ''
      var msg = 'В документе ' + docLine() + ' ' + ctx.me() + ' зовёт агента в треде ' + thread.id + (quote ? ' (фрагмент «' + quote.slice(0, 300) + '»)' : '') + ': «' + text.slice(0, 1200) + '».\n' +
        'Прочитай тред (doc_comments: slug, thread) и документ (doc_show), ответь в треде (doc_reply). Если просят поправить текст — doc_edit с thread и reply: это новая версия документа, человек увидит подсветку и сможет отменить. Отвечай по-русски, коротко.'
      pending[thread.id] = { since: Date.now() }
      panel.render()
      shell.chat(msg).then(
        function () {},
        function () {
          delete pending[thread.id]
          panel.render()
          DX.toast('Агент недоступен: откройте документ внутри harnessly, чтобы его позвать')
        },
      )
    }

    // ---- Threads ----

    function setThreads(next, nextRev) {
      threads = next
      rev = nextRev
      Object.keys(pending).forEach(function (id) {
        var t = threads.filter(function (x) { return x.id === id })[0]
        if (!t) return delete pending[id]
        var last = t.messages[t.messages.length - 1]
        if (last && last.author.kind === 'agent' && new Date(last.at).getTime() >= pending[id].since - 2000) delete pending[id]
        else if (Date.now() - pending[id].since > AGENT_WAIT_MS) {
          delete pending[id]
          DX.toast('Агент пока не ответил в треде')
        }
      })
      if (ctrl) ctrl.renderThreads()
      if (panel) panel.render()
      drawRight()
    }

    function fromServer(res) {
      return DX.fetchJson('/app/comments?slug=' + encodeURIComponent(slug)).then(function (all) {
        if (all.threads) setThreads(all.threads, all.rev)
        return res
      })
    }

    function post(path, body) {
      body.slug = slug
      return DX.fetchJson(path, { method: 'POST', body: body }).then(function (res) {
        if (res.__unauthorized) {
          shell.needSignIn()
          throw new Error('Войдите заново')
        }
        return res
      })
    }

    ctx.openComposer = function (anchor, rect) {
      if (!ctx.canComment()) return DX.toast('Комментировать этот документ нельзя')
      var chip = anchor.kind === 'text' && anchor.quote ? h('div.selchip', DX.icon('text-quote'), h('span', anchor.quote)) : anchor.kind === 'element' ? h('div.selchip', DX.icon('square-mouse-pointer'), h('span', anchor.label)) : null
      DX.popover(
        rect,
        function (close) {
          var comp = DX.composer({ placeholder: 'Комментарий… «@агент» — позвать агента', label: 'Комментировать', chip: chip, people: function () { return panel.people() }, onCancel: close, onSend: function (text) {
            return post('/app/comments', { anchor: anchor, text: text }).then(function (res) {
              close()
              active = res.thread.id
              threads = threads.concat([res.thread])
              rev = res.rev
              if (ctrl) ctrl.renderThreads()
              panel.open('comments')
              drawRight()
              if (res.agent) wakeAgent(res.thread, text)
            })
          } })
          setTimeout(function () { comp.focusField() }, 40)
          var box = h('div.cmp', comp)
          return box
        },
        { side: rect.y > 220 ? 'below' : 'below', align: 'start', cls: 'cmp-pop' },
      )
    }

    ctx.openThread = function (id) {
      active = id
      var t = threads.filter(function (x) { return x.id === id })[0]
      if (!t) return
      if (t.status === 'resolved') {
        // A solved thread is in the «Решённые» list.
      }
      panel.open('comments')
      if (ctrl) ctrl.reveal(t)
      var card = root.querySelector('.thread[data-id="' + id + '"]')
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }

    ctx.reply = function (id, text) {
      return post('/app/comments/reply', { thread: id, text: text }).then(function (res) {
        threads = threads.map(function (t) { return t.id === id ? res.thread : t })
        rev = res.rev
        if (res.agent) wakeAgent(res.thread, text)
        panel.render()
      })
    }
    ctx.setStatus = function (id, st) {
      post('/app/comments/status', { thread: id, status: st }).then(function (res) {
        threads = threads.map(function (t) { return t.id === id ? res.thread : t })
        rev = res.rev
        if (ctrl) ctrl.renderThreads()
        panel.render()
        drawRight()
        DX.toast(st === 'resolved' ? 'Комментарий решён' : 'Комментарий снова открыт', st === 'resolved' ? { label: 'Вернуть', run: function () { ctx.setStatus(id, 'open') } } : null)
      }, function (e) { DX.toast(e.message) })
    }
    ctx.react = function (id, message, emoji) {
      post('/app/comments/react', { thread: id, message: message, emoji: emoji }).then(function () { return fromServer() }, function (e) { DX.toast(e.message) })
    }
    ctx.removeThread = function (t) {
      post('/app/comments/delete', { thread: t.id }).then(function (res) {
        threads = threads.filter(function (x) { return x.id !== t.id })
        rev = res.rev
        panel.forget(t.id)
        if (ctrl) ctrl.renderThreads()
        panel.render()
        drawRight()
      }, function (e) { DX.toast(e.message) })
    }
    ctx.showEdit = function (edit) {
      if (ctrl && ctrl.revealText && ctrl.revealText(edit.after)) return
      DX.toast('Это место теперь выглядит иначе — откройте историю версий')
    }
    ctx.undoEdit = function (t, edit) {
      post('/app/comments/undo', { thread: t.id, edit: edit.id }).then(function (res) {
        seenVersion = res.version
        return refreshDoc(true).then(function () { return fromServer() }).then(function () { DX.toast('Правка агента отменена') })
      }, function (e) { DX.toast(e.message) })
    }

    // ---- The agent's turn: what it changed is lit, one bar says so, one «Отменить» takes the whole turn back ----

    var TURN_GAP = 3 * 60 * 1000
    var FRESH_TURN = 5 * 60 * 1000
    var isAgentVersion = function (v) { return /^(агент|agent)$/i.test(String(v.author || '').trim()) }
    var contentOf = function (data) { return data.kind === 'text' ? data.markdown || '' : data.html || '' }

    /** The turns the history shows: runs of versions the agent made close in time, the person's own versions between. */
    function turnsOf(versions) {
      var out = []
      var cur = null
      versions.slice().sort(function (a, b) { return a.n - b.n }).forEach(function (v) {
        if (!isAgentVersion(v)) {
          cur = null
          return
        }
        var at = Date.parse(v.createdAt) || 0
        if (cur && at - cur.last <= TURN_GAP) {
          cur.to = v.n
          cur.last = at
          if (v.note && !/^Правка агента$/.test(v.note)) cur.notes.push(v.note)
        } else {
          cur = { base: v.n - 1, from: v.n, to: v.n, at: at, last: at, notes: v.note && !/^Правка агента$/.test(v.note) ? [v.note] : [] }
          out.push(cur)
        }
      })
      var all = versions
      out.forEach(function (t) {
        t.undone = all.some(function (v) { return v.n > t.to && v.note === 'Возврат к версии ' + t.base })
        t.latest = t.to === ctx.data.version.of
        t.places = turnCache[t.base + ':' + t.to] || null
      })
      return out
    }
    ctx.turns = function () { return turnsOf(ctx.data.versions || []) }
    ctx.currentTurn = function () { return turn }

    function plural(n, one, few, many) {
      var m = n % 100
      var d = n % 10
      return m > 10 && m < 15 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many
    }
    ctx.placesLabel = function (n) {
      return n > 0 ? 'Изменил ' + n + ' ' + plural(n, 'раздел', 'раздела', 'разделов') : 'Изменил документ'
    }

    /** Lights what differs from `baseContent` and says how many places that is (0 when it can not be told). */
    function lightChanges(baseContent) {
      if (!ctrl || !ctrl.changedSince || !ctx.canWrite() || ctx.data.kind !== 'text' && !ctx.data.html) return { targets: [], places: 0 }
      var targets = ctrl.changedSince(baseContent)
      ctrl.setMarks(targets)
      return { targets: targets, places: ctrl.placesOf(targets) }
    }

    function startTurn(base, baseContent, to) {
      var lit = lightChanges(baseContent)
      turn = { base: base, baseContent: baseContent, to: to, at: Date.now(), targets: lit.targets, places: lit.places, closed: false, at0: 0, shown: -1 }
      drawAgentBar()
    }

    /** The person has the turn in hand (typed, closed the bar, undid it): the marks go away. */
    function endTurn() {
      if (!turn) return
      turn = null
      if (ctrl && ctrl.setMarks) ctrl.setMarks(null)
      drawAgentBar()
    }

    function drawAgentBar() {
      var want = turn && !turn.closed ? turn : null
      if (agentBar && (!want || agentBar.dataset.base !== String(want.base))) {
        var gone = agentBar
        agentBar = null
        gone.dataset.ph = 'closing'
        setTimeout(function () { gone.remove() }, 200)
      }
      if (!want || !doc) return
      var label = ctx.placesLabel(want.places)
      if (agentBar) {
        agentBar.querySelector('.msg-t').textContent = 'Агент ' + label.toLowerCase()
        return
      }
      agentBar = h('div.agentbar', { role: 'status', 'data-base': String(want.base) },
        h('span.orb'),
        h('span.msg-t', 'Агент ' + label.toLowerCase()),
        want.targets.length ? h('button.btn.sm.soft', { type: 'button', onClick: function () { ctx.showTurnPlace(want) } }, DX.icon('locate'), h('span', 'Показать')) : null,
        ctx.canWrite() ? h('button.btn.sm.ghost', { type: 'button', onClick: function () { undoTurn(want.base) } }, DX.icon('rotate-ccw'), h('span', 'Отменить')) : null,
        DX.ib('x', 'Закрыть', function () { want.closed = true; if (ctrl.setMarks) ctrl.setMarks(null); drawAgentBar() }, { tp: 'd' }))
      doc.appendChild(agentBar)
    }

    /** «Показать»: the next changed place, scrolled to and flashed. */
    ctx.showTurnPlace = function (t) {
      var list = t.targets || []
      if (!list.length) return
      t.shown = (t.shown + 1) % list.length
      // Neighbouring blocks are one place: step over the ones next to the one just shown.
      ctrl.flashTarget(list[t.shown])
    }

    /** A turn of the history, from the chat: shows where it changed (lighting it only for a moment when it is not the live one). */
    ctx.showTurn = function (t) {
      if (turn && turn.base === t.base && !turn.closed) return ctx.showTurnPlace(turn)
      fetchContent(t.base).then(function (base) {
        if (dead || base === null) return
        var targets = ctrl.changedSince ? ctrl.changedSince(base) : []
        if (!targets.length) return DX.toast('Это место теперь выглядит иначе — откройте историю версий')
        ctrl.flashTarget(targets[0])
      })
    }
    ctx.undoTurn = function (t) { undoTurn(t.base) }
    /** How many places the latest turn changed: asked of the server once (the page may open after the agent did it). */
    ctx.turnPlaces = function (t) {
      var key = t.base + ':' + t.to
      if (turnCache[key] !== undefined) return Promise.resolve(turnCache[key])
      if (!t.latest || !ctrl.changedSince || !ctx.canWrite()) return Promise.resolve(null)
      return fetchContent(t.base).then(function (base) {
        if (base === null) return null
        var n = ctrl.placesOf(ctrl.changedSince(base))
        turnCache[key] = n
        return n
      })
    }

    function fetchContent(n) {
      if (n < 1) return Promise.resolve(null)
      return DX.fetchJson('/app/doc?slug=' + encodeURIComponent(slug) + '&v=' + n + '&theme=' + shell.theme()).then(function (d) {
        if (!d || d.__unauthorized || d.error) return null
        return d.kind === 'text' ? d.markdown || '' : typeof d.html === 'string' ? d.html : null
      }, function () { return null })
    }

    function undoTurn(base) {
      post('/app/restore', { version: base }).then(function (res) {
        seenVersion = res.version
        endTurn()
        return refreshDoc(false).then(function () { DX.toast('Правка агента отменена') })
      }, function (e) { DX.toast(e.message) })
    }

    /** The page opened just after an agent edited it: the same bar, from the history. */
    function resumeTurn() {
      var latest = ctx.turns().filter(function (t) { return t.latest && !t.undone })[0]
      if (!latest || Date.now() - latest.last > FRESH_TURN || !ctx.canWrite()) return
      fetchContent(latest.base).then(function (base) {
        if (dead || base === null || turn) return
        startTurn(latest.base, base, latest.to)
      })
    }

    // ---- Building the screen ----

    function build() {
      var d = ctx.data
      root.textContent = ''
      doc = h('div.doc', { 'data-kind': d.kind, 'data-mode': 'view', 'data-w': pref.w, 'data-f': pref.f })
      root.appendChild(doc)
      panel = DX.Panel(ctx, doc)
      ctrl = d.kind === 'text' ? DX.TextDoc(ctx, doc) : DX.HtmlDoc(ctx, doc)
      ctrl.mount()
      ctrl.onDirty(onChange)
      if (ctrl.onSelect) ctrl.onSelect(function () {})
      var left = h('div.isl.dtop-l')
      left.appendChild(DX.ib('arrow-left', 'К списку документов', shell.back, { tp: 'dr' }))
      titleEl = h('button.ttl', { type: 'button', 'data-tip': ctx.canWrite() ? 'Переименовать' : d.title, 'data-tp': 'd', onClick: renameStart }, h('span', d.title))
      left.appendChild(titleEl)
      left.appendChild(h('span.vs'))
      modeSeg = h('div.seg.sm', { role: 'tablist' })
      left.appendChild(modeSeg)
      savedEl = h('div.saved', h('i'), h('span', 'Сохранено'))
      left.appendChild(savedEl)
      toolsEl = h('span', { style: 'display:contents' })
      left.appendChild(toolsEl)
      doc.appendChild(left)
      rightEl = h('div.isl.dtop-r')
      doc.appendChild(rightEl)
      drawModeSeg()
      drawTools()
      drawRight()
      drawBanner()
      document.addEventListener('keydown', onKey)
      window.addEventListener('beforeunload', onUnload)
    }

    function drawModeSeg() {
      modeSeg.textContent = ''
      var canEdit = ctx.canWrite()
      modeSeg.appendChild(h('button', { type: 'button', role: 'tab', 'data-on': String(mode === 'view'), onClick: function () { setMode('view') } }, DX.icon('eye'), h('span', 'Просмотр')))
      modeSeg.appendChild(h('button', { type: 'button', role: 'tab', 'data-on': String(mode === 'edit'), 'data-off': String(!canEdit), 'data-tip': canEdit ? null : 'Нет права править этот документ', 'data-tp': 'd', onClick: function () { if (canEdit) setMode('edit') } }, DX.icon('pencil'), h('span', 'Правка')))
    }

    function setMode(m) {
      if (m === mode) return
      if (m === 'view' && ctrl.dirty && ctrl.dirty()) flush()
      mode = m
      doc.dataset.mode = m
      ctrl.setMode(m)
      drawModeSeg()
      drawTools()
    }
    ctx.setMode = setMode

    function drawTools() {
      if (!toolsEl) return
      toolsEl.textContent = ''
      if (ctx.data.kind !== 'html') return
      toolsEl.appendChild(h('span.vs'))
      var dev = h('div.seg.sm')
      ;[['desktop', 'monitor', 'Десктоп'], ['tablet', 'tablet', 'Планшет'], ['phone', 'smartphone', 'Телефон']].forEach(function (x) {
        dev.appendChild(h('button', { type: 'button', 'data-on': String(ctrl.device() === x[0]), 'data-tip': x[2], 'data-tp': 'd', 'aria-label': x[2], onClick: function () { ctrl.setDevice(x[0]) } }, DX.icon(x[1])))
      })
      toolsEl.appendChild(dev)
      if (mode === 'edit') {
        toolsEl.appendChild(DX.ib('undo-2', 'Отменить · ⌘Z', function () { ctrl.undo() }, { tp: 'd', off: !ctrl.canUndo() }))
        toolsEl.appendChild(DX.ib('redo-2', 'Повторить · ⇧⌘Z', function () { ctrl.redo() }, { tp: 'd', off: !ctrl.canRedo() }))
      }
      if (ctx.canComment()) toolsEl.appendChild(DX.ib('message-circle', 'Комментарий к элементу', function () { ctrl.setTool(ctrl.tool() === 'comment' ? 'select' : 'comment') }, { tp: 'd', on: ctrl.tool() === 'comment' }))
    }

    function drawRight() {
      if (!rightEl) return
      rightEl.textContent = ''
      var people = {}
      var names = []
      function see(n, kind) {
        if (n && !people[n]) {
          people[n] = kind
          names.push(n)
        }
      }
      see(ctx.data.author, 'person')
      threads.forEach(function (t) { t.messages.forEach(function (m) { see(m.author.name, m.author.kind) }) })
      var avs = h('div.avs')
      names.slice(0, 4).forEach(function (n) { avs.appendChild(DX.avatar(n, people[n], 24)) })
      if (names.length) rightEl.appendChild(h('div', { style: 'padding:0 8px;display:flex' }, avs))
      rightEl.appendChild(h('button.btn.sm.soft', { type: 'button', 'data-tip': 'Скопировать ссылку', 'data-tp': 'dl', onClick: function () { ctx.copyLink() } }, DX.icon('share'), h('span', 'Поделиться')))
      var open = threads.filter(function (t) { return t.status === 'open' }).length
      var cb = DX.ib('message-square', 'Комментарии', function () { if (panel.isOpen() && panel.tab() === 'comments') panel.close(); else panel.open('comments') }, { tp: 'dl', on: panel && panel.isOpen() && panel.tab() === 'comments' })
      if (open) cb.appendChild(h('span.cnt', String(open)))
      rightEl.appendChild(cb)
      rightEl.appendChild(DX.ib('sparkles', 'Чат с агентом', function () { if (panel.isOpen() && panel.tab() === 'chat') panel.close(); else panel.open('chat') }, { tp: 'dl', on: panel && panel.isOpen() && panel.tab() === 'chat' }))
      var more = DX.ib('ellipsis', 'Ещё', function () { moreMenu(more) }, { tp: 'dl' })
      rightEl.appendChild(more)
    }

    // ---- ⋯ ----

    function moreMenu(anchor) {
      var d = ctx.data
      DX.popover(anchor, function (close) {
        var box = h('div')
        box.appendChild(DX.mi('history', 'История версий', function () { close(); versionsMenu(anchor) }, { hint: 'версия ' + d.version.n }))
        box.appendChild(DX.mi('link', 'Копировать ссылку', function () { close(); ctx.copyLink() }))
        box.appendChild(h('div.msep'))
        box.appendChild(h('div.mlab', 'Экспорт'))
        if (d.kind === 'text') {
          box.appendChild(DX.mi('file-down', 'Markdown', function () { close(); download(d.title + '.md', ctrl.markdown(), 'text/markdown') }))
          box.appendChild(DX.mi('file-down', 'PDF', function () { close(); window.print() }, { hint: 'печать' }))
        } else {
          box.appendChild(DX.mi('file-down', 'HTML', function () {
            close()
            var a = h('a', { href: d.contentUrl + '&download=html', download: '' })
            document.body.appendChild(a)
            a.click()
            a.remove()
          }))
        }
        if (d.kind === 'text') {
          box.appendChild(h('div.msep'))
          box.appendChild(h('div.mrow', h('span', 'Ширина'), segment([['narrow', 'Уже'], ['normal', 'Обычная'], ['wide', 'Шире']], pref.w, function (v) { pref.w = v; DX.pref.set('width', v); doc.dataset.w = v; close() })))
          box.appendChild(h('div.mrow', h('span', 'Шрифт'), segment([['sans', 'Без засечек'], ['serif', 'С засечками']], pref.f, function (v) { pref.f = v; DX.pref.set('font', v); doc.dataset.f = v; close() })))
        }
        if (d.rights.create && (d.hub || d.rights.write)) {
          box.appendChild(h('div.msep'))
          box.appendChild(DX.mi('trash-2', d.hub ? 'В корзину' : 'Удалить документ', function () { close(); if (d.hub) toTrash(); else confirmDelete(anchor) }, { danger: true }))
        }
        return box
      }, { align: 'end' })
    }

    function segment(options, current, onPick) {
      var seg = h('div.seg.sm')
      options.forEach(function (o) {
        seg.appendChild(h('button', { type: 'button', 'data-on': String(o[0] === current), onClick: function () { onPick(o[0]) } }, o[1]))
      })
      return seg
    }

    function download(name, text, type) {
      var url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }))
      var a = h('a', { href: url, download: name.replace(/[\\/:*?"<>|]+/g, '-') })
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
    }

    function versionsMenu(anchor) {
      DX.popover(anchor, function (close) {
        var box = h('div', { style: 'min-width:280px' }, h('div.mlab', 'История версий'))
        ctx.data.versions.forEach(function (v) {
          var current = v.n === ctx.data.version.of
          box.appendChild(h('button.mi.tall', { type: 'button', onClick: function () { close(); shell.navigate(slug, current ? null : v.n) } },
            DX.avatar(v.author || 'Автор', isAgentVersion(v) ? 'agent' : 'person', 20),
            h('span.tx', h('span', 'Версия ' + v.n + (current ? ' · текущая' : '')), h('em', (v.author || '') + (v.author ? ' · ' : '') + DX.when(v.createdAt) + (v.note ? ' · ' + v.note : '')))))
        })
        return box
      }, { align: 'end' })
    }

    /** Into the hub's trash at once; «Отменить» in the toast takes it out again and reopens it. */
    function toTrash() {
      var title = ctx.data.title
      DX.fetchJson('/app/doc?slug=' + encodeURIComponent(slug), { method: 'DELETE' }).then(function () {
        shell.back()
        DX.toast('«' + title + '» в корзине', { label: 'Отменить', run: function () {
          DX.fetchJson('/app/trash/restore', { method: 'POST', body: { slug: slug } }).then(function () { shell.navigate(slug) }, function (e) { DX.toast(e.message) })
        } })
      }, function (e) { DX.toast(e.message) })
    }

    function confirmDelete(anchor) {
      DX.popover(anchor, function (close) {
        return h('div', { style: 'padding:8px;min-width:240px' }, h('div', { style: 'padding:4px 6px 10px' }, 'Удалить «' + ctx.data.title + '» вместе с комментариями? Это нельзя отменить.'),
          h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
            h('button.btn.sm.ghost', { type: 'button', onClick: close }, 'Отмена'),
            h('button.btn.sm.pri', { type: 'button', style: 'background:var(--dx-danger);color:#fff', onClick: function () {
              DX.fetchJson('/app/doc?slug=' + encodeURIComponent(slug), { method: 'DELETE' }).then(function () { close(); shell.back(); DX.toast('Документ удалён') }, function (e) { DX.toast(e.message) })
            } }, 'Удалить')))
      }, { align: 'end' })
    }

    // ---- The title ----

    function renameStart() {
      if (!ctx.canWrite()) return
      var input = h('input.ttl-in', { value: ctx.data.title, 'aria-label': 'Название документа' })
      titleEl.replaceWith(input)
      input.focus()
      input.select()
      var done = false
      function finish(save) {
        if (done) return
        done = true
        var next = input.value.trim()
        input.replaceWith(titleEl)
        if (!save || !next || next === ctx.data.title) return
        DX.fetchJson('/app/doc', { method: 'PATCH', body: { slug: slug, title: next } }).then(function (res) {
          ctx.data.title = res.title
          titleEl.firstChild.textContent = res.title
          if (ctrl.refreshHeader) ctrl.refreshHeader()
        }, function (e) { DX.toast(e.message) })
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      })
      input.addEventListener('blur', function () { finish(true) })
    }

    // ---- Saving ----

    function setStatus(s) {
      if (!savedEl) return
      savedEl.dataset.s = s
      savedEl.lastChild.textContent = s === 'saving' ? 'Сохраняю…' : s === 'dirty' ? 'Есть несохранённое' : s === 'error' ? 'Не сохранилось · повторить' : 'Сохранено'
    }

    function onChange() {
      endTurn()
      setStatus('dirty')
      clearTimeout(timers.save)
      timers.save = setTimeout(save, SAVE_MS)
      drawTools()
    }

    function flush() {
      clearTimeout(timers.save)
      return save()
    }

    function save(force) {
      clearTimeout(timers.save)
      if (saving) return saving.then(function () { return ctrl.dirty() ? save(force) : null })
      if (!ctrl.dirty || !ctrl.dirty() || !ctx.canWrite()) return Promise.resolve()
      setStatus('saving')
      var body = { slug: slug, note: 'Правка в редакторе' }
      if (!force) body.baseVersion = ctx.data.version.n
      var snapshot
      var atRev = ctrl.revision()
      if (ctx.data.kind === 'text') {
        snapshot = ctrl.markdown()
        body.markdown = snapshot
      } else {
        snapshot = ctrl.html()
        body.html = snapshot
      }
      saving = DX.fetchJson('/app/doc', { method: 'PUT', body: body }).then(
        function (res) {
          saving = null
          if (res.__unauthorized) {
            setStatus('error')
            return shell.needSignIn()
          }
          ctx.data.version.n = res.version
          ctx.data.version.of = res.version
          seenVersion = res.version
          ctrl.markSaved(atRev)
          lastContent = snapshot
          conflict = false
          drawBanner()
          setStatus(ctrl.dirty() ? 'dirty' : 'saved')
          drawTools()
          if (ctrl.dirty()) timers.save = setTimeout(save, SAVE_MS)
        },
        function (error) {
          saving = null
          if (error.code === 'version_conflict') {
            conflict = true
            setStatus('error')
            drawBanner()
          } else {
            setStatus('error')
            DX.toast('Не удалось сохранить: ' + error.message)
          }
        },
      )
      return saving
    }

    // ---- A banner: a conflict, an old version ----

    function drawBanner() {
      if (bannerEl) bannerEl.remove()
      bannerEl = null
      if (!doc) return
      var d = ctx.data
      if (!d.version.current) {
        bannerEl = h('div.banner', h('span', 'Вы смотрите версию ' + d.version.n + ' из ' + d.version.of), d.rights.restore ? h('button.btn.sm.pri', { type: 'button', onClick: restoreVersion }, 'Вернуть эту версию') : null, h('button.btn.sm.ghost', { type: 'button', onClick: function () { shell.navigate(slug, null) } }, 'К текущей'))
      } else if (conflict) {
        bannerEl = h('div.banner', h('span', 'Документ изменили, пока вы правили (другой человек или агент).'),
          h('button.btn.sm.ghost', { type: 'button', onClick: function () { conflict = false; drawBanner(); save(true) } }, 'Оставить мои правки'),
          h('button.btn.sm.pri', { type: 'button', onClick: function () { conflict = false; drawBanner(); refreshDoc(true) } }, 'Взять новую версию'))
      }
      if (bannerEl) doc.appendChild(bannerEl)
    }

    function restoreVersion() {
      post('/app/restore', { version: ctx.data.version.n }).then(function () { shell.navigate(slug, null) }, function (e) { DX.toast(e.message) })
    }

    // ---- Keeping up ----

    function refreshDoc(flash) {
      var prevN = seenVersion
      var prevContent = lastContent
      return load().then(function (data) {
        if (!data || dead) return
        var fresh = (data.versions || []).filter(function (v) { return v.n > prevN })
        var byAgent = flash && fresh.length && fresh.every(isAgentVersion)
        ctx.data = data
        seenVersion = data.version.n
        lastContent = contentOf(data)
        if (data.kind === 'text') ctrl.reload(data.markdown, { flash: !!flash })
        else ctrl.reload(data)
        if (ctrl.setMode) ctrl.setMode(mode)
        titleEl.firstChild.textContent = data.title
        ctrl.markSaved(ctrl.revision())
        setStatus('saved')
        drawBanner()
        drawRight()
        drawTools()
        if (byAgent) {
          if (turn && !turn.closed && turn.to === prevN && Date.now() - turn.at < TURN_GAP) {
            var lit = lightChanges(turn.baseContent)
            turn.to = data.version.n
            turn.at = Date.now()
            turn.targets = lit.targets
            turn.places = lit.places
            drawAgentBar()
          } else startTurn(prevN, prevContent, data.version.n)
        } else if (flash && fresh.length) endTurn()
        else if (turn) lightChanges(turn.baseContent)
        if (panel && panel.isOpen()) panel.render()
        return byAgent
      })
    }

    function schedulePoll() {
      clearTimeout(timers.poll)
      timers.poll = setTimeout(poll, POLL_MS)
    }

    function poll() {
      if (dead) return
      if (document.hidden) return schedulePoll()
      DX.fetchJson('/app/state?slug=' + encodeURIComponent(slug)).then(
        function (st) {
          if (dead || st.__unauthorized) return
          var jobs = []
          if (ctx.data.version.current && st.version !== seenVersion) {
            if (ctrl.dirty && ctrl.dirty()) {
              if (!conflict) {
                conflict = true
                drawBanner()
              }
            } else {
              jobs.push(
                refreshDoc(true).then(function (byAgent) {
                  if (!byAgent) DX.toast('Документ обновлён: версия ' + st.version)
                }),
              )
            }
          }
          if (st.commentsRev !== rev) jobs.push(fromServer())
          return Promise.all(jobs)
        },
        function () {},
      ).then(schedulePoll, schedulePoll)
    }

    // What is selected in the page of an HTML document goes to the chat as a chip (the frame reports it).
    function onFrameMessage(event) {
      var frame = doc && doc.querySelector('iframe')
      if (!frame || event.source !== frame.contentWindow) return
      var m = event.data || {}
      if (m.type !== 'doc-selection') return
      chipText = String(m.text || '')
      var r = m.rect
      var at = frame.getBoundingClientRect()
      shell.tell({ kind: 'document', title: ctx.data.title, url: ctx.data.url || '', object: slug, selection: chipText.slice(0, 600), rect: r && typeof r.x === 'number' ? { x: r.x + at.left, y: r.y + at.top, w: r.w, h: r.h } : null })
      if (panel && panel.isOpen() && panel.tab() === 'chat') panel.render()
    }

    function onKey(e) {
      var key = String(e.key).toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 's') {
        e.preventDefault()
        flush()
      } else if (ctx.data.kind === 'html' && mode === 'edit' && (e.metaKey || e.ctrlKey) && (key === 'z' || key === 'y') && !/INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) {
        e.preventDefault()
        if (key === 'y' || e.shiftKey) ctrl.redo()
        else ctrl.undo()
      }
    }

    function onUnload() {
      if (ctrl && ctrl.dirty && ctrl.dirty()) save()
    }

    var api = {
      destroy: function () {
        dead = true
        clearTimeout(timers.poll)
        clearTimeout(timers.save)
        if (ctrl && ctrl.dirty && ctrl.dirty()) save()
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('beforeunload', onUnload)
        window.removeEventListener('message', onFrameMessage)
        if (ctrl) ctrl.destroy()
        if (panel) panel.close()
        DX.closePopovers()
      },
      selectionFromFrame: function (text, rect) {
        chipText = text
        void rect
      },
      ctx: ctx,
      /** A fast voice edit was saved by the host: the new version is shown and the changed place lit (HRN-1466). */
      quickEdit: function (hint) {
        return refreshDoc(false).then(function () {
          if (dead) return
          var lines = String(hint || '').split('\n').map(function (l) { return l.replace(/^[\s#>*+\-\d.)]+/, '').replace(/[*_`~]/g, '').trim() }).filter(Boolean)
          var lit = ctrl && ctrl.revealText && lines.some(function (l) { return ctrl.revealText(l) })
          if (!lit) DX.toast('Документ обновлён голосовой правкой')
        }, function () {})
      },
    }
    start().catch(function (error) {
      if (dead) return
      if (error && error.status === 404) shell.fail('Такого документа нет', 'Или он вам недоступен.')
      else shell.failed(error)
    })
    return api
  }
})()
