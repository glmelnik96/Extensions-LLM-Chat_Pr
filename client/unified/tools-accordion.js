/* Аккордеон групп вкладки «Инструменты» + спойлеры «⚙ Тонкая настройка»
   + авто-раскрытие группы при показе proposal/статуса (UI-переработка 28.07.2026).
   Логика инструментов живёт в panel.js и не знает про группы: здесь только
   показ/скрытие контейнеров. ES5 (CEP-Chromium). Грузится ПОСЛЕ panel.js. */
(function () {
  'use strict';
  var GROUP_KEY = 'extllmpr_v1_tools_group';
  var ADV_PREFIX = 'extllmpr_v1_adv_';
  var GROUP_ALL_CLOSED = '__none__';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  /* Перерисовка waveform после раскрытия: в скрытом контейнере canvas имел
     нулевую ширину. Функцию экспортирует panel.js (переопределяется на reload). */
  function notifyReveal() {
    if (typeof window.__omcToolsWaveformReveal === 'function') {
      try { window.__omcToolsWaveformReveal(); } catch (e) {}
    }
  }

  var groups = document.querySelectorAll('.tools-group');

  function openGroup(name, persist) {
    var found = false;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].getAttribute('data-group') === name) {
        groups[i].classList.add('open');
        found = true;
      } else {
        groups[i].classList.remove('open');
      }
    }
    if (found) {
      if (persist) lsSet(GROUP_KEY, name);
      notifyReveal();
    }
    return found;
  }

  function closeAll(persist) {
    for (var i = 0; i < groups.length; i++) groups[i].classList.remove('open');
    if (persist) lsSet(GROUP_KEY, GROUP_ALL_CLOSED);
  }

  /* Авто-раскрытие: elId — id карточки или любого элемента внутри неё
     (например 'proposal-silences'). Если группа карточки свёрнута — раскрыть,
     чтобы proposal/ошибка/статус не потерялись с глаз. */
  window.toolsRevealCard = function (elId) {
    var el = document.getElementById(elId);
    if (!el) return;
    var g = el;
    while (g && g !== document.body) {
      if (g.classList && g.classList.contains('tools-group')) break;
      g = g.parentNode;
    }
    if (!g || g === document.body || !g.classList || !g.classList.contains('tools-group')) return;
    if (!g.classList.contains('open')) openGroup(g.getAttribute('data-group'), true);
  };

  /* Клик по заголовку: открытая группа сворачивается (все закрыты — допустимо),
     закрытая — открывается, прежняя сворачивается. */
  for (var gi = 0; gi < groups.length; gi++) {
    (function (g) {
      var head = g.querySelector('.tools-group-head');
      if (!head) return;
      head.onclick = function () {
        if (g.classList.contains('open')) closeAll(true);
        else openGroup(g.getAttribute('data-group'), true);
      };
    })(groups[gi]);
  }

  /* Начальное состояние: последняя открытая группа; дефолт — «Чистка речи».
     Сохранённая группа могла исчезнуть из разметки — тогда тоже дефолт. */
  var saved = lsGet(GROUP_KEY);
  if (saved === GROUP_ALL_CLOSED) closeAll(false);
  else if (!openGroup(saved || 'cleanup', false)) openGroup('cleanup', false);

  /* Спойлеры «⚙ Тонкая настройка»: native <details>, персистентность per-карточка. */
  var advs = document.querySelectorAll('details.tool-advanced[data-adv]');
  for (var ai = 0; ai < advs.length; ai++) {
    (function (d) {
      var key = ADV_PREFIX + d.getAttribute('data-adv');
      if (lsGet(key) === '1') d.open = true;
      d.addEventListener('toggle', function () {
        lsSet(key, d.open ? '1' : '0');
        if (d.open) notifyReveal();
      });
    })(advs[ai]);
  }
})();
