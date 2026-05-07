/**
 * Статус выполнения (запрос к FM, инструменты Premiere).
 *
 * MEDIUM #12 (6 мая 2026): добавлен progress API для long-running операций
 * (transcribe, analyze, multicam) — раньше юзер видел только текст «идёт обработка»
 * без индикации насколько готово/завис ли.
 *
 * API:
 *   show(message, withSpinner=true)        — текст + опциональный spinner
 *   progress(percent|null, message?)        — прогресс 0..100, null = indeterminate
 *   hide()                                  — скрыть всё
 */
(function (global) {
  global.PanelUIStatus = {
    create: function (rootId) {
      var root = document.getElementById(rootId);
      if (!root) {
        return { show: function () {}, hide: function () {}, progress: function () {} };
      }
      var textEl = root.querySelector('.status-text');
      var spinEl = root.querySelector('.status-spinner');
      var progEl = root.querySelector('.status-progress');
      var fillEl = root.querySelector('.status-progress-fill');
      return {
        show: function (message, withSpinner) {
          root.hidden = false;
          if (textEl) textEl.textContent = message || '';
          if (spinEl) {
            spinEl.style.display = withSpinner === false ? 'none' : 'block';
          }
          /* Скрываем progress если вызывают show() без явного progress() — */
          if (progEl) progEl.hidden = true;
        },
        progress: function (percent, message) {
          root.hidden = false;
          if (typeof message === 'string' && textEl) textEl.textContent = message;
          if (!progEl || !fillEl) return;
          progEl.hidden = false;
          if (percent === null || percent === undefined) {
            /* indeterminate — анимированная полоса без точного значения */
            progEl.classList.add('status-progress--indeterminate');
            progEl.removeAttribute('aria-valuenow');
          } else {
            var pct = Math.max(0, Math.min(100, Math.round(percent)));
            progEl.classList.remove('status-progress--indeterminate');
            fillEl.style.width = pct + '%';
            progEl.setAttribute('aria-valuenow', String(pct));
          }
        },
        hide: function () {
          root.hidden = true;
          if (textEl) textEl.textContent = '';
          if (progEl) {
            progEl.hidden = true;
            progEl.classList.remove('status-progress--indeterminate');
            progEl.removeAttribute('aria-valuenow');
          }
          if (fillEl) fillEl.style.width = '0%';
        }
      };
    }
  };
})(window);
