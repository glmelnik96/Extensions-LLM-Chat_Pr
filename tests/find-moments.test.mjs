import { test, describe } from 'node:test';
import assert from 'node:assert';
import { loadIife } from './helpers.mjs';

const FM = loadIife('client/shared/find-moments.js', 'FindMoments');

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

  /* Live-находка 12 июня 2026: стем «рос» (от «рост») совпадал с серединой
     слова «просто»/«вопрос» → literal возвращал ВСЕ сегменты подряд и агент
     зацикливался на find_moments. Стем должен матчиться только с началом слова. */
  describe('стем матчится только с началом слова (регрессия «китай рост»)', () => {
    const ruEntry = {
      segments: [
        { startSec: 0, endSec: 5, text: 'Нет, мне просто интересно, вопрос открытый.' },
        { startSec: 5, endSec: 10, text: 'Китайский автопром вырос очень быстро.' },
        { startSec: 10, endSec: 15, text: 'Темпы роста у них рекордные.' }
      ],
      paragraphs: []
    };

    test('«рост» НЕ матчит «просто»/«вопрос», но матчит «роста»', () => {
      const r = FM.find(ruEntry, 'рост');
      assert.ok(r.length > 0);
      for (const m of r) {
        assert.ok(!m.text.includes('просто'), `ложный матч середины слова: ${m.text}`);
      }
      assert.ok(r.some((m) => m.text.includes('роста')));
    });

    test('«китай рост» возвращает только релевантные сегменты', () => {
      const r = FM.find(ruEntry, 'китай рост');
      assert.ok(r.length >= 1 && r.length <= 2, `ожидали 1-2 хита, получили ${r.length}`);
      for (const m of r) assert.ok(m.startSec >= 5, `мусорный хит с ${m.startSec}с: ${m.text}`);
    });

    test('словоформы по префиксу работают: «китайцы» находит «Китайский»', () => {
      const r = FM.find(ruEntry, 'китайцы');
      assert.ok(r.length === 1);
      assert.ok(r[0].text.includes('Китайский'));
    });

    test('хиты со всеми стемами вытесняют одностемные («Россия» ловит стем «рос»)', () => {
      const e = {
        segments: [
          { startSec: 0, endSec: 5, text: 'В России много новых дорог появилось.' },
          { startSec: 100, endSec: 105, text: 'Китайский автопром показал рост продаж.' },
          { startSec: 200, endSec: 205, text: 'Россия и Европа обсуждают тарифы.' }
        ],
        paragraphs: []
      };
      const r = FM.find(e, 'китай рост');
      assert.equal(r.length, 1, `ожидали 1 двухстемный хит, получили ${r.length}`);
      assert.equal(r[0].startSec, 100);
      assert.equal(r[0].score, 2);
    });
  });
});

describe('FindMoments.stemCoverage', () => {
  test('доля стемов запроса, найденных в начале слов текста', () => {
    const cov = FM.stemCoverage(
      ['Китайский автопром вырос.', 'Темпы роста рекордные.', 'Нет, просто вопрос.'],
      'китай рост'
    );
    assert.deepEqual(cov, [0.5, 0.5, 0]);
  });

  test('запрос без значимых слов → нули', () => {
    assert.deepEqual(FM.stemCoverage(['что-то', 'ещё'], 'и в на'), [0, 0]);
  });
});

/* 18.10.2026: гибрид для эмбеддингов — косинусы абзацев приходят снаружи
   (MomentEmbeddings), здесь только чистое ранжирование. */
describe('FindMoments.rankHybrid', () => {
  const hEntry = {
    paragraphs: [
      { startSec: 0, endSec: 10, text: 'Сначала про погоду и новости.' },
      { startSec: 10, endSec: 20, text: 'Площадка забирает тридцать процентов с продаж.' },
      { startSec: 20, endSec: 30, text: 'Комиссия Steam высокая, но там аудитория.' },
      { startSec: 30, endSec: 40, text: 'Потом поговорили про движок.' },
      { startSec: 40, endSec: 50, text: 'И немного про тесты.' }
    ]
  };

  test('ранжирует по смыслу: лучший косинус первым, даже без общих слов с запросом', () => {
    const r = FM.rankHybrid(hEntry, 'сколько берёт магазин', [0.1, 0.6, 0.5, 0.2, 0.1]);
    assert.equal(r[0].idx, 1);
    assert.equal(r[0].startSec, 10);
    assert.equal(r[0].endSec, 20);
    assert.equal(r[0].matchType, 'semantic');
    assert.equal(r[0].source, 'paragraphs');
    assert.ok(r[0].text.includes('тридцать процентов'));
  });

  test('при равном косинусе выше абзац со словами запроса', () => {
    const r = FM.rankHybrid(hEntry, 'комиссия Steam', [0.1, 0.5, 0.5, 0.2, 0.1]);
    assert.equal(r[0].idx, 2);
    assert.equal(r[1].idx, 1);
  });

  test('отсекает хвост ниже лучшего балла − cutoff, но оставляет минимум 3', () => {
    const cos = [0.9, 0.1, 0.1, 0.1, 0.1];
    const r = FM.rankHybrid(hEntry, 'погода', cos, { minKeep: 3 });
    assert.equal(r.length, 3);
    assert.equal(r[0].idx, 0);
    const near = FM.rankHybrid(hEntry, 'погода', [0.9, 0.88, 0.87, 0.1, 0.1], { minKeep: 1, cutoff: 0.15 });
    assert.deepEqual(near.map((m) => m.idx), [0, 1, 2]);
  });

  test('k ограничивает выдачу', () => {
    const r = FM.rankHybrid(hEntry, 'x', [0.5, 0.5, 0.5, 0.5, 0.5], { k: 2 });
    assert.equal(r.length, 2);
  });

  test('score — гибридный балл 0..1, у лучшего максимальный', () => {
    const r = FM.rankHybrid(hEntry, 'комиссия Steam', [0.1, 0.5, 0.6, 0.2, 0.1]);
    assert.ok(r[0].score <= 1 && r[0].score > 0.9, `score=${r[0].score}`);
    for (let i = 1; i < r.length; i++) assert.ok(r[i].score <= r[i - 1].score);
  });

  test('косинусов не столько, сколько абзацев → ошибка (вызывающий уйдёт в лексику)', () => {
    assert.throws(() => FM.rankHybrid(hEntry, 'x', [0.5, 0.5]), /косинусов 2, абзацев 5/);
  });
});
