/**
 * Статус выполнения (запрос к FM, инструменты Premiere).
 */
(function (global) {
  global.PanelUIStatus = {
    create: function (rootId) {
      var root = document.getElementById(rootId);
      if (!root) {
        return { show: function () {}, hide: function () {} };
      }
      var textEl = root.querySelector('.status-text');
      var spinEl = root.querySelector('.status-spinner');
      return {
        show: function (message, withSpinner) {
          root.hidden = false;
          if (textEl) textEl.textContent = message || '';
          if (spinEl) {
            spinEl.style.display = withSpinner === false ? 'none' : 'block';
          }
        },
        hide: function () {
          root.hidden = true;
          if (textEl) textEl.textContent = '';
        }
      };
    }
  };
})(window);
