// Progressive enhancement for the catalog and the reader. Every page works without it.
;(function () {
  'use strict'

  var root = document.documentElement
  var frame = document.querySelector('[data-content-frame]')

  // ---- theme ------------------------------------------------------------------
  function currentTheme() {
    return root.getAttribute('data-theme') || 'auto'
  }
  function applyTheme(theme) {
    if (theme === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try {
      if (theme === 'auto') localStorage.removeItem('artifacts-theme')
      else localStorage.setItem('artifacts-theme', theme)
    } catch (error) {
      /* storage blocked: the theme still applies to this page */
    }
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.title = 'Theme: ' + theme
    })
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'artifacts:theme', theme: theme }, '*')
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
    button.title = 'Theme: ' + currentTheme()
    button.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark']
      applyTheme(order[(order.indexOf(currentTheme()) + 1) % order.length])
    })
  })
  if (frame) {
    frame.addEventListener('load', function () {
      if (currentTheme() !== 'auto') frame.contentWindow.postMessage({ type: 'artifacts:theme', theme: currentTheme() }, '*')
    })
  }

  // ---- embedding ----------------------------------------------------------------
  var authRequired = document.querySelector('[data-auth-required]')
  if (authRequired && window.parent !== window) {
    window.parent.postMessage({ type: 'artifacts:auth-required', loginUrl: authRequired.getAttribute('data-login-url') }, '*')
  }
  if (window.parent !== window) {
    window.addEventListener('message', function (event) {
      var m = event.data
      if (event.source === window.parent && m && m.type === 'artifacts:theme' && ['auto', 'light', 'dark'].indexOf(m.theme) !== -1) applyTheme(m.theme)
    })
  }

  // ---- relative dates ---------------------------------------------------------
  var rtf = window.Intl && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null
  function relative(iso) {
    var then = new Date(iso).getTime()
    if (!rtf || isNaN(then)) return null
    var seconds = (then - Date.now()) / 1000
    var units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(seconds) >= units[i][1]) return rtf.format(Math.round(seconds / units[i][1]), units[i][0])
    }
    return 'just now'
  }
  function formatDates(scope) {
    scope.querySelectorAll('time[data-rel]').forEach(function (el) {
      var text = relative(el.getAttribute('datetime'))
      if (text) {
        el.title = new Date(el.getAttribute('datetime')).toLocaleString()
        el.textContent = text
      }
    })
  }
  formatDates(document)

  // ---- live search ------------------------------------------------------------
  var form = document.querySelector('[data-live-search]')
  var results = document.getElementById('results')
  if (form && results) {
    var timer = null
    var seq = 0
    form.addEventListener('input', function () {
      clearTimeout(timer)
      timer = setTimeout(function () {
        var params = new URLSearchParams(new FormData(form))
        var url = '/?' + params.toString()
        var mine = ++seq
        fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'partial=1', { headers: { accept: 'text/html' } })
          .then(function (response) {
            return response.ok ? response.text() : Promise.reject(response.status)
          })
          .then(function (html) {
            if (mine !== seq) return
            results.innerHTML = html
            formatDates(results)
            history.replaceState(null, '', params.get('q') || params.getAll('tag').length ? url : '/')
          })
          .catch(function () {})
      }, 180)
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && document.activeElement === document.body) {
        event.preventDefault()
        form.querySelector('input[type=search]').focus()
      }
    })
  }

  // ---- reader -----------------------------------------------------------------
  var reader = document.querySelector('.reader')
  if (!reader) return
  var slug = reader.getAttribute('data-slug')

  var versionSelect = document.querySelector('[data-version-select]')
  if (versionSelect && frame) {
    versionSelect.addEventListener('change', function () {
      var n = versionSelect.value
      var url = new URL(location.href)
      url.searchParams.set('v', n)
      location.assign(url.toString())
    })
  }

  document.querySelectorAll('[data-open]').forEach(function (button) {
    button.addEventListener('click', function () {
      var dialog = document.getElementById(button.getAttribute('data-open'))
      if (dialog && dialog.showModal) dialog.showModal()
    })
  })

  function api(method, path, body) {
    return fetch('/api/v1/artifacts/' + encodeURIComponent(slug) + path, {
      method: method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error((data.problems && data.problems.join('; ')) || data.hint || data.error || 'request failed')
        return data
      })
    })
  }

  var shareForm = document.querySelector('[data-share-form]')
  if (shareForm) {
    var status = shareForm.querySelector('[data-share-status]')
    var result = shareForm.querySelector('[data-share-result]')
    var urlInput = shareForm.querySelector('[data-share-url]')
    var unshare = shareForm.querySelector('[data-unshare]')
    shareForm.querySelector('[data-share]').addEventListener('click', function () {
      status.className = 'status'
      status.textContent = 'Creating a link…'
      var expiresIn = shareForm.elements.expiresIn.value
      api('POST', '/share', expiresIn ? { expiresIn: expiresIn } : {})
        .then(function (data) {
          result.hidden = false
          urlInput.value = data.url
          urlInput.select()
          unshare.hidden = false
          status.textContent = data.expiresAt ? 'Link works until ' + new Date(data.expiresAt).toLocaleString() + '.' : 'Link does not expire.'
        })
        .catch(function (error) {
          status.className = 'status error'
          status.textContent = error.message
        })
    })
    shareForm.querySelector('[data-copy]').addEventListener('click', function () {
      urlInput.select()
      if (navigator.clipboard) navigator.clipboard.writeText(urlInput.value)
      status.textContent = 'Copied.'
    })
    unshare.addEventListener('click', function () {
      api('DELETE', '/share')
        .then(function () {
          result.hidden = true
          unshare.hidden = true
          status.className = 'status'
          status.textContent = 'Sharing is off. Every link issued before has stopped working.'
        })
        .catch(function (error) {
          status.className = 'status error'
          status.textContent = error.message
        })
    })
  }

  var editForm = document.querySelector('[data-edit-form]')
  if (editForm) {
    editForm.addEventListener('submit', function (event) {
      event.preventDefault()
      var status = editForm.querySelector('[data-edit-status]')
      var f = editForm.elements
      var body = {
        title: f.title.value,
        description: f.description.value,
        tags: f.tags.value,
        task: f.task.value.trim() || null,
        link: f.link.value.trim() || null,
      }
      status.className = 'status'
      status.textContent = 'Saving…'
      api('PATCH', '', body)
        .then(function () {
          location.reload()
        })
        .catch(function (error) {
          status.className = 'status error'
          status.textContent = error.message
        })
    })
  }

  if (window.parent !== window) {
    window.parent.postMessage({ type: 'artifacts:ready', slug: slug, version: Number(reader.getAttribute('data-version')) }, '*')
  }
})()
