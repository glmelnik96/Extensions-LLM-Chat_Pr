/**
 * UI для Conversation Starters: рендер карточек, диалог создания/редактирования.
 *
 * Зависит от: ConversationStarters (conversation-starters.js)
 *
 * Использование в panel.js:
 *   StartersUI.init(panelId, {
 *     container: document.getElementById('starters-container'),
 *     onUse: function(starter) { ... },        // вставить промпт в чат
 *     onSystemAddon: function(addon) { ... }    // дополнить system prompt
 *   });
 */
(function (global) {
  /* ── helpers ──────────────────────────────────────────────────────── */

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  /* ── подсказки в полях диалога (зависят от пресета) ─────────────── */

  var PLACEHOLDERS = {
    timecode: {
      name: 'Например: Подчистить хвосты',
      description: 'Что делает стартер (короткая фраза для карточки)',
      userPrompt:
        'Например: Покажи все клипы и обрежь у каждого пустой хвост, если в конце нет содержимого',
      systemPromptAddon:
        'Доп. правила для агента таймкодов. Например:\n' +
        '— Перед каждой правкой делай get_timeline_snapshot, не доверяй устаревшему nodeId.\n' +
        '— Не используй remove_clip для удаления части клипа — только ripple_delete_range.\n' +
        '— Если клип короче 0.5 сек, не трогай его.'
    },
    textmontage: {
      name: 'Например: Чистка пауз',
      description: 'Что делает стартер (короткая фраза для карточки)',
      userPrompt:
        'Например: Удали все паузы длиннее 0.6 секунды и слова-паразиты (эээ, ну, как бы)',
      systemPromptAddon:
        'Доп. правила для агента монтажа по тексту. Например:\n' +
        '— Никогда не вырезай выводы и финальные тезисы.\n' +
        '— Между фразами оставляй минимум 0.2 сек воздуха.\n' +
        '— Для коротких роликов (< 30с) ничего не режь, только предложи план.\n' +
        '— Всегда заполняй keepSummary и removeSummary с цитатами по 10–25 слов.'
    },
    markers: {
      name: 'Например: Маркеры на цифры и факты',
      description: 'Что делает стартер (короткая фраза для карточки)',
      userPrompt:
        'Например: Поставь маркеры (type=comment) на все упоминания цифр, дат и имён собственных. Имя маркера — короткая суть фразы 3–5 слов',
      systemPromptAddon:
        'Доп. правила для агента маркеров. Например:\n' +
        '— Между маркерами одного типа держи минимум 5 секунд.\n' +
        '— Имена маркеров — без точек в конце, без эмодзи, 3–5 слов.\n' +
        '— Для type=chapter добавляй endSec следующей главы (даже если PP не покажет диапазон, он попадёт в comments).\n' +
        '— Если в транскрипте меньше 3-х смысловых блоков, не ставь chapter-маркеры, только comment.'
    }
  };

  function placeholdersFor(panelId) {
    return PLACEHOLDERS[panelId] || PLACEHOLDERS.textmontage;
  }

  /* ── диалог ──────────────────────────────────────────────────────── */

  function createOverlay() {
    var ov = el('div', 'starters-overlay');
    ov.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);' +
      'display:flex;align-items:center;justify-content:center;z-index:9999;';
    return ov;
  }

  /**
   * Показать диалог создания/редактирования стартера.
   * @param {object|null} existing  null — создание, объект — редактирование
   * @param {function} onSave(data)
   * @param {function} onCancel
   * @param {string}   panelId  чтобы подсказки в полях зависели от пресета
   */
  function showDialog(existing, onSave, onCancel, panelId) {
    var isEdit = !!existing;
    var ph = placeholdersFor(panelId || (existing && existing.panelId));
    var ov = createOverlay();

    var box = el('div', 'starters-dialog');
    box.style.cssText =
      'background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:16px 20px;' +
      'width:440px;max-width:94vw;max-height:88vh;overflow-y:auto;color:#e8e8e8;font-size:13px;';

    box.innerHTML = [
      '<h3 style="margin:0 0 12px;font-size:15px;">' + (isEdit ? 'Редактировать стартер' : 'Новый стартер') + '</h3>',
      '<label class="starters-lbl">Название</label>',
      '<input type="text" class="starters-inp" id="sd-name" maxlength="80" placeholder="' + esc(ph.name) + '" value="' + esc(existing ? existing.name : '') + '" />',
      '<label class="starters-lbl">Описание (необязательно)</label>',
      '<input type="text" class="starters-inp" id="sd-desc" maxlength="200" placeholder="' + esc(ph.description) + '" value="' + esc(existing ? existing.description || '' : '') + '" />',
      '<label class="starters-lbl">Промпт (текст, который отправится в чат)</label>',
      '<textarea class="starters-inp starters-ta" id="sd-prompt" maxlength="4000" rows="3" placeholder="' + esc(ph.userPrompt) + '">' + esc(existing ? existing.userPrompt : '') + '</textarea>',
      '<label class="starters-lbl">Системный промпт-дополнение (необязательно, для продвинутых)</label>',
      '<textarea class="starters-inp starters-ta" id="sd-sys" maxlength="8000" rows="6" placeholder="' + esc(ph.systemPromptAddon) + '">' + esc(existing ? existing.systemPromptAddon || '' : '') + '</textarea>',
      '<div class="starters-err" id="sd-err"></div>',
      '<div class="starters-dialog-btns">',
      '  <button type="button" class="secondary" id="sd-cancel">Отмена</button>',
      '  <button type="button" id="sd-save">' + (isEdit ? 'Сохранить' : 'Создать') + '</button>',
      '</div>'
    ].join('');

    ov.appendChild(box);
    document.body.appendChild(ov);

    var inpName = box.querySelector('#sd-name');
    var inpDesc = box.querySelector('#sd-desc');
    var inpPrompt = box.querySelector('#sd-prompt');
    var inpSys = box.querySelector('#sd-sys');
    var errEl = box.querySelector('#sd-err');

    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }

    box.querySelector('#sd-cancel').onclick = function () {
      close();
      if (onCancel) onCancel();
    };

    ov.onclick = function (e) {
      if (e.target === ov) {
        close();
        if (onCancel) onCancel();
      }
    };

    box.querySelector('#sd-save').onclick = function () {
      var data = {
        name: inpName.value.trim(),
        description: inpDesc.value.trim(),
        userPrompt: inpPrompt.value.trim(),
        systemPromptAddon: inpSys.value.trim() || null
      };
      var err = ConversationStarters.validate(data);
      if (err) {
        errEl.textContent = err;
        return;
      }
      close();
      onSave(data);
    };

    setTimeout(function () { inpName.focus(); }, 60);
  }

  /* ── рендер карточек ─────────────────────────────────────────────── */

  function renderCards(panelId, container, callbacks) {
    container.innerHTML = '';
    var starters = ConversationStarters.getAll(panelId);
    if (!starters.length) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';

    /* кнопка «+» для добавления нового */
    var addBtn = el('button', 'starter-add-btn', '+');
    addBtn.title = 'Создать свой стартер';
    addBtn.type = 'button';
    addBtn.onclick = function () {
      showDialog(null, function (data) {
        var res = ConversationStarters.add(panelId, data);
        if (!res.ok) {
          if (callbacks.onError) callbacks.onError(res.error);
          return;
        }
        renderCards(panelId, container, callbacks);
      }, null, panelId);
    };
    container.appendChild(addBtn);

    starters.forEach(function (s) {
      var card = el('div', 'starter-card');
      card.title = s.description ? (s.name + ' — ' + s.description) : s.userPrompt;

      var nameSpan = el('span', 'starter-card-name', esc(s.name));
      card.appendChild(nameSpan);

      /* Кнопка использовать */
      card.onclick = function (e) {
        if (e.target.classList.contains('starter-edit-btn') || e.target.classList.contains('starter-del-btn')) return;
        if (callbacks.onUse) callbacks.onUse(s);
        if (s.systemPromptAddon && callbacks.onSystemAddon) callbacks.onSystemAddon(s.systemPromptAddon);
      };

      /* Кнопки управления (только для пользовательских) */
      if (!s.builtin) {
        var acts = el('span', 'starter-card-actions');

        var editBtn = el('button', 'starter-edit-btn', '&#9998;');
        editBtn.title = 'Редактировать';
        editBtn.type = 'button';
        editBtn.onclick = function (e) {
          e.stopPropagation();
          showDialog(s, function (data) {
            var res = ConversationStarters.update(panelId, s.id, data);
            if (!res.ok) {
              if (callbacks.onError) callbacks.onError(res.error);
              return;
            }
            renderCards(panelId, container, callbacks);
          }, null, panelId);
        };
        acts.appendChild(editBtn);

        var delBtn = el('button', 'starter-del-btn', '&times;');
        delBtn.title = 'Удалить';
        delBtn.type = 'button';
        delBtn.onclick = function (e) {
          e.stopPropagation();
          ConversationStarters.remove(panelId, s.id);
          renderCards(panelId, container, callbacks);
        };
        acts.appendChild(delBtn);

        card.appendChild(acts);
      }

      container.appendChild(card);
    });
  }

  /* ── публичный API ───────────────────────────────────────────────── */

  global.StartersUI = {
    /**
     * Инициализировать UI стартеров.
     * @param {string} panelId
     * @param {object} opts  { container, onUse(starter), onSystemAddon?(addon), onError?(msg) }
     */
    init: function (panelId, opts) {
      if (!opts.container) return;
      renderCards(panelId, opts.container, opts);
    },

    /** Перерендерить (после внешних изменений). */
    refresh: function (panelId, opts) {
      if (!opts.container) return;
      renderCards(panelId, opts.container, opts);
    },

    /** Показать диалог создания/редактирования (можно вызвать напрямую). */
    showDialog: showDialog
  };
})(window);
