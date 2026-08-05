import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadThinkingLog } from './load-thinking-log.mjs';

const TL = loadThinkingLog();

/** Лог с управляемыми часами — иначе длительности не проверить. */
function clockLog(extra) {
  let t = 1000;
  const log = TL.createLog(Object.assign({ now: () => t }, extra || {}));
  return { log, tick: (ms) => { t += ms; }, at: () => t };
}

describe('ThinkingLog.fmtMs', () => {
  test('меньше секунды → миллисекунды', () => {
    assert.equal(TL.fmtMs(340), '340мс');
    assert.equal(TL.fmtMs(0), '0мс');
  });
  test('секунды с одним знаком', () => {
    assert.equal(TL.fmtMs(1400), '1.4с');
    assert.equal(TL.fmtMs(12000), '12с');
  });
  test('минуты', () => {
    assert.equal(TL.fmtMs(125000), '2м 05с');
    assert.equal(TL.fmtMs(600000), '10м 00с');
  });
  test('округление 59.7с не даёт «0м 60с»', () => {
    assert.equal(TL.fmtMs(119700), '2м 00с');
  });
  test('мусор → пустая строка', () => {
    assert.equal(TL.fmtMs(-5), '');
    assert.equal(TL.fmtMs(NaN), '');
    assert.equal(TL.fmtMs('12'), '');
    assert.equal(TL.fmtMs(undefined), '');
  });
});

describe('ThinkingLog.shortModel', () => {
  test('срезает вендора', () => {
    assert.equal(TL.shortModel('zai-org/GLM-4.7'), 'GLM-4.7');
    assert.equal(TL.shortModel('deepseek-ai/DeepSeek-V4-Pro'), 'DeepSeek-V4-Pro');
  });
  test('без слэша — как есть', () => {
    assert.equal(TL.shortModel('gpt-oss-120b'), 'gpt-oss-120b');
  });
  test('пусто → пусто', () => {
    assert.equal(TL.shortModel(''), '');
    assert.equal(TL.shortModel(null), '');
  });
});

describe('ThinkingLog.argsSummary', () => {
  test('массив схлопывается в длину (планы правок бывают огромными)', () => {
    assert.equal(TL.argsSummary({ edits: [1, 2, 3, 4] }), 'edits: 4');
  });
  test('длинная строка режется', () => {
    const s = TL.argsSummary({ query: 'а'.repeat(60) });
    assert.equal(s, 'query: ' + 'а'.repeat(40) + '…');
  });
  test('числа и булевы как есть', () => {
    assert.equal(TL.argsSummary({ n: 12, dry: true }), 'n: 12, dry: true');
  });
  test('вложенный объект → {…}', () => {
    assert.equal(TL.argsSummary({ plan: { a: 1 } }), 'plan: {…}');
  });
  test('больше лимита ключей → хвост считается', () => {
    assert.equal(TL.argsSummary({ a: 1, b: 2, c: 3, d: 4, e: 5 }), 'a: 1, b: 2, c: 3, +2');
  });
  test('пустые значения не считаются', () => {
    assert.equal(TL.argsSummary({ a: 1, b: null, c: undefined, d: '' }), 'a: 1');
  });
  test('не-объект → пустая строка', () => {
    assert.equal(TL.argsSummary(null), '');
    assert.equal(TL.argsSummary([1, 2]), '');
    assert.equal(TL.argsSummary({}), '');
    assert.equal(TL.argsSummary('str'), '');
  });
});

describe('ThinkingLog.createLog — лента шагов', () => {
  test('фаза llm → строка шага с короткой моделью', () => {
    const { log } = clockLog();
    log.push({ phase: 'llm', step: 3, maxSteps: 24, model: 'zai-org/GLM-4.7' });
    const e = log.entries();
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'step');
    assert.equal(e[0].text, 'Шаг 3/24 · запрос к GLM-4.7');
    assert.equal(e[0].step, 3);
  });

  test('стрим-события схлопываются в одну отметку на шаг', () => {
    const { log } = clockLog();
    for (let i = 0; i < 10; i++) log.push({ phase: 'streaming', step: 1, accumulated: 'abc' });
    assert.equal(log.entries().filter((e) => e.kind === 'answer').length, 1);
  });

  test('новый шаг llm снова разрешает отметку «пишет ответ»', () => {
    const { log } = clockLog();
    log.push({ phase: 'streaming', step: 1 });
    log.push({ phase: 'llm', step: 2, maxSteps: 24, model: 'm' });
    log.push({ phase: 'streaming', step: 2 });
    assert.equal(log.entries().filter((e) => e.kind === 'answer').length, 2);
  });

  test('инструмент: pending → закрывается tool-done с длительностью', () => {
    const { log, tick } = clockLog();
    log.push({ phase: 'tool', name: 'apply_edit_plan', step: 2, args: { edits: [1, 2] } });
    const pending = log.entries()[0];
    assert.equal(pending.pending, true);
    assert.equal(pending.text, 'инструмент: apply_edit_plan (edits: 2)');
    tick(1400);
    log.push({ phase: 'tool-done', name: 'apply_edit_plan', ms: 1400, ok: true });
    const done = log.entries()[0];
    assert.equal(done.pending, false);
    assert.equal(done.ms, 1400);
    assert.equal(done.ok, true);
    assert.equal(log.entries().length, 1, 'закрытие не плодит вторую строку');
  });

  test('tool-done без парного tool создаёт свою строку', () => {
    const { log } = clockLog();
    log.push({ phase: 'tool-done', name: 'get_timeline', ms: 200, ok: false });
    const e = log.entries();
    assert.equal(e.length, 1);
    assert.equal(e[0].ok, false);
    assert.equal(e[0].pending, undefined);
  });

  test('фолбэк модели → предупреждение', () => {
    const { log } = clockLog();
    log.push({ phase: 'model-fallback', model: 'b', message: 'Модель a недоступна — переключаюсь на b' });
    assert.equal(log.entries()[0].kind, 'warn');
  });

  test('неизвестная фаза с message → info; без message → ничего', () => {
    const { log } = clockLog();
    log.push({ phase: 'wat', message: 'что-то' });
    log.push({ phase: 'wat' });
    const e = log.entries();
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'info');
  });

  test('мусор вместо события игнорируется', () => {
    const { log } = clockLog();
    log.push(null);
    log.push('строка');
    log.push(undefined);
    assert.equal(log.entries().length, 0);
    assert.equal(log.isEmpty(), true);
  });

  test('лента не растёт бесконечно', () => {
    const { log } = clockLog({ maxEntries: 5 });
    for (let i = 1; i <= 20; i++) log.push({ phase: 'llm', step: i, maxSteps: 20, model: 'm' });
    const e = log.entries();
    assert.equal(e.length, 5);
    assert.equal(e[4].step, 20, 'сохраняются последние, а не первые');
  });

  test('entries() возвращает копию — внешняя мутация не портит лог', () => {
    const { log } = clockLog();
    log.push({ phase: 'llm', step: 1, maxSteps: 2, model: 'm' });
    log.entries().push({ kind: 'fake' });
    assert.equal(log.entries().length, 1);
  });
});

describe('ThinkingLog.createLog — размышления', () => {
  test('accumulated перезаписывает текст того же шага, а не клеится', () => {
    const { log } = clockLog();
    log.push({ phase: 'reasoning', step: 1, accumulated: 'Счи' });
    log.push({ phase: 'reasoning', step: 1, accumulated: 'Считаю 17' });
    log.push({ phase: 'reasoning', step: 1, accumulated: 'Считаю 17*23' });
    assert.equal(log.reasoning(), 'Считаю 17*23');
  });

  test('разные шаги склеиваются через пустую строку', () => {
    const { log } = clockLog();
    log.push({ phase: 'reasoning', step: 1, accumulated: 'первый' });
    log.push({ phase: 'reasoning', step: 2, accumulated: 'второй' });
    assert.equal(log.reasoning(), 'первый\n\nвторой');
  });

  test('в ленту попадает одна отметка «рассуждает» на шаг', () => {
    const { log } = clockLog();
    for (let i = 0; i < 5; i++) log.push({ phase: 'reasoning', step: 1, accumulated: 'x'.repeat(i) });
    log.push({ phase: 'reasoning', step: 2, accumulated: 'y' });
    assert.equal(log.entries().filter((e) => e.kind === 'reasoning').length, 2);
  });

  test('переполнение режет НАЧАЛО — свежая мысль важнее', () => {
    const { log } = clockLog({ maxReasoning: 10 });
    log.push({ phase: 'reasoning', step: 1, accumulated: 'abcdefghijklmnop' });
    const r = log.reasoning();
    assert.equal(r, '…ghijklmnop');
    assert.equal(r.length, 11);
  });

  test('hasReasoning: пустой accumulated не считается размышлением', () => {
    const { log } = clockLog();
    assert.equal(log.hasReasoning(), false);
    log.push({ phase: 'reasoning', step: 1, accumulated: '' });
    assert.equal(log.hasReasoning(), false);
    log.push({ phase: 'reasoning', step: 1, accumulated: 'мысль' });
    assert.equal(log.hasReasoning(), true);
  });

  test('не-строка в accumulated не роняет лог', () => {
    const { log } = clockLog();
    log.push({ phase: 'reasoning', step: 1, accumulated: { a: 1 } });
    assert.equal(log.reasoning(), '');
  });
});

describe('ThinkingLog.createLog — завершение и сброс', () => {
  test('finish добавляет итог с общей длительностью в ms, но не в тексте', () => {
    const { log, tick } = clockLog();
    log.push({ phase: 'llm', step: 1, maxSteps: 2, model: 'm' });
    tick(2500);
    const e = log.finish('Готово');
    assert.equal(e.kind, 'done');
    /* Длительность рисует UI из ms — в тексте её быть не должно, иначе дубль */
    assert.equal(e.text, 'Готово');
    assert.equal(e.ms, 2500);
  });

  test('finish снимает зависший pending (прерывание/ошибка)', () => {
    const { log, tick } = clockLog();
    log.push({ phase: 'tool', name: 'slow', step: 1 });
    tick(100);
    log.finish('Остановлено');
    assert.equal(log.entries()[0].pending, false);
  });

  test('elapsedMs считается от первого события, а не от создания лога', () => {
    const { log, tick } = clockLog();
    tick(5000);
    log.push({ phase: 'llm', step: 1, maxSteps: 1, model: 'm' });
    tick(3000);
    assert.equal(log.elapsedMs(), 3000);
  });

  test('elapsedMs до первого события = 0', () => {
    const { log, tick } = clockLog();
    tick(5000);
    assert.equal(log.elapsedMs(), 0);
  });

  test('clear обнуляет всё, включая дедуп-состояние шагов', () => {
    const { log } = clockLog();
    log.push({ phase: 'reasoning', step: 1, accumulated: 'мысль' });
    log.push({ phase: 'streaming', step: 1 });
    log.clear();
    assert.equal(log.isEmpty(), true);
    assert.equal(log.reasoning(), '');
    log.push({ phase: 'reasoning', step: 1, accumulated: 'заново' });
    log.push({ phase: 'streaming', step: 1 });
    assert.equal(log.entries().filter((e) => e.kind === 'reasoning').length, 1);
    assert.equal(log.entries().filter((e) => e.kind === 'answer').length, 1);
  });
});

describe('ThinkingLog.markerFor', () => {
  test('у каждого вида свой значок', () => {
    const kinds = ['step', 'reasoning', 'tool', 'answer', 'warn', 'done'];
    const seen = kinds.map(TL.markerFor);
    assert.equal(new Set(seen).size, kinds.length);
  });
  test('неизвестный вид → нейтральная точка', () => {
    assert.equal(TL.markerFor('чтотото'), '·');
  });
});
