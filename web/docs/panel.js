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
    var send = h('button.btn.sm.pri', { type: 'button', disabled: true, onClick: go }, opts.label || 'Отправить')
    var box = h('div.composer')
    if (opts.chip) box.appendChild(opts.chip)
    box.appendChild(ta)
    box.appendChild(h('div.row', h('button.ib', { type: 'button', 'data-tip': 'Позвать агента', 'aria-label': 'Позвать агента', style: 'width:28px;height:28px', onClick: function () {
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

    function counts() {
      var open = ctx.threads().filter(function (t) { return t.status === 'open' }).length
      return open
    }

    ctrl.render = function () {
      if (!el) return
      var keepScroll = el.querySelector('.rp-b') ? el.querySelector('.rp-b').scrollTop : 0
      el.textContent = ''
      var open = counts()
      var seg = h('div.seg.sm', { role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'data-on': String(tab === 'comments'), onClick: function () { tab = 'comments'; ctrl.render() } }, 'Комментарии' + (open ? ' · ' + open : '')),
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
      var filters = h('div.filters')
      ;[['open', 'Открытые'], ['resolved', 'Решённые'], ['mine', 'Мне']].forEach(function (f) {
        filters.appendChild(h('button.chip', { type: 'button', 'data-on': String(filter === f[0]), onClick: function () { filter = f[0]; ctrl.render() } }, f[1]))
      })
      el.appendChild(filters)
      var body = h('div.rp-b')
      var list = visible()
      if (!list.length) {
        body.appendChild(h('div.hint', h('b', filter === 'resolved' ? 'Решённых нет' : 'Пока ни одного комментария'), ctx.canComment() ? 'Выделите слова в тексте и нажмите «Комментарий». Чтобы позвать агента, напишите @агент.' : 'Комментировать этот документ может только тот, кому дали такое право.'))
      }
      list.forEach(function (t) {
        body.appendChild(threadCard(t))
      })
      el.appendChild(body)
    }

    function anchorLabel(t) {
      if (t.anchor.kind === 'text') return t.anchor.quote
      if (t.anchor.kind === 'element') return t.anchor.label + (t.anchor.text ? ' · ' + t.anchor.text : '')
      return ''
    }

    function threadCard(t) {
      var on = ctx.activeThread() === t.id
      var card = h('div.thread', { 'data-id': t.id, 'data-on': String(on), 'data-resolved': t.status === 'resolved' ? '1' : '0', onClick: function (e) {
        if (e.target.closest('button, textarea, a')) return
        ctx.openThread(t.id)
      } })
      var label = anchorLabel(t)
      if (label) card.appendChild(h('span.quote', label))
      t.messages.forEach(function (m) {
        card.appendChild(messageRow(t, m))
      })
      if (ctx.pendingAgent(t.id)) card.appendChild(h('div.typing', DX.avatar('Агент', 'agent', 20), h('span', 'Агент печатает'), h('span', h('i'), h('i'), h('i'))))
      var act = h('div.thread-act')
      if (ctx.canComment()) {
        act.appendChild(h('button.btn.sm.ghost', { type: 'button', onClick: function () { ctx.setStatus(t.id, t.status === 'open' ? 'resolved' : 'open') } }, DX.icon('circle-check'), h('span', t.status === 'open' ? 'Решено' : 'Открыть снова')))
        act.appendChild(h('span', { style: 'flex:1' }))
        act.appendChild(DX.ib('trash-2', 'Удалить тред', function (e) { e.stopPropagation(); ctx.removeThread(t) }, { tp: 'd' }))
      }
      card.appendChild(act)
      if (ctx.canComment() && t.status === 'open') {
        var comp = composers[t.id] || (composers[t.id] = DX.composer({ placeholder: 'Ответить…', label: 'Ответить', people: peopleNames, onSend: function (text) { return ctx.reply(t.id, text) } }))
        card.appendChild(comp)
      }
      return card
    }

    function messageRow(t, m) {
      var txt = h('div.txt')
      DX.textWithMentions(m.text, txt)
      var row = h('div.msg', DX.avatar(m.author.name, m.author.kind, 28), h('div.body', h('div.who', h('span', m.author.name), h('em', DX.ago(m.at))), txt))
      var body = row.querySelector('.body')
      var rx = h('div.rx')
      Object.keys(m.reactions || {}).forEach(function (emoji) {
        var who = m.reactions[emoji]
        rx.appendChild(h('button', { type: 'button', 'data-on': String(who.indexOf(ctx.me()) !== -1), 'data-tip': who.join(', '), onClick: function () { ctx.react(t.id, m.id, emoji) } }, emoji + ' ' + who.length))
      })
      if (ctx.canComment()) {
        rx.appendChild(h('button', { type: 'button', 'data-tip': 'Реакция', 'aria-label': 'Реакция', onClick: function (e) {
          DX.popover(e.currentTarget, function (close) {
            var box = h('div', { style: 'display:flex;gap:2px' })
            ;['👍', '❤️', '🎉', '👀', '✅'].forEach(function (emoji) {
              box.appendChild(h('button.ib', { type: 'button', onClick: function () { close(); ctx.react(t.id, m.id, emoji) } }, emoji))
            })
            return box
          }, { side: 'above' })
        } }, DX.icon('smile-plus')))
      }
      body.appendChild(rx)
      var edit = m.edit && (t.edits || []).filter(function (x) { return x.id === m.edit })[0]
      if (edit) body.appendChild(editCard(t, edit))
      return row
    }

    function editCard(t, edit) {
      var card = h('div.editcard', h('div', { style: 'font-weight:600;margin-bottom:4px' }, edit.undone ? 'Правка отменена' : 'Агент поправил текст'), h('del', clip(edit.before)), h('ins', clip(edit.after)))
      var row = h('div.row')
      row.appendChild(h('button.btn.sm.soft', { type: 'button', onClick: function () { ctx.showEdit(edit) } }, DX.icon('eye'), h('span', 'Показать в документе')))
      if (!edit.undone && ctx.canWrite()) row.appendChild(h('button.btn.sm.ghost', { type: 'button', onClick: function () { ctx.undoEdit(t, edit) } }, DX.icon('undo-2'), h('span', 'Отменить')))
      card.appendChild(row)
      return card
    }
    function clip(s) {
      s = String(s)
      return s.length > 240 ? s.slice(0, 240) + '…' : s
    }

    // ---- Chat ----

    var chatComposer = null
    function chatTab() {
      var body = h('div.rp-b')
      body.appendChild(h('div.hint', h('b', 'Спросите агента про документ'), 'Вопрос уйдёт в чат harnessly вместе с выделенным фрагментом. Ответ будет там; всё, что агент поправит в документе, появится здесь.'))
      var asked = ctx.asked()
      asked.slice(-6).forEach(function (a) {
        body.appendChild(h('div.msg', DX.avatar(ctx.me(), 'person', 28), h('div.body', h('div.who', h('span', ctx.me()), h('em', DX.ago(a.at))), h('div.txt', a.text))))
        body.appendChild(h('div.typing', { style: 'padding-left:36px' }, h('span', 'отправлено в чат harnessly')))
      })
      var edits = []
      ctx.threads().forEach(function (t) {
        ;(t.edits || []).forEach(function (e) { edits.push({ t: t, e: e }) })
      })
      edits.sort(function (a, b) { return a.e.at < b.e.at ? 1 : -1 }).slice(0, 6).forEach(function (x) {
        var card = editCard(x.t, x.e)
        card.style.margin = '0'
        body.appendChild(card)
      })
      el.appendChild(body)
      var foot = h('div.rp-f')
      var sel = ctx.chip()
      var chip = null
      if (sel) chip = h('div.selchip', DX.icon('text-quote'), h('span', sel), h('button', { type: 'button', 'aria-label': 'Убрать фрагмент', onClick: function () { ctx.dropChip(); ctrl.render() } }, DX.icon('x')))
      chatComposer = DX.composer({ placeholder: 'Спросите про документ или попросите поправить…', label: 'Спросить', chip: chip, people: peopleNames, onSend: function (text) { return ctx.ask2(text) } })
      foot.appendChild(chatComposer)
      el.appendChild(foot)
    }

    ctrl.focusChat = function () {
      if (chatComposer) chatComposer.focusField()
    }
    ctrl.forget = function (id) { delete composers[id] }
    return ctrl
  }
})()
