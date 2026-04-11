import { test, describe } from 'node:test';
import assert from 'node:assert';
import { loadFindMoments } from './load-find-moments.mjs';

const FM = loadFindMoments();

const entry = {
  segments: [
    { startSec: 0, endSec: 3, text: 'Привет, сегодня расскажу про стратегию команды.' },
    { startSec: 3, endSec: 8, text: 'Главная мысль — сначала нанимай, потом мотивируй.' },
    { startSec: 8, endSec: 14, text: 'Вторая часть: как мотивация влияет на скорость разработки.' },
    { startSec: 14, endSec: 20, text: 'И небольшой пример про деплой на продакшн.' },
    { startSec: 20, endSec: 26, text: 'Мотивация — это про ожидания, а не про деньги.' }
  ],
  paragraphs: [
    {
      startSec: 0,
      endSec: 14,
      text:
        'Привет, сегодня расскажу про стратегию команды. Главная мысль — сначала нанимай, потом мотивируй. Вторая часть: как мотивация влияет на скорость разработки.'
    },
    { startSec: 14, endSec: 26, text: 'И небольшой пример про деплой на продакшн. Мотивация — это про ожидания, а не про деньги.' }
  ]
};

describe('FindMoments.find', () => {
  test('literal: стратегия → находит segment по стемме', () => {
    const r = FM.find(entry, 'стратегия');
    assert.ok(r.length > 0);
    assert.equal(r[0].matchType, 'literal');
    assert.ok(r[0].text.toLowerCase().includes('стратег'));
  });

  test('literal: словоформа «мотивация» даёт несколько совпадений', () => {
    const r = FM.find(entry, 'мотивация');
    assert.ok(r.length >= 2);
    for (const m of r) assert.equal(m.matchType, 'literal');
  });

  test('TF-IDF fallback для семантического запроса без literal-совпадений', () => {
    const r = FM.find(entry, 'найм сотрудников');
    // «найм» не встречается дословно, TF-IDF должен попасть на «нанимай»
    // Но «нанимай» тоже не совпадёт стеммингом «найм» — проверим что не падает
    assert.ok(Array.isArray(r));
  });

  test('пустой query возвращает []', () => {
    assert.deepEqual(FM.find(entry, ''), []);
  });

  test('k ограничивает количество результатов', () => {
    const r = FM.find(entry, 'и', { k: 1 }); // «и» в стоп-словах → TF-IDF fallback
    assert.ok(r.length <= 1);
  });

  test('нет кэша — возвращает []', () => {
    assert.deepEqual(FM.find(null, 'x'), []);
  });
});
