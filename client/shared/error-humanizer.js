/**
 * Человеко-читаемые ошибки (Волна 2 п.1 плана усиления, 2026-07-10).
 * Каталог: сетевые коды, HTTP-статусы Cloud.ru, ffmpeg, Whisper — как у
 * PremiereGPT (teardown §5.1), но под наш локальный стек (Cloud.ru + ffmpeg).
 * Контракт совместим со старым panel._classifyError: classify(err) → {kind, hint}.
 * kind: cancel | auth | model | payload | quota | server | tls | network |
 *       ffmpeg | media | other.
 */
(function (global) {
  /* Первый матч побеждает. Порядок: cancel → специфичные HTTP-статусы →
     TLS → сеть по кодам → ffmpeg/медиа → generic network. */
  var RULES = [
    {
      kind: 'cancel',
      re: /abort|cancel|остановлен/i,
      hint: 'Операция отменена пользователем.'
    },
    {
      kind: 'auth',
      re: /\b401\b|unauthorized|invalid[ _-]?api|api[ -]?key|неверный ключ/i,
      hint: 'Похоже, неверный API-ключ Cloud.ru. Проверьте ключ (client/shared/fm-secrets.js) — он мог истечь.'
    },
    {
      kind: 'auth',
      re: /\b403\b|forbidden/i,
      hint: 'Доступ запрещён (403): у ключа нет прав на эту модель/проект Cloud.ru. Проверьте тариф и права ключа.'
    },
    {
      kind: 'model',
      re: /\b404\b|model.{0,20}not found|not found.{0,20}model|no such model|does not exist/i,
      hint: 'Модель недоступна (404): проверьте имена моделей в fm-defaults.js — список моделей Cloud.ru периодически меняется.'
    },
    {
      kind: 'payload',
      re: /\b413\b|payload too large|entity too large|request.{0,10}too large/i,
      hint: 'Файл слишком большой для загрузки (лимит Whisper ~25MB): уменьшите transcribeExportChunkSec в fm-defaults.js или переключите exportChunkExtension на mp3.'
    },
    {
      kind: 'quota',
      re: /\b429\b|rate limit|quota|exceed/i,
      hint: 'Превышены лимиты API Cloud.ru. Панель ждёт Retry-After автоматически; если повторяется — подождите минуту.'
    },
    {
      kind: 'server',
      re: /\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time.?out/i,
      hint: 'Ошибка на стороне Cloud.ru (5xx). Обычно временная — повторите через минуту.'
    },
    {
      kind: 'tls',
      re: /self.?signed|certificat|cert_|\bssl\b|\btls\b/i,
      hint: 'Проблема с сертификатом (TLS): похоже на корпоративный прокси/VPN с TLS-инспекцией. Добавьте *.cloud.ru в исключения или проверьте системные сертификаты.'
    },
    {
      kind: 'network',
      re: /enotfound|eai_again|getaddrinfo|err_name_not_resolved/i,
      hint: 'Адрес API не резолвится (DNS): проверьте baseUrl в fm-defaults.js, интернет и VPN.'
    },
    {
      kind: 'network',
      re: /etimedout|timed?.?out|timeout/i,
      hint: 'Таймаут соединения: медленная сеть или файрвол. Проверьте VPN и нажмите «Повторить».'
    },
    {
      kind: 'network',
      re: /econnreset|econnrefused|eaccess|eacces|socket hang up|err_connection/i,
      hint: 'Соединение сброшено или отклонено: проверьте интернет/VPN/файрвол (нужен доступ к *.cloud.ru).'
    },
    {
      kind: 'ffmpeg',
      re: /ffmpeg.{0,40}(enoent|not found|не найден)|(enoent|not found|не найден).{0,40}ffmpeg/i,
      hint: 'Не найден ffmpeg: установите его (Windows: winget install ffmpeg; macOS: brew install ffmpeg) и перезапустите Premiere.'
    },
    {
      kind: 'ffmpeg',
      re: /ffmpeg|пустой чанк/i,
      hint: 'ffmpeg не смог обработать медиа: проверьте, что исходные файлы онлайн (не offline-медиа) и формат поддерживается.'
    },
    {
      kind: 'media',
      re: /пуст(ой|ые|ая).{0,30}(транскрипт|сегмент)|транскрипт.{0,20}пуст/i,
      hint: 'Whisper не услышал речь: проверьте, что в In–Out есть аудио с речью и дорожки не замьючены.'
    },
    {
      kind: 'network',
      re: /failed to fetch|fetch|network|net::|socket/i,
      hint: 'Похоже, проблема с сетью. Проверьте VPN/интернет и нажмите «Повторить».'
    }
  ];

  /**
   * @param {Error|string} err
   * @returns {{kind: string, hint: string}}
   */
  function classify(err) {
    var msg = String((err && err.message) || err || '');
    if (!msg) return { kind: 'other', hint: '' };
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].re.test(msg)) {
        return { kind: RULES[i].kind, hint: RULES[i].hint };
      }
    }
    return { kind: 'other', hint: '' };
  }

  /** Сообщение + подсказка одной строкой (для однострочных плашек, напр. tools-таба). */
  function withHint(err) {
    var msg = String((err && err.message) || err || '');
    if (!msg) return '';
    var c = classify(msg);
    if (c.hint && msg.indexOf(c.hint) === -1) return msg + ' — ' + c.hint;
    return msg;
  }

  global.ErrorHumanizer = {
    classify: classify,
    withHint: withHint
  };
})(window);
