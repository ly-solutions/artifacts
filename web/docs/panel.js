/* The right island: «Комментарии · Чат». Comments are the threads of the document (all together, filtered, a click
 * scrolls to the place); the chat hands the person's question — with the selected words as a chip — to the agent in the
 * harnessly chat, and lists what the agent changed in the document, with «Показать» and «Отменить». */
;(function () {
  'use strict'
  var DX = window.DX
  var h = DX.h

  var MENTION = /(^|[\s(,.;:!?])(@[\p{L}\p{N}_.-]+)/gu

  /** Text with @mentions lit. */
  DX.textWithMentions = function (text, parent) {
    var last = 0
    String(text).replace(MENTION, function (all, pre, tag, at) {
      var start = at + pre.length
      if (start > last) parent.appendChild(document.createTextNode(text.slice(last, start)))
      parent.appendChild(h('span.mention', tag))
      last = start + tag.length
      return all
    })
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
  }

  /** A text field that suggests people and the agent after «@». */
  DX.attachMentions = function (textarea, people) {
    var pop = null
    function close() {
      if (pop) pop.close()
      pop = null
    }
    textarea.addEventListener('input', function () {
      var before = textarea.value.slice(0, textarea.selectionStart)
      var m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before)
      if (!m) return close()
      var q = m[2].toLowerCase()
      var list = [{ name: 'агент', kind: 'agent', hint: 'ответит в треде' }].concat(people().map(function (n) { return { name: n, kind: 'person' } })).filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) === 0 || p.name.toLowerCase().split(/\s+/).some(function (w) { return w.indexOf(q) === 0 })
      })
      if (!list.length) return close()
      close()
      pop = DX.popover(textarea, function (done) {
        var box = h('div.sugg')
        list.slice(0, 6).forEach(function (p) {
          var row = h('button.mi', { type: 'button', onMousedown: function (e) { e.preventDefault() }, onClick: function () {
            var start = textarea.selectionStart - m[2].length - 1
            var tag = '@' + p.name.split(/\s+/)[0] + ' '
            textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(textarea.selectionStart)
            textarea.focus()
            textarea.selectionStart = textarea.selectionEnd = start + tag.length
            done()
          } }, DX.avatar(p.name, p.kind, 20), h('span', p.name), p.hint ? h('small', p.hint) : null)
          box.appendChild(row)
        })
        return box
      }, { side: 'above', keep: function () { return true } })
    })
    textarea.addEventListener('blur', function () { setTimeout(close, 150) })
    textarea.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pop) { e.stopPropagation(); close() } })
  }

  /** A comment field: text, «@», send. onSend(text) → Promise; the field clears when it resolves. */
  DX.composer = function (opts) {
    var ta = h('textarea', { rows: '1', placeholder: opts.placeholder || 'Написать… «@» — позвать агента', 'aria-label': opts.placeholder || 'Комментарий' })
    var send = opts.round
      ? h('button.send', { type: 'button', disabled: true, 'data-tip': 'Отправить · Enter', 'data-tp': 'dl', 'aria-label': 'Отправить', onClick: go }, DX.icon('arrow-up'))
      : h('button.btn.sm.pri', { type: 'button', disabled: true, onClick: go }, opts.label || 'Отправить')
    var box = h('div.composer' + (opts.round ? '.comp' : ''))
    if (opts.chip) box.appendChild(opts.chip)
    box.appendChild(ta)
    box.appendChild(h('div.row', h('button.ib', { type: 'button', 'data-tip': 'Позвать агента', 'data-tp': 'd', 'aria-label': 'Позвать агента', style: 'width:28px;height:28px', onClick: function () {
      ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + '@агент '
      ta.focus()
      ta.dispatchEvent(new Event('input'))
    } }, DX.icon('at-sign')), h('span.sp'), opts.onCancel ? h('button.btn.sm.ghost', { type: 'button', onClick: opts.onCancel }, 'Отмена') : null, send))
    function fit() {
      ta.style.height = 'auto'
      ta.style.height = Math.min(160, ta.scrollHeight) + 'px'
    }
    function go() {
      var text = ta.value.trim()
      if (!text || send.disabled) return
      send.disabled = true
      Promise.resolve(opts.onSend(text)).then(
        function () {
          ta.value = ''
          fit()
        },
        function (error) {
          send.disabled = false
          DX.toast(error && error.message ? error.message : 'Не получилось отправить')
        },
      )
    }
    ta.addEventListener('input', function () {
      send.disabled = !ta.value.trim()
      fit()
    })
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault()
        go()
      }
    })
    DX.attachMentions(ta, opts.people || function () { return [] })
    box.focusField = function () { ta.focus() }
    box.field = ta
    return box
  }

  /** The one-line reply under a thread: «Ответить…», «@» suggests, the arrow (or Enter) sends. */
  DX.replyField = function (opts) {
    var input = h('input', { type: 'text', placeholder: 'Ответить… @ — упомянуть', 'aria-label': 'Ответить' })
    var send = h('button.ib', { type: 'button', disabled: true, 'data-tip': 'Отправить · Enter', 'data-tp': 'dl', 'aria-label': 'Отправить', style: 'width:26px;height:26px', onClick: go }, DX.icon('arrow-up'))
    var box = h('div.rep', input, send)
    function go() {
      var text = input.value.trim()
      if (!text || send.disabled) return
      send.disabled = true
      Promise.resolve(opts.onSend(text)).then(
        function () { input.value = '' },
        function (error) {
          send.disabled = false
          DX.toast(error && error.message ? error.message : 'Не получилось отправить')
        },
      )
    }
    input.addEventListener('input', function () { send.disabled = !input.value.trim() })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        go()
      }
    })
    DX.attachMentions(input, opts.people || function () { return [] })
    box.focusField = function () { input.focus() }
    return box
  }

  DX.Panel = function (ctx, host) {
    var el = null
    var tab = 'comments'
    var filter = 'open'
    var ctrl = {}
    var composers = {}

    function peopleNames() {
      var seen = {}
      var out = []
      ctx.threads().forEach(function (t) {
        t.messages.forEach(function (m) {
          if (m.author.kind === 'person' && !seen[m.author.name]) {
            seen[m.author.name] = 1
            out.push(m.author.name)
          }
        })
      })
      if (!seen[ctx.me()]) out.unshift(ctx.me())
      return out
    }
    ctrl.people = peopleNames

    ctrl.isOpen = function () {
      return !!el
    }

    ctrl.open = function (which) {
      if (which) tab = which
      if (el && !el.dataset.ph) return ctrl.render()
      el = h('aside.rp', { 'aria-label': 'Комментарии и чат' })
      host.appendChild(el)
      host.dataset.panel = '1'
      ctrl.render()
      ctx.layout()
    }

    ctrl.close = function () {
      if (!el) return
      var gone = el
      el = null
      gone.dataset.ph = 'closing'
      setTimeout(function () { gone.remove() }, 200)
      delete host.dataset.panel
      ctx.layout()
    }

    ctrl.tab = function () {
      return tab
    }

    ctrl.render = function () {
      if (!el) return
      var keepScroll = el.querySelector('.rp-b') ? el.querySelector('.rp-b').scrollTop : 0
      el.textContent = ''
      var seg = h('div.seg', { role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'data-on': String(tab === 'comments'), onClick: function () { tab = 'comments'; ctrl.render() } }, 'Комментарии'),
        h('button', { type: 'button', role: 'tab', 'data-on': String(tab === 'chat'), onClick: function () { tab = 'chat'; ctrl.render() } }, 'Чат'),
      )
      el.appendChild(h('div.rp-h', seg, DX.ib('x', 'Закрыть', ctrl.close, { tp: 'dl' })))
      if (tab === 'comments') commentsTab()
      else chatTab()
      var body = el.querySelector('.rp-b')
      if (body) body.scrollTop = keepScroll
    }

    // ---- Comments ----

    function visible() {
      var me = ctx.me()
      return ctx.threads().filter(function (t) {
        if (filter === 'open') return t.status === 'open'
        if (filter === 'resolved') return t.status === 'resolved'
        return t.status === 'open' && t.messages.some(function (m) { return (m.author.name === me && m.author.kind === 'person') || new RegExp('@' + me.split(/\s+/)[0], 'i').test(m.text) })
      })
    }

    function commentsTab() {
      var filters = h('div.seg.sm.pfil', { role: 'tablist' })
      ;[['open', 'Открытые'], ['resolved', 'Решённые'], ['mine', 'Мне']].forEach(function (f) {
        filters.appendChild(h('button', { type: 'button', role: 'tab', 'data-on': String(filter === f[0]), onClick: function () { filter = f[0]; ctrl.render() } }, f[1]))
      })
      el.appendChild(h('div.pfil-w', filters))
      var body = h('div.rp-b')
      var list = visible()
      if (!list.length) {
        var empty = { open: ['Пока ни одного комментария', ctx.canComment() ? 'Выделите слова в тексте и нажмите «Комментарий». Чтобы позвать агента, напишите @агент.' : ''], resolved: ['Решённых нет', 'Здесь будут обсуждения, которые вы закрыли.'], mine: ['Для вас ничего нет', 'Сюда попадают треды, где вы писали или где вас упомянули.'] }[filter]
        body.appendChild(h('div.hint', h('b', empty[0]), empty[1]))
      }
      list.forEach(function (t) {
        body.appendChild(threadCard(t))
      })
      el.appendChild(body)
    }

    function anchorLabel(t) {
      if (t.anchor.kind === 'text') return t.anchor.quote
      if (t.anchor.kind === 'element') return t.anchor.label + (t.anchor.text ? ' · ' + t.anchor.text : '')
      return 'Весь документ'
    }

    function threadCard(t) {
      var on = ctx.activeThread() === t.id
      var open = t.status === 'open'
      var card = h('div.thread', { 'data-id': t.id, 'data-on': String(on), 'data-resolved': open ? '0' : '1', onClick: function (e) {
        if (e.target.closest('button, textarea, input, a')) return
        ctx.openThread(t.id)
      } })
      var label = anchorLabel(t)
      var quoteIcon = t.anchor.kind === 'element' ? 'square-mouse-pointer' : t.anchor.kind === 'doc' ? 'file-text' : 'text-quote'
      card.appendChild(h('button.tq', { type: 'button', 'data-tip': 'Показать в документе', 'data-tp': 'd', onClick: function () { ctx.openThread(t.id) } }, DX.icon(quoteIcon), h('span', label)))
      t.messages.forEach(function (m, i) {
        card.appendChild(messageRow(t, m, i === 0))
      })
      if (ctx.pendingAgent(t.id)) card.appendChild(h('div.typing', h('span.orb'), h('span', 'агент печатает'), h('b', h('i'), h('i'), h('i'))))
      var last = t.messages[t.messages.length - 1]
      if (ctx.canComment() && last) card.appendChild(h('div.rx.add', reactionButton(t, last)))
      if (ctx.canComment() && open) {
        var comp = composers[t.id] || (composers[t.id] = DX.replyField({ people: peopleNames, onSend: function (text) { return ctx.reply(t.id, text) } }))
        card.appendChild(comp)
      }
      return card
    }

    function reactionButton(t, m) {
      return h('button.ib', { type: 'button', 'data-tip': 'Реакция', 'data-tp': 'd', 'aria-label': 'Реакция', onClick: function (e) {
        DX.popover(e.currentTarget, function (close) {
          var box = h('div', { style: 'display:flex;gap:2px' })
          ;['👍', '❤️', '🎉', '👀', '✅'].forEach(function (emoji) {
            box.appendChild(h('button.ib', { type: 'button', onClick: function () { close(); ctx.react(t.id, m.id, emoji) } }, emoji))
          })
          return box
        }, { side: 'above' })
      } }, DX.icon('smile-plus'))
    }

    function messageRow(t, m, first) {
      var txt = h('p')
      DX.textWithMentions(m.text, txt)
      var who = h('div.who', h('span.nm', m.author.name), h('em', DX.ago(m.at)))
      if (first && ctx.canComment()) {
        var open = t.status === 'open'
        who.appendChild(DX.ib(open ? 'circle-check' : 'rotate-ccw', open ? 'Решено' : 'Открыть снова', function (e) { e.stopPropagation(); ctx.setStatus(t.id, open ? 'resolved' : 'open') }, { tp: 'dl' }))
      }
      var body = h('div.body', who, txt)
      var row = h('div.msg', DX.avatar(m.author.name, m.author.kind, 22), body)
      var reacted = Object.keys(m.reactions || {})
      if (reacted.length) {
        var rx = h('div.rx')
        reacted.forEach(function (emoji) {
          var people = m.reactions[emoji]
          rx.appendChild(h('button', { type: 'button', 'data-me': String(people.indexOf(ctx.me()) !== -1), 'data-tip': people.join(', '), 'data-tp': 'd', onClick: function () { ctx.react(t.id, m.id, emoji) } }, emoji + ' ' + people.length))
        })
        body.appendChild(rx)
      }
      var edit = m.edit && (t.edits || []).filter(function (x) { return x.id === m.edit })[0]
      if (edit) body.appendChild(editChips(t, edit))
      return row
    }

    /** «Показать в документе» · «Отменить» (or «Отменено») under an agent's answer that changed the text. */
    function editChips(t, edit) {
      var row = h('div.chips')
      row.appendChild(h('button.chipl', { type: 'button', onClick: function () { ctx.showEdit(edit) } }, DX.icon('locate'), 'Показать в документе'))
      if (edit.undone) row.appendChild(h('span.chipl', { 'data-off': 'true' }, DX.icon('check'), 'Отменено'))
      else if (ctx.canWrite()) row.appendChild(h('button.chipl', { type: 'button', onClick: function () { ctx.undoEdit(t, edit) } }, DX.icon('rotate-ccw'), 'Отменить'))
      return row
    }

    // ---- Chat ----

    var chatComposer = null
    function chatTab() {
      var body = h('div.rp-b.chat')
      var items = []
      ctx.asked().slice(-8).forEach(function (a) { items.push({ at: Date.parse(a.at) || 0, ask: a }) })
      ctx.turns().slice(-6).forEach(function (t) { items.push({ at: t.last, turn: t }) })
      items.sort(function (a, b) { return a.at - b.at })
      if (!items.length) body.appendChild(h('div.hint', h('b', 'Чат документа'), 'Спросите про текст или попросите поправить: вопрос уйдёт агенту в чат harnessly, а его правки в документе появятся здесь.'))
      items.forEach(function (it) {
        if (it.ask) {
          body.appendChild(h('div.um', it.ask.quote ? h('div.qq', DX.icon('text-quote'), h('span', '«' + it.ask.quote + '»')) : null, it.ask.text))
          body.appendChild(h('div.step', DX.icon('send'), 'отправлено в чат harnessly'))
        } else body.appendChild(turnMessage(it.turn))
      })
      if (ctx.chatBusy()) body.appendChild(h('div.typing', h('span.orb'), h('span', 'агент печатает'), h('b', h('i'), h('i'), h('i'))))
      el.appendChild(body)
      body.scrollTop = body.scrollHeight
      var foot = h('div.rp-f')
      var sel = ctx.chip()
      var chip = null
      if (sel) chip = h('div.ctxc', h('span', DX.icon('text-quote'), h('em', '«' + sel + '»'), h('button.x', { type: 'button', 'aria-label': 'Убрать фрагмент', 'data-tip': 'Убрать фрагмент', 'data-tp': 'dl', onClick: function () { ctx.dropChip(); ctrl.render() } }, DX.icon('x'))))
      chatComposer = DX.composer({ placeholder: 'Спросите или попросите поправить документ', chip: chip, round: true, people: peopleNames, onSend: function (text) { return ctx.ask2(text) } })
      foot.appendChild(chatComposer)
      el.appendChild(foot)
    }

    /** One agent's turn in the chat: what it did, in a line, with the two chips. */
    function turnMessage(t) {
      var stepText = h('span', t.places ? ctx.placesLabel(t.places) : ctx.placesLabel(0))
      var when = h('em', ' · ' + DX.ago(new Date(t.last).toISOString()))
      var msg = h('div.am', h('div.step', DX.icon('check'), stepText, when))
      msg.appendChild(h('p', t.notes.length ? t.notes.join(' · ') : t.undone ? 'Правка отменена.' : 'Поправил документ.'))
      var chips = h('div.chips')
      chips.appendChild(h('button.chipl', { type: 'button', onClick: function () { ctx.showTurn(t) } }, DX.icon('locate'), 'Показать в документе'))
      if (t.undone) chips.appendChild(h('span.chipl', { 'data-off': 'true' }, DX.icon('check'), 'Отменено'))
      else if (t.latest && ctx.canWrite()) chips.appendChild(h('button.chipl', { type: 'button', onClick: function () { ctx.undoTurn(t) } }, DX.icon('rotate-ccw'), 'Отменить'))
      msg.appendChild(chips)
      if (!t.places && t.latest) {
        ctx.turnPlaces(t).then(function (n) { if (n) stepText.textContent = ctx.placesLabel(n) })
      }
      return msg
    }

    ctrl.focusChat = function () {
      if (chatComposer) chatComposer.focusField()
    }
    ctrl.forget = function (id) { delete composers[id] }
    return ctrl
  }
})()
