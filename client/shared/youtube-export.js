/**
 * YouTube chapter export — форматирование маркеров в формат YouTube-описания.
 * Заимствовано из openshorts/thumbnail.py:276 (generate_youtube_description).
 *
 * YouTube требует:
 *   - первый маркер на 0:00 (иначе главы не активируются)
 *   - минимум 3 главы (иначе плеер не разбивает таймлайн)
 *   - min-interval 10с между главами (за это отвечает chapterize, не мы)
 *
 * Чистая функция — никакого DOM, тестируется в node.
 */
(function (global) {
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTimestamp(timeSec) {
    var t = Math.max(0, Math.floor(timeSec || 0));
    var h = Math.floor(t / 3600);
    var mm = Math.floor((t % 3600) / 60);
    var ss = t % 60;
    return h > 0 ? (h + ':' + pad2(mm) + ':' + pad2(ss)) : (mm + ':' + pad2(ss));
  }

  /**
   * markers: [{timeSec, name, ...}] (сортировка не обязательна)
   * Возвращает строку «M:SS Название\n…», готовую для вставки в YouTube-описание.
   * Пустой массив → пустая строка.
   */
  function formatChaptersForYouTube(markers) {
    if (!Array.isArray(markers) || !markers.length) return '';
    var sorted = markers.slice().sort(function (a, b) {
      return (a.timeSec || 0) - (b.timeSec || 0);
    });
    /* Гарантируем первую главу на 0:00. */
    if ((sorted[0].timeSec || 0) > 0.5) {
      sorted.unshift({ timeSec: 0, name: 'Вступление' });
    } else {
      sorted[0] = Object.assign({}, sorted[0], { timeSec: 0 });
    }
    var lines = sorted.map(function (m) {
      var stamp = formatTimestamp(m.timeSec);
      var name = String(m.name || '').trim() || 'Глава';
      return stamp + ' ' + name;
    });
    return lines.join('\n');
  }

  var api = {
    formatChaptersForYouTube: formatChaptersForYouTube,
    formatTimestamp: formatTimestamp
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.YouTubeExport = api;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
