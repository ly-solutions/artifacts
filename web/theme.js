// Applies the saved theme before first paint. Kept separate so the UI's CSP needs no inline script.
;(function () {
  try {
    var params = new URLSearchParams(location.search)
    var theme = params.get('theme') || localStorage.getItem('artifacts-theme')
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
  } catch (error) {
    /* storage can be blocked; the system theme applies */
  }
})()
