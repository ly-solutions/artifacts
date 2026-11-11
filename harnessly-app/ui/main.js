// The home of the app: the latest documents the person may read, through the app's own MCP server.
(function () {
  var note = document.getElementById('note');
  var list = document.getElementById('list');

  function show(items) {
    list.textContent = '';
    if (!items.length) {
      note.textContent = 'Документов пока нет — попросите агента написать первый.';
      return;
    }
    note.textContent = '';
    items.forEach(function (d) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = d.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = d.title || d.slug;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  window.harnessly.connect({ protocol: 2 }).then(function (hl) {
    return hl.tools.call('docs.doc_find', { limit: 20 }).then(function (res) {
      if (hl.refused(res) || !res || res.isError) throw new Error('refused');
      var data = res.structuredContent || JSON.parse((res.content || [])[0].text);
      show((data.items || []).filter(function (d) { return /^https?:\/\//.test(d.url || ''); }));
    });
  }).catch(function () {
    note.textContent = 'Сервис документов сейчас не отвечает. Документы и ссылки на них на месте — попробуйте позже.';
  });
})();
