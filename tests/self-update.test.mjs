/**
 * Тесты SelfUpdate: обновление плагина из git прямо из панели (17.07.2026).
 *
 * Логика тестируется с инжектированным runner'ом (fake git) — реальный git
 * не вызывается. Контракты:
 *   - getStatus(root, run)      → {supported, commit, branch, dirty}
 *   - checkForUpdate(root, run) → {supported, available, behind, ahead, diverged}
 *   - applyUpdate(root, run)    → {ok, commit} | reject (dirty / diverged / git error)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import assertLoose from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSelfUpdate() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'self-update.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) throw new Error('self-update.js: expected footer ' + marker);
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  const sandbox = { root, console, String, RegExp, Array, Object, JSON, Math, Promise, Error, setTimeout, undefined };
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'self-update.js' });
  if (!root.SelfUpdate) throw new Error('SelfUpdate not attached to root');
  return root.SelfUpdate;
}

const SU = loadSelfUpdate();

/** Fake runner: map «args.join(' ')» → stdout-строка или Error. Пишет лог вызовов. */
function fakeRun(responses, calls) {
  return function (args) {
    const key = args.join(' ');
    if (calls) calls.push(key);
    if (!(key in responses)) return Promise.reject(new Error('fake git: неожиданный вызов ' + key));
    const v = responses[key];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
}

/* ═══ Чистые парсеры ═══ */
describe('SelfUpdate — парсеры вывода git', () => {
  it('_parseLeftRightCount: "0\\t3" → ahead 0, behind 3', () => {
    assertLoose.deepEqual(SU._parseLeftRightCount('0\t3\n'), { ahead: 0, behind: 3 });
  });
  it('_parseLeftRightCount: пробельный разделитель и мусор → числа', () => {
    assertLoose.deepEqual(SU._parseLeftRightCount(' 2   5 '), { ahead: 2, behind: 5 });
  });
  it('_parseLeftRightCount: невалидный вывод → нули', () => {
    assertLoose.deepEqual(SU._parseLeftRightCount('fatal: bad revision'), { ahead: 0, behind: 0 });
  });
  it('_normalizeRoot: file:/// URL с percent-encoded кириллицей → нативный путь (live CDP 17.07: cwd ENOENT)', () => {
    assert.equal(
      SU._normalizeRoot('file:///C:/Users/%d0%93%d0%bb%d0%b5%d0%b1/AppData/Roaming/Adobe/CEP/extensions/com.extensionsllm.chatpr'),
      'C:/Users/Глеб/AppData/Roaming/Adobe/CEP/extensions/com.extensionsllm.chatpr'
    );
  });
  it('_normalizeRoot: нативный путь проходит без изменений (кроме backslash→slash)', () => {
    assert.equal(SU._normalizeRoot('C:\\repo\\ext'), 'C:/repo/ext');
    assert.equal(SU._normalizeRoot('/Users/x/ext'), '/Users/x/ext');
  });
  it('_isDirtyOutput: пустой/пробельный → false, любая строка статуса → true', () => {
    assert.equal(SU._isDirtyOutput(''), false);
    assert.equal(SU._isDirtyOutput('\n  \n'), false);
    assert.equal(SU._isDirtyOutput(' M client/unified/panel.js\n'), true);
    assert.equal(SU._isDirtyOutput('?? new-file.js\n'), true);
  });
  it('_parseCommitLog: hash\\x1fsubject\\x1fdate по строкам → массив объектов', () => {
    const out = '3e00fb5\u001ffix(ui): кастомные тултипы\u001f2026-07-21\n' +
                '754bfb6\u001ffeat(reels): умные переносы\u001f2026-07-20';
    assertLoose.deepEqual(SU._parseCommitLog(out), [
      { hash: '3e00fb5', subject: 'fix(ui): кастомные тултипы', date: '2026-07-21' },
      { hash: '754bfb6', subject: 'feat(reels): умные переносы', date: '2026-07-20' }
    ]);
  });
  it('_parseCommitLog: пустой вывод и пустые строки → []/пропуск', () => {
    assertLoose.deepEqual(SU._parseCommitLog(''), []);
    assertLoose.deepEqual(SU._parseCommitLog('\n\n'), []);
  });
});

/* ═══ getRecentCommits / getIncomingCommits ═══ */
describe('SelfUpdate.getRecentCommits / getIncomingCommits', () => {
  it('getRecentCommits: парсит git log, ограничивает n', async () => {
    const calls = [];
    const run = fakeRun({
      'log -n 30 --pretty=format:%h%x1f%s%x1f%cs': 'abc1234\u001ffeat(x): новое\u001f2026-07-21'
    }, calls);
    const r = await SU.getRecentCommits('/repo', 30, run);
    assert.equal(r.supported, true);
    assert.equal(r.commits.length, 1);
    assert.equal(r.commits[0].subject, 'feat(x): новое');
    assert.ok(calls[0].startsWith('log -n 30'));
  });
  it('getRecentCommits: git упал → supported:false, commits:[]', async () => {
    const run = fakeRun({});
    const r = await SU.getRecentCommits('/repo', 5, run);
    assert.equal(r.supported, false);
    assertLoose.deepEqual(r.commits, []);
  });
  it('getIncomingCommits: log HEAD..origin/main → подтягиваемые коммиты', async () => {
    const run = fakeRun({
      'log --pretty=format:%h%x1f%s%x1f%cs HEAD..origin/main':
        'd1\u001ffix(a): b\u001f2026-07-21\ne2\u001ffeat(c): d\u001f2026-07-21'
    });
    const r = await SU.getIncomingCommits('/repo', run);
    assert.equal(r.commits.length, 2);
    assert.equal(r.commits[1].subject, 'feat(c): d');
  });
});

/* ═══ getStatus ═══ */
describe('SelfUpdate.getStatus', () => {
  it('возвращает commit, branch, dirty', async () => {
    const run = fakeRun({
      'rev-parse --short HEAD': 'c0e7de8\n',
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'status --porcelain': ''
    });
    const st = await SU.getStatus('/repo', run);
    assert.equal(st.supported, true);
    assert.equal(st.commit, 'c0e7de8');
    assert.equal(st.branch, 'main');
    assert.equal(st.dirty, false);
  });
  it('не git-репозиторий → supported:false, не бросает', async () => {
    const run = fakeRun({
      'rev-parse --short HEAD': new Error('fatal: not a git repository')
    });
    const st = await SU.getStatus('/repo', run);
    assert.equal(st.supported, false);
    assert.ok(st.reason);
  });
});

/* ═══ checkForUpdate ═══ */
describe('SelfUpdate.checkForUpdate', () => {
  it('behind 2 → available:true', async () => {
    const calls = [];
    const run = fakeRun({
      'fetch --quiet origin': '',
      'rev-list --left-right --count HEAD...origin/main': '0\t2\n'
    }, calls);
    const r = await SU.checkForUpdate('/repo', run);
    assert.equal(r.supported, true);
    assert.equal(r.available, true);
    assert.equal(r.behind, 2);
    assert.equal(r.diverged, false);
    assert.ok(calls[0].startsWith('fetch'), 'fetch должен идти первым');
  });
  it('в актуальном состоянии → available:false', async () => {
    const run = fakeRun({
      'fetch --quiet origin': '',
      'rev-list --left-right --count HEAD...origin/main': '0\t0\n'
    });
    const r = await SU.checkForUpdate('/repo', run);
    assert.equal(r.available, false);
    assert.equal(r.behind, 0);
  });
  it('расхождение (ahead>0 и behind>0) → diverged:true, available:false (ff-only невозможен)', async () => {
    const run = fakeRun({
      'fetch --quiet origin': '',
      'rev-list --left-right --count HEAD...origin/main': '1\t2\n'
    });
    const r = await SU.checkForUpdate('/repo', run);
    assert.equal(r.diverged, true);
    assert.equal(r.available, false);
  });
  it('fetch упал (нет сети) → supported:true, available:false, reason', async () => {
    const run = fakeRun({
      'fetch --quiet origin': new Error('could not resolve host')
    });
    const r = await SU.checkForUpdate('/repo', run);
    assert.equal(r.available, false);
    assert.ok(/host|сеть|fetch/i.test(String(r.reason)));
  });
});

/* ═══ applyUpdate ═══ */
describe('SelfUpdate.applyUpdate', () => {
  it('чистое дерево → pull --ff-only, возвращает новый commit', async () => {
    const calls = [];
    const run = fakeRun({
      'status --porcelain': '',
      'pull --ff-only origin main': 'Updating c0e7de8..abc1234\nFast-forward\n',
      'rev-parse --short HEAD': 'abc1234\n'
    }, calls);
    const r = await SU.applyUpdate('/repo', run);
    assert.equal(r.ok, true);
    assert.equal(r.commit, 'abc1234');
    assert.ok(calls.indexOf('pull --ff-only origin main') >= 0);
  });
  it('грязное дерево → reject, pull НЕ вызывается', async () => {
    const calls = [];
    const run = fakeRun({
      'status --porcelain': ' M client/unified/panel.js\n'
    }, calls);
    await assert.rejects(() => SU.applyUpdate('/repo', run), /несохранённые|локальн/i);
    assert.equal(calls.indexOf('pull --ff-only origin main'), -1);
  });
  it('pull упал (ff невозможен) → reject с текстом git', async () => {
    const run = fakeRun({
      'status --porcelain': '',
      'pull --ff-only origin main': new Error('fatal: Not possible to fast-forward, aborting.')
    });
    await assert.rejects(() => SU.applyUpdate('/repo', run), /fast-forward/i);
  });
});
