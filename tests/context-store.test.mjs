import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadContextStoreWithTempRoot } from './load-context-store.mjs';

describe('ContextStore (файловый кэш + ключи секвенции)', () => {
  const { ContextStore, tmpRoot, cleanup } = loadContextStoreWithTempRoot();
  after(() => cleanup());

  test('setTranscriptEntry сохраняет в нормализованный ключ и на диск', () => {
    const ok = ContextStore.setTranscriptEntry('markers', '  Seq_A  ', { segments: [1], mode: 't' });
    assert.equal(ok, true);
    const pRoot = path.join(tmpRoot, '_llm_transcript_cache.json');
    const pHost = path.join(tmpRoot, 'host', '_llm_transcript_cache.json');
    assert.ok(fs.existsSync(pRoot), 'ожидается файл в корне расширения');
    assert.ok(fs.existsSync(pHost), 'ожидается дубликат в host/');
    const raw = JSON.parse(fs.readFileSync(pRoot, 'utf8'));
    assert.ok(raw.Seq_A);
    assert.equal(raw.Seq_A.mode, 't');
  });

  test('findTranscriptEntry: точное и без учёта регистра', () => {
    ContextStore.setTranscriptEntry('textmontage', 'MySequence', { text: 'hi' });
    const a = ContextStore.findTranscriptEntry('markers', 'MySequence');
    assert.equal(a.matchedKey, 'MySequence');
    assert.equal(a.entry.text, 'hi');
    const b = ContextStore.findTranscriptEntry('markers', 'mysequence');
    assert.ok(b.entry);
    assert.equal(b.entry.text, 'hi');
  });

  test('listTranscriptCacheKeys содержит сохранённые ключи', () => {
    const keys = ContextStore.listTranscriptCacheKeys('markers');
    assert.ok(keys.includes('Seq_A'));
    assert.ok(keys.includes('MySequence'));
  });

  test('пустой extensionRoot — fallback localStorage для транскриптов', () => {
    const { ContextStore: CS2, cleanup: c2 } = loadContextStoreWithTempRoot();
    CS2.setExtensionRoot('');
    CS2.setTranscriptEntry('markers', 'LSOnly', { v: 1 });
    const map = CS2.getTranscriptCache('markers');
    assert.equal(map.LSOnly.v, 1);
    c2();
  });

  test('setExtensionRoot корректно обрабатывает file:/// URL с %20', () => {
    const { ContextStore: CS4, tmpRoot: tmpRoot4, cleanup: c4 } = loadContextStoreWithTempRoot();
    /* Имитируем CEP cs.getExtensionPath() который возвращает file:/// URL */
    const fileUrl = 'file:///' + tmpRoot4.replace(/ /g, '%20');
    CS4.setExtensionRoot(fileUrl);
    const ok = CS4.setTranscriptEntry('unified', 'TestSeq', { segments: [{ text: 'hello' }] });
    assert.equal(ok, true);
    /* Файл должен быть по реальному пути, не по file:/// */
    const realFile = path.join(tmpRoot4, '_llm_transcript_cache.json');
    assert.ok(fs.existsSync(realFile), 'файл должен быть по реальному пути без file:///');
    const data = JSON.parse(fs.readFileSync(realFile, 'utf8'));
    assert.ok(data.TestSeq);
    assert.equal(data.TestSeq.segments[0].text, 'hello');
    c4();
  });

  test('setTranscriptUserDataBase — дублирует кэш в каталог userData (T3)', () => {
    const { ContextStore: CS3, tmpRoot, cleanup: c3 } = loadContextStoreWithTempRoot();
    const fakeUd = path.join(tmpRoot, 'cep-user-data');
    fs.mkdirSync(fakeUd, { recursive: true });
    CS3.setTranscriptUserDataBase(fakeUd);
    CS3.setTranscriptEntry('markers', 'Cross', { segments: [] });
    const udFile = path.join(fakeUd, 'com.extensionsllm.chatpr', '_llm_transcript_cache.json');
    assert.ok(fs.existsSync(udFile), 'файл в userData для общего кэша между панелями');
    const raw = JSON.parse(fs.readFileSync(udFile, 'utf8'));
    assert.ok(raw.Cross);
    c3();
  });
});

/* ═══════════════════════════════════════════════════════════════
 * localStorage недоступен (аудит §6, Волна 1 п.8).
 * В CEF localStorage может бросать SecurityError (отключён) или
 * QuotaExceededError (переполнен). ContextStore зовётся из середины
 * агент-циклов panel.js (~14 мест setMessages) — бросок роняет весь флоу.
 * Контракт: деградировать мягко (пустые значения/false), НЕ бросать.
 * ═══════════════════════════════════════════════════════════════ */
describe('ContextStore — localStorage недоступен (бросает)', () => {
  function makeThrowingLS() {
    const boom = () => {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    };
    return { getItem: boom, setItem: boom, removeItem: boom };
  }

  const { ContextStore: CS, tmpRoot, cleanup } = loadContextStoreWithTempRoot({
    localStorage: makeThrowingLS()
  });
  after(() => cleanup());

  test('getMessages → [] вместо исключения', () => {
    /* массив создаётся в vm-realm — deepStrictEqual падает на прототипе */
    const m = CS.getMessages('markers');
    assert.ok(Array.isArray(m));
    assert.equal(m.length, 0);
  });

  test('setMessages не бросает (история чата — nicety, не блокер)', () => {
    assert.doesNotThrow(() => CS.setMessages('markers', [{ role: 'user', content: 'hi' }]));
  });

  test('appendMessage не бросает', () => {
    assert.doesNotThrow(() => CS.appendMessage('markers', { role: 'user', content: 'hi' }));
  });

  test('clearChat не бросает', () => {
    assert.doesNotThrow(() => CS.clearChat('markers'));
  });

  test('getLastUndo → null, setLastUndo/clearLastUndoCount не бросают', () => {
    assert.equal(CS.getLastUndo('markers'), null);
    assert.doesNotThrow(() => CS.setLastUndo('markers', 3, 'label', 'Seq'));
    assert.doesNotThrow(() => CS.clearLastUndoCount('markers'));
  });

  test('транскрипт-кэш живёт через файлы даже с мёртвым localStorage', () => {
    CS.setExtensionRoot(tmpRoot);
    assert.equal(CS.setTranscriptEntry('markers', 'SeqLS', { v: 42 }), true);
    assert.equal(CS.getTranscriptEntry('markers', 'SeqLS').v, 42);
  });

  test('setTranscriptCache без файловых путей и с мёртвым LS → false, не бросает', () => {
    const { ContextStore: CS2, cleanup: c2 } = loadContextStoreWithTempRoot({
      localStorage: makeThrowingLS()
    });
    CS2.setExtensionRoot('');
    /* homedir подменён на tmp — но setExtensionRoot('') оставляет home-путь;
       эмулируем полное отсутствие путей нельзя без правки кода, поэтому
       проверяем только «не бросает» + boolean-результат. */
    let r;
    assert.doesNotThrow(() => { r = CS2.setTranscriptCache('markers', { a: 1 }); });
    assert.equal(typeof r, 'boolean');
    c2();
  });
});

/* ═══════════════════════════════════════════════════════════════
 * Стек undo-чекпоинтов (Волна 2 п.3: мультиоткат).
 * Контракт: getLastUndo = вершина (совместимость со старым кодом),
 * getUndoStack — новые первыми, clearLastUndoCount — pop вершины,
 * removeUndoEntry(ts) — из середины, cap 8 с возвратом вытесненных.
 * ═══════════════════════════════════════════════════════════════ */
describe('ContextStore — стек undo-чекпоинтов (мультиоткат)', () => {
  const PID = 'unified';

  function freshCS() {
    return loadContextStoreWithTempRoot();
  }

  test('push двух чекпоинтов: getLastUndo = последний, getUndoStack новые первыми', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 1, 'монтаж A', 'Seq', { mode: 'sequence_backup', backupId: 'b1' });
    CS.setLastUndo(PID, 1, 'монтаж B', 'Seq', { mode: 'sequence_backup', backupId: 'b2' });
    const top = CS.getLastUndo(PID);
    assert.equal(top.label, 'монтаж B');
    const stack = CS.getUndoStack(PID);
    assert.equal(stack.length, 2);
    assert.equal(stack[0].label, 'монтаж B');
    assert.equal(stack[1].label, 'монтаж A');
    cleanup();
  });

  test('clearLastUndoCount = pop: предыдущая точка снова вершина', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 3, 'маркеры', 'Seq', { mode: 'markers', markerSeconds: [1, 2, 3] });
    CS.setLastUndo(PID, 1, 'монтаж', 'Seq', { mode: 'sequence_backup', backupId: 'b1' });
    CS.clearLastUndoCount(PID);
    const top = CS.getLastUndo(PID);
    assert.equal(top.mode, 'markers');
    assert.equal(top.count, 3);
    CS.clearLastUndoCount(PID);
    assert.equal(CS.getLastUndo(PID), null);
    cleanup();
  });

  test('removeUndoEntry(ts) удаляет из середины, соседи целы', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 1, 'A', 'Seq', { mode: 'sequence_backup', backupId: 'a' });
    CS.setLastUndo(PID, 1, 'B', 'Seq', { mode: 'sequence_backup', backupId: 'b' });
    CS.setLastUndo(PID, 1, 'C', 'Seq', { mode: 'sequence_backup', backupId: 'c' });
    const mid = CS.getUndoStack(PID)[1]; /* B */
    CS.removeUndoEntry(PID, mid.ts);
    const stack = CS.getUndoStack(PID);
    assert.equal(stack.length, 2);
    assert.equal(stack[0].label, 'C');
    assert.equal(stack[1].label, 'A');
    cleanup();
  });

  test('cap 8: девятый push вытесняет старейший и возвращает его', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    for (let i = 1; i <= 8; i++) {
      const ev = CS.setLastUndo(PID, 1, 'op' + i, 'Seq', { mode: 'sequence_backup', backupId: 'id' + i });
      assert.equal(ev.length, 0, 'до cap вытеснений нет');
    }
    const evicted = CS.setLastUndo(PID, 1, 'op9', 'Seq', { mode: 'sequence_backup', backupId: 'id9' });
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].backupId, 'id1');
    const stack = CS.getUndoStack(PID);
    assert.equal(stack.length, 8);
    assert.equal(stack[0].label, 'op9');
    assert.equal(stack[7].label, 'op2');
    cleanup();
  });

  test('миграция: старый одиночный формат в LS читается как стек из 1', () => {
    const { ContextStore: CS, root, cleanup } = freshCS();
    /* пишем старый формат напрямую в LS-стаб */
    root.localStorage.setItem('extllmpr_v1_undo_' + PID, JSON.stringify({
      count: 2, label: 'старые маркеры', sequenceName: 'Seq', ts: 123,
      mode: 'markers', markerSeconds: [5, 6]
    }));
    const top = CS.getLastUndo(PID);
    assert.equal(top.count, 2);
    assert.equal(top.label, 'старые маркеры');
    assert.equal(CS.getUndoStack(PID).length, 1);
    /* push поверх мигрированного работает */
    CS.setLastUndo(PID, 1, 'новый', 'Seq', { mode: 'sequence_backup', backupId: 'n1' });
    assert.equal(CS.getUndoStack(PID).length, 2);
    cleanup();
  });

  test('ts уникален даже при пушах в одну миллисекунду', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 1, 'A', 'Seq', { mode: 'sequence_backup', backupId: 'a' });
    CS.setLastUndo(PID, 1, 'B', 'Seq', { mode: 'sequence_backup', backupId: 'b' });
    CS.setLastUndo(PID, 1, 'C', 'Seq', { mode: 'sequence_backup', backupId: 'c' });
    const st = CS.getUndoStack(PID);
    const ts = st.map((u) => u.ts);
    assert.equal(new Set(ts).size, 3, 'все ts различны: ' + ts.join(','));
    cleanup();
  });

  test('count <= 0 → clearLastUndoCount-поведение (pop), возвращает []', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 1, 'A', 'Seq', { mode: 'sequence_backup', backupId: 'a' });
    const r = CS.setLastUndo(PID, 0, 'x', 'Seq');
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 0);
    assert.equal(CS.getLastUndo(PID), null);
    cleanup();
  });

  test('clearUndoStack очищает всё (clearAllPanelCache)', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setLastUndo(PID, 1, 'A', 'Seq', { mode: 'sequence_backup', backupId: 'a' });
    CS.setLastUndo(PID, 1, 'B', 'Seq', { mode: 'sequence_backup', backupId: 'b' });
    CS.clearUndoStack(PID);
    assert.equal(CS.getLastUndo(PID), null);
    assert.equal(CS.getUndoStack(PID).length, 0);
    cleanup();
  });
});

describe('ContextStore — ручной переключатель модели (сессия)', () => {
  const FM = {
    chatModel: 'zai-org/GLM-5.1',
    knownModels: [
      { id: 'zai-org/GLM-5.1', label: 'GLM-5.1' },
      { id: 'zai-org/GLM-4.7', label: 'GLM-4.7' },
      { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b' }
    ]
  };
  function freshCS() {
    return loadContextStoreWithTempRoot({ fmDefaults: FM });
  }

  test('дефолт: override нет, эффективная модель = chatModel', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    assert.equal(CS.isSessionChatModelOverridden(), false);
    assert.equal(CS.getSessionChatModel(), 'zai-org/GLM-5.1');
    assert.equal(CS.getResolvedSettings().chatModel, 'zai-org/GLM-5.1');
    cleanup();
  });

  test('setSessionChatModel валидной id → override применён везде (chat+agent)', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    const applied = CS.setSessionChatModel('openai/gpt-oss-120b');
    assert.equal(applied, 'openai/gpt-oss-120b');
    assert.equal(CS.isSessionChatModelOverridden(), true);
    const rs = CS.getResolvedSettings();
    assert.equal(rs.chatModel, 'openai/gpt-oss-120b');
    assert.equal(rs.activeAgentModel, 'openai/gpt-oss-120b', 'агент наследует override');
    cleanup();
  });

  test('невалидная id отклоняется — остаётся прежняя эффективная модель', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    const applied = CS.setSessionChatModel('does/not-exist');
    assert.equal(applied, 'zai-org/GLM-5.1', 'вернул текущую, не применил мусор');
    assert.equal(CS.isSessionChatModelOverridden(), false);
    assert.equal(CS.getResolvedSettings().chatModel, 'zai-org/GLM-5.1');
    cleanup();
  });

  test('пустая строка / null сбрасывает override на дефолт', () => {
    const { ContextStore: CS, cleanup } = freshCS();
    CS.setSessionChatModel('zai-org/GLM-4.7');
    assert.equal(CS.getResolvedSettings().chatModel, 'zai-org/GLM-4.7');
    const back = CS.setSessionChatModel('');
    assert.equal(back, 'zai-org/GLM-5.1');
    assert.equal(CS.isSessionChatModelOverridden(), false);
    assert.equal(CS.getResolvedSettings().chatModel, 'zai-org/GLM-5.1');
    cleanup();
  });
});
