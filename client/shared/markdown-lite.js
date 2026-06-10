/**
 * MarkdownLite — минимальный безопасный рендер markdown для пузырей чата.
 *
 * Принцип безопасности: СНАЧАЛА экранируем весь HTML, ПОТОМ накладываем
 * ограниченный набор тегов поверх уже-безопасного текста. Никакой пользовательский
 * или модельный ввод не попадает в DOM как сырой HTML.
 *
 * Поддержано (ровно то, что реально генерирует GLM/DeepSeek в ответах):
 *   **жирный**, *курсив*, `код`, ```блок кода```, заголовки #/##/###,
 *   списки («-», «*», «1.»), переводы строк.
 * НЕ поддержано намеренно: ссылки/изображения (XSS-поверхность, в CEP не нужны),
 * таблицы, вложенные списки.
 *
 * UI-волна (10 июня 2026), аудит 2026-06-09: «ответы ассистента — сплошная
 * простыня textContent, модель пишет **bold** и списки, пользователь видит звёздочки».
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Инлайн-разметка ВНУТРИ уже экранированной строки. */
  function inline(s) {
    /* `код` — первым, чтобы ** внутри кода не превращался в <b> */
    s = s.replace(/`([^`\n]+)`/g, function (m, code) {
      return '<code class="md-code">' + code + '</code>';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    /* *курсив* — не трогаем одиночные звёздочки в формулах вида 2*3 */
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    return s;
  }

  /**
   * render(text) → HTML-строка (безопасная для innerHTML).
   */
  function render(text) {
    if (text === null || text === undefined) return '';
    var src = String(text);

    /* 1. Вырезаем fenced-блоки ДО экранирования построчно, чтобы внутри
       блока не сработали списки/заголовки. */
    var parts = src.split(/```/);
    var out = [];
    for (var p = 0; p < parts.length; p++) {
      if (p % 2 === 1) {
        /* Внутри ``` ``` — первый токен может быть именем языка, отбрасываем его строку */
        var body = parts[p].replace(/^[a-zA-Z0-9_-]*\n/, '');
        out.push('<pre class="md-pre">' + escapeHtml(body.replace(/\n$/, '')) + '</pre>');
        continue;
      }
      out.push(renderBlock(parts[p]));
    }
    return out.join('');
  }

  function renderBlock(chunk) {
    var lines = chunk.split('\n');
    var html = [];
    var inList = false;

    function closeList() {
      if (inList) { html.push('</ul>'); inList = false; }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = escapeHtml(raw);
      var mH = /^(#{1,3})\s+(.*)$/.exec(line);
      var mLi = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);

      if (mH) {
        closeList();
        var lvl = mH[1].length; /* h1→.md-h1 и т.д., реальные h-теги ломают размер в пузыре */
        html.push('<div class="md-h md-h' + lvl + '">' + inline(mH[2]) + '</div>');
      } else if (mLi) {
        if (!inList) { html.push('<ul class="md-ul">'); inList = true; }
        html.push('<li>' + inline(mLi[1]) + '</li>');
      } else if (/^\s*$/.test(line)) {
        closeList();
        /* Пустая строка → межабзацный отступ (не плодим <br> на каждый \n\n) */
        if (html.length && html[html.length - 1] !== '<div class="md-gap"></div>') {
          html.push('<div class="md-gap"></div>');
        }
      } else {
        closeList();
        html.push('<div class="md-line">' + inline(line) + '</div>');
      }
    }
    closeList();
    return html.join('');
  }

  global.MarkdownLite = { render: render, escapeHtml: escapeHtml };
})(window);
