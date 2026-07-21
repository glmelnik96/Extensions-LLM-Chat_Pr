/**
 * SelfUpdate: версия плагина и обновление напрямую из git (17.07.2026).
 *
 * Работает потому, что расширение установлено как git-клон (или симлинк на него):
 * `git pull` в корне расширения = обновление плагина; далее location.reload()
 * перечитывает и panel.js, и host (premiere.jsx грузится через $.evalFile при старте панели).
 *
 * API (runner инжектируется в тестах, по умолчанию — реальный git):
 *   getStatus(repoRoot, run?)      → Promise<{supported, commit, branch, dirty}>
 *   checkForUpdate(repoRoot, run?) → Promise<{supported, available, behind, ahead, diverged, reason?}>
 *   applyUpdate(repoRoot, run?)    → Promise<{ok, commit}> | reject(Error)
 *
 * Грациозная деградация: нет Node / нет git / папка не клон → {supported:false},
 * UI показывает только версию host без кнопки обновления.
 */
(function (global) {
  'use strict';

  function hasNode() {
    return typeof require !== 'undefined';
  }

  /**
   * Найти git — CEP Node.js не наследует пользовательский PATH (как ffmpeg
   * в audio-preprocess.js). macOS: /usr/bin/git есть при установленных Xcode CLT.
   */
  var _gitPathCache;
  function findGitPath() {
    if (_gitPathCache !== undefined) return _gitPathCache;
    _gitPathCache = null;
    if (!hasNode()) return null;
    var fs = require('fs');
    var candidates = process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
      : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) { _gitPathCache = candidates[i]; return _gitPathCache; } } catch (e) {}
    }
    try {
      var execSync = require('child_process').execSync;
      var p = process.platform === 'win32'
        ? String(execSync('where git', { timeout: 5000 })).trim().split('\n')[0].trim()
        : String(execSync('which git', {
            timeout: 5000,
            env: Object.assign({}, process.env, {
              PATH: (process.env.PATH || '') + ':/usr/bin:/opt/homebrew/bin:/usr/local/bin'
            })
          })).trim();
      if (p && fs.existsSync(p)) _gitPathCache = p;
    } catch (e) {}
    return _gitPathCache;
  }

  /**
   * CEP getExtensionPath/getSystemPath может вернуть file:/// URL с
   * percent-encoded кириллицей — как cwd это даёт spawn ENOENT (live CDP 17.07).
   * → нативный путь с forward slashes (Windows Node принимает их в cwd).
   */
  function _normalizeRoot(s) {
    s = String(s || '').replace(/^file:\/\//, '');
    try { s = decodeURIComponent(s); } catch (eD) {}
    s = s.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').trim();
    return s;
  }

  /** Дефолтный runner: git <args> в repoRoot → Promise<stdout>. */
  function makeRunner(repoRoot) {
    repoRoot = _normalizeRoot(repoRoot);
    return function (args, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!hasNode()) return reject(new Error('Node.js недоступен в панели'));
        var bin = findGitPath();
        if (!bin) return reject(new Error('git не найден в системе'));
        var execFile = require('child_process').execFile;
        execFile(bin, args, { cwd: repoRoot, timeout: timeoutMs || 30000, maxBuffer: 4 * 1024 * 1024 },
          function (err, stdout, stderr) {
            if (err) {
              var msg = String(stderr || err.message || err);
              return reject(new Error(msg.trim()));
            }
            resolve(String(stdout));
          });
      });
    };
  }

  /* ── Чистые парсеры ────────────────────────────────────────────── */

  /** `git rev-list --left-right --count A...B` → "ahead\tbehind". */
  function _parseLeftRightCount(out) {
    var m = String(out || '').match(/(\d+)\s+(\d+)/);
    if (!m) return { ahead: 0, behind: 0 };
    return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) };
  }

  /** `git status --porcelain`: непустой вывод = несохранённые правки. */
  function _isDirtyOutput(out) {
    return String(out || '').replace(/\s+/g, '') !== '';
  }

  /**
   * Парсер `git log --pretty=format:%h%x1f%s%x1f%cs`: одна строка = один
   * коммит, поля разделены байтом 0x1f (unit separator — не встречается в
   * теме коммита). → [{ hash, subject, date }]. Используется для окна
   * «Что нового» (список подтянутых/недавних фиксов).
   */
  function _parseCommitLog(out) {
    var lines = String(out || '').split('\n');
    var res = [];
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      var p = lines[i].split('\u001f');
      if (!p[0]) continue;
      res.push({ hash: p[0].trim(), subject: (p[1] || '').trim(), date: (p[2] || '').trim() });
    }
    return res;
  }

  /* ── API ───────────────────────────────────────────────────────── */

  function getStatus(repoRoot, runOpt) {
    var run = runOpt || makeRunner(repoRoot);
    return run(['rev-parse', '--short', 'HEAD'])
      .then(function (commit) {
        return Promise.all([
          Promise.resolve(commit),
          run(['rev-parse', '--abbrev-ref', 'HEAD']),
          run(['status', '--porcelain'])
        ]);
      })
      .then(function (rs) {
        return {
          supported: true,
          commit: String(rs[0]).trim(),
          branch: String(rs[1]).trim(),
          dirty: _isDirtyOutput(rs[2])
        };
      })
      .catch(function (e) {
        return { supported: false, reason: String((e && e.message) || e) };
      });
  }

  function checkForUpdate(repoRoot, runOpt) {
    var run = runOpt || makeRunner(repoRoot);
    return run(['fetch', '--quiet', 'origin'], 60000)
      .then(function () {
        return run(['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
      })
      .then(function (out) {
        var c = _parseLeftRightCount(out);
        var diverged = c.ahead > 0 && c.behind > 0;
        return {
          supported: true,
          available: c.behind > 0 && !diverged,
          behind: c.behind,
          ahead: c.ahead,
          diverged: diverged
        };
      })
      .catch(function (e) {
        /* Нет сети / не репозиторий / нет git — не ошибка UI, просто «нет обновлений». */
        return {
          supported: true,
          available: false,
          behind: 0,
          ahead: 0,
          diverged: false,
          reason: 'git fetch не удался: ' + String((e && e.message) || e)
        };
      });
  }

  function applyUpdate(repoRoot, runOpt) {
    var run = runOpt || makeRunner(repoRoot);
    return run(['status', '--porcelain']).then(function (out) {
      if (_isDirtyOutput(out)) {
        throw new Error('В папке плагина есть несохранённые локальные правки — обновление отменено, ' +
          'чтобы не потерять работу. Закоммитьте или отмените изменения (git status).');
      }
      return run(['pull', '--ff-only', 'origin', 'main'], 120000);
    }).then(function () {
      return run(['rev-parse', '--short', 'HEAD']);
    }).then(function (commit) {
      return { ok: true, commit: String(commit).trim() };
    });
  }

  /**
   * Недавние коммиты (для окна «Что нового», ручной просмотр).
   * Грациозно: не git / нет коммитов → {supported:false, commits:[]}.
   */
  function getRecentCommits(repoRoot, n, runOpt) {
    var run = runOpt || makeRunner(repoRoot);
    var count = n > 0 ? n : 25;
    return run(['log', '-n', String(count), '--pretty=format:%h%x1f%s%x1f%cs'])
      .then(function (out) { return { supported: true, commits: _parseCommitLog(out) }; })
      .catch(function (e) { return { supported: false, commits: [], reason: String((e && e.message) || e) }; });
  }

  /**
   * Коммиты, которые прилетят при обновлении (есть в origin/main, нет в HEAD).
   * Вызывать ПОСЛЕ checkForUpdate (он делает fetch) — иначе список может быть
   * пустым/устаревшим. Это ответ на «что скачивает пользователь».
   */
  function getIncomingCommits(repoRoot, runOpt) {
    var run = runOpt || makeRunner(repoRoot);
    return run(['log', '--pretty=format:%h%x1f%s%x1f%cs', 'HEAD..origin/main'])
      .then(function (out) { return { supported: true, commits: _parseCommitLog(out) }; })
      .catch(function (e) { return { supported: false, commits: [], reason: String((e && e.message) || e) }; });
  }

  global.SelfUpdate = {
    getStatus: getStatus,
    checkForUpdate: checkForUpdate,
    applyUpdate: applyUpdate,
    getRecentCommits: getRecentCommits,
    getIncomingCommits: getIncomingCommits,
    findGitPath: findGitPath,
    _normalizeRoot: _normalizeRoot,
    _parseLeftRightCount: _parseLeftRightCount,
    _isDirtyOutput: _isDirtyOutput,
    _parseCommitLog: _parseCommitLog
  };
})(window);
