/**
 * Диагностика загрузки CEP-панели: видимое сообщение при падении скрипта (иначе «пустое» окно).
 */
(function (global) {
  function showFatal(title, err) {
    var t = String(title || 'Панель');
    var m = '';
    if (err && err.message) m = String(err.message);
    else if (err) m = String(err);
    try {
      console.error('[PanelBoot]', t, err);
    } catch (e) {}
    var root = document.querySelector('.app') || document.body;
    if (!root) return;
    var div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.style.cssText =
      'margin:10px;padding:10px;border:1px solid #a44;border-radius:6px;background:#2a1818;color:#fcc;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;';
    div.textContent = t + (m ? '\n\n' + m : '');
    root.insertBefore(div, root.firstChild);
  }

  function run(panelLabel, initFn) {
    function go() {
      try {
        if (typeof initFn !== 'function') return;
        initFn();
      } catch (e) {
        showFatal(panelLabel + ': ошибка инициализации', e);
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', go);
    } else {
      go();
    }
  }

  if (!global.__LLMPR_PANEL_ERR__) {
    global.__LLMPR_PANEL_ERR__ = true;
    window.addEventListener('error', function (ev) {
      if (!ev) return;
      var err = ev.error || ev.message;
      if (err) showFatal('Ошибка скрипта', err);
    });
  }

  global.PanelBoot = { run: run, showFatal: showFatal };
})(window);
