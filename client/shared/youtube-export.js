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

  /**
   * MEDIUM (6 мая 2026, audit fix): валидация требований YouTube для разметки глав.
   * Возвращает массив warning'ов (пустой = всё ок).
   * YouTube требования:
   *   • Минимум 3 главы — иначе плеер не показывает разметку.
   *   • Первый таймкод обязан быть 0:00.
   *   • Между главами минимум 10 секунд.
   *   • Каждая глава длится не менее 10 секунд.
   * Эти правила НЕ блокируют формирование строки — пусть пользователь
   * скопирует, но мы предупреждаем заранее чтобы не удивлялся «почему YouTube
   * проигнорировал». Использовать рядом с formatChaptersForYouTube в UI.
   */
  function validateForYouTube(markers) {
    var warns = [];
    if (!Array.isArray(markers)) {
      warns.push('markers должен быть массивом');
      return warns;
    }
    if (markers.length < 3) {
      warns.push('YouTube требует ≥3 глав для активации разметки. Сейчас: ' + markers.length + '.');
    }
    if (markers.length > 0) {
      var sorted = markers.slice().sort(function (a, b) { return (a.timeSec || 0) - (b.timeSec || 0); });
      if ((sorted[0].timeSec || 0) > 0.5) {
        warns.push('Первая глава не на 0:00 (текущая: ' + (sorted[0].timeSec || 0).toFixed(1) + 'с). YouTube не активирует разметку без главы на 0:00.');
      }
      for (var i = 1; i < sorted.length; i++) {
        var gap = (sorted[i].timeSec || 0) - (sorted[i - 1].timeSec || 0);
        if (gap < 10) {
          warns.push('Главы ' + i + ' и ' + (i + 1) + ' ближе 10с друг к другу (' + gap.toFixed(1) + 'с). YouTube требует мин. 10с.');
          break; /* одного предупреждения хватит — пользователь поймёт что нужно проверить все */
        }
      }
    }
    return warns;
  }

  var api = {
    formatChaptersForYouTube: formatChaptersForYouTube,
    formatTimestamp: formatTimestamp,
    validateForYouTube: validateForYouTube
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.YouTubeExport = api;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
