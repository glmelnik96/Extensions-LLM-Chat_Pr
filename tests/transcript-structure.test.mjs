import { test, describe } from 'node:test';
import assert from 'node:assert';
import { loadTranscriptStructure } from './load-transcript-structure.mjs';

const TS = loadTranscriptStructure();

/* ─── buildParagraphs ─── */
describe('TranscriptStructure.buildParagraphs', () => {
  const segs = [
    { startSec: 0.0, endSec: 2.5, text: 'Привет всем.' },
    { startSec: 2.6, endSec: 5.0, text: 'Сегодня мы поговорим о монтаже.' },
    // Long pause before next segment
    { startSec: 7.0, endSec: 10.0, text: 'Первый пункт — структура.' },
    { startSec: 10.1, endSec: 13.0, text: 'Второй пункт — ритм.' },
  ];

  test('группирует сегменты в абзацы по паузам', () => {
    const paras = TS.buildParagraphs(segs, []);
    assert.ok(paras.length >= 2, 'должно быть >= 2 абзацев');
    assert.ok(paras[0].text.includes('Привет'));
    assert.ok(paras[0].segmentIdxs.length >= 1);
  });

  test('sentenceEnds + gap >= 0.35 разбивает абзац', () => {
    const paras = TS.buildParagraphs(segs, []);
    const found = paras.find(p => p.text.includes('структура'));
    assert.ok(found, 'абзац со "структура" должен быть отдельным');
  });

  test('пустой вход → пустой результат', () => {
    assert.strictEqual(TS.buildParagraphs([], []).length, 0);
    assert.strictEqual(TS.buildParagraphs(null, []).length, 0);
  });
});

/* ─── analyzeForCutsWithLLM (segment-level) ─── */
describe('TranscriptStructure.analyzeForCutsWithLLM', () => {
  test('без CloudRuClient → localOnly результат (локальные детекторы)', async () => {
    const result = await TS.analyzeForCutsWithLLM(
      [{ i: 0, startSec: 0, endSec: 5, text: 'Тест' }],
      { CloudRuClient: null }
    );
    assert.strictEqual(result.labels.length, 1);
    assert.strictEqual(result.localOnly, true);
    assert.strictEqual(result.labels[0].label, 'content');
  });

  test('пустые сегменты → пустой результат', async () => {
    const result = await TS.analyzeForCutsWithLLM([], {});
    assert.strictEqual(result.labels.length, 0);
  });

  test('mock CloudRuClient → корректный разбор ответа с новыми категориями', async () => {
    const mockCC = {
      chatCompletions: () => Promise.resolve({
        choices: [{
          message: {
            content: JSON.stringify({
              labels: [
                { i: 0, label: 'intro', reason: 'приветствие' },
                { i: 1, label: 'content', reason: '' },
                { i: 2, label: 'outtake', reason: 'фальстарт, начал заново' },
                { i: 3, label: 'artifact', reason: 'шум транскрибации' }
              ]
            })
          }
        }]
      })
    };

    const segments = [
      { i: 0, startSec: 0, endSec: 3, text: 'Привет всем.' },
      { i: 1, startSec: 3, endSec: 8, text: 'Наш продукт вырос на 30%.' },
      { i: 2, startSec: 8, endSec: 11, text: 'Блин, давай заново.' },
      { i: 3, startSec: 11, endSec: 13, text: 'И Валерий Курас' }
    ];

    const result = await TS.analyzeForCutsWithLLM(segments, {
      CloudRuClient: mockCC,
      settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' }
    });

    assert.strictEqual(result.labels.length, 4);
    assert.strictEqual(result.labels[0].label, 'intro');
    assert.strictEqual(result.labels[1].label, 'content');
    assert.strictEqual(result.labels[2].label, 'outtake');
    assert.strictEqual(result.labels[3].label, 'artifact');
    assert.strictEqual(result.stats.intro, 1);
    assert.strictEqual(result.stats.outtake, 1);
    assert.strictEqual(result.stats.artifact, 1);
    assert.strictEqual(result.stats.content, 1);
    assert.strictEqual(result.chunks, 1);
    assert.strictEqual(result.totalSegments, 4);
  });

  test('не классифицированные сегменты → content по умолчанию', async () => {
    const mockCC = {
      chatCompletions: () => Promise.resolve({
        choices: [{
          message: {
            content: JSON.stringify({
              labels: [
                { i: 0, label: 'filler', reason: 'мычание' }
                // i=1 пропущен
              ]
            })
          }
        }]
      })
    };

    const segments = [
      { i: 0, startSec: 0, endSec: 3, text: 'Ээ...' },
      { i: 1, startSec: 3, endSec: 8, text: 'Важный контент.' }
    ];

    const result = await TS.analyzeForCutsWithLLM(segments, {
      CloudRuClient: mockCC,
      settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' }
    });

    assert.strictEqual(result.labels.length, 2);
    assert.strictEqual(result.labels[0].label, 'filler');
    assert.strictEqual(result.labels[1].label, 'content');
  });

  test('ошибка API → все сегменты content', async () => {
    const mockCC = {
      chatCompletions: () => Promise.reject(new Error('network error'))
    };

    const segments = [
      { i: 0, startSec: 0, endSec: 5, text: 'Тест' },
      { i: 1, startSec: 5, endSec: 10, text: 'Тест 2' }
    ];

    const result = await TS.analyzeForCutsWithLLM(segments, {
      CloudRuClient: mockCC,
      settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' }
    });

    assert.strictEqual(result.labels.length, 2);
    assert.ok(result.labels.every(l => l.label === 'content'));
  });

  test('чанкинг: >50 сегментов → несколько вызовов', async () => {
    let callCount = 0;
    const mockCC = {
      chatCompletions: (opts) => {
        callCount++;
        const input = JSON.parse(opts.messages[1].content.split('\n')[0]);
        const labels = input.segments.map(s => ({ i: s.i, label: 'content', reason: '' }));
        return Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ labels }) } }]
        });
      }
    };

    const segments = [];
    for (let i = 0; i < 120; i++) {
      segments.push({ i, startSec: i * 5, endSec: (i + 1) * 5, text: 'Сегмент ' + i });
    }

    const result = await TS.analyzeForCutsWithLLM(segments, {
      CloudRuClient: mockCC,
      settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' }
    });

    assert.ok(callCount >= 2, 'должно быть >= 2 вызовов API');
    assert.strictEqual(result.chunks, 3); // ceil(120/50) = 3
    assert.strictEqual(result.labels.length, 120);
    assert.strictEqual(result.totalSegments, 120);
  });

  test('текст сегментов усекается до 50 слов в API-запросе', async () => {
    let sentText = '';
    const mockCC = {
      chatCompletions: (opts) => {
        sentText = opts.messages[1].content;
        return Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                labels: [{ i: 0, label: 'content', reason: '' }]
              })
            }
          }]
        });
      }
    };

    const longText = Array(100).fill('слово').join(' '); // 100 слов
    await TS.analyzeForCutsWithLLM(
      [{ i: 0, startSec: 0, endSec: 30, text: longText }],
      {
        CloudRuClient: mockCC,
        settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' }
      }
    );

    const parsed = JSON.parse(sentText.split('\n')[0]);
    const segText = parsed.segments[0].text;
    const wordCount = segText.replace('…', '').trim().split(/\s+/).length;
    assert.ok(wordCount <= 50, 'текст должен быть усечён до ≤50 слов, получено ' + wordCount);
    assert.ok(segText.endsWith('…'), 'усечённый текст должен заканчиваться на …');
  });

  test('onProgress вызывается на каждой фазе', async () => {
    const phases = [];
    const mockCC = {
      chatCompletions: () => Promise.resolve({
        choices: [{
          message: {
            content: JSON.stringify({
              labels: [{ i: 0, label: 'content', reason: '' }]
            })
          }
        }]
      })
    };

    await TS.analyzeForCutsWithLLM(
      [{ i: 0, startSec: 0, endSec: 5, text: 'Тест' }],
      {
        CloudRuClient: mockCC,
        settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' },
        onProgress: (ev) => phases.push(ev.phase)
      }
    );

    assert.ok(phases.includes('local_done'), 'должен быть phase=local_done');
    assert.ok(phases.includes('done'), 'должен быть phase=done');
  });
});

/* ─── P0-2: Local Detectors ─── */
describe('TranscriptStructure.detectFillers', () => {
  test('чистые fillers → label=filler', () => {
    const segs = [
      { i: 0, startSec: 0, endSec: 2, text: 'ну ээ ммм' },
      { i: 1, startSec: 2, endSec: 5, text: 'типа вот как бы' },
      { i: 2, startSec: 5, endSec: 10, text: 'Это важная мысль о стратегии бизнеса' }
    ];
    const result = TS.detectFillers(segs);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].i, 0);
    assert.strictEqual(result[0].label, 'filler');
    assert.strictEqual(result[1].i, 1);
    assert.strictEqual(result[1].label, 'filler');
  });

  test('смешанный сегмент → НЕ filler', () => {
    const segs = [
      { i: 0, startSec: 0, endSec: 5, text: 'ну вот мы пришли к важному выводу о рынке недвижимости' }
    ];
    const result = TS.detectFillers(segs);
    assert.strictEqual(result.length, 0);
  });
});

describe('TranscriptStructure.detectIntroOutro', () => {
  test('приветствие в начале → intro', () => {
    const segs = [
      { i: 0, startSec: 0, endSec: 4, text: 'Всем привет, с вами канал ТехноБлог' },
      { i: 1, startSec: 4, endSec: 20, text: 'Сегодня разберём архитектуру микросервисов' }
    ];
    const result = TS.detectIntroOutro(segs, 300);
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].label, 'intro');
  });

  test('прощание в конце → outro', () => {
    const segs = [];
    for (let i = 0; i < 20; i++) {
      segs.push({ i: i, startSec: i * 10, endSec: (i + 1) * 10, text: 'Контент сегмент номер ' + i });
    }
    segs.push({ i: 20, startSec: 200, endSec: 210, text: 'Подписывайтесь на канал, ставьте лайк' });
    const result = TS.detectIntroOutro(segs, 210);
    const outros = result.filter(r => r.label === 'outro');
    assert.ok(outros.length >= 1);
  });
});

describe('TranscriptStructure.detectArtifacts', () => {
  test('короткая повторяющаяся фраза (≤5 слов, ≥5 раз) → artifact', () => {
    const segs = [];
    for (let i = 0; i < 6; i++) {
      segs.push({ i: i, startSec: i * 5, endSec: (i + 1) * 5, text: 'И Валерий Курас представляет' });
    }
    const result = TS.detectArtifacts(segs);
    /* Первое вхождение оставляется, остальные 5 — artifacts */
    assert.strictEqual(result.length, 5);
    assert.ok(result.every(r => r.label === 'artifact'));
  });
});

describe('TranscriptStructure.runLocalDetectors', () => {
  test('объединяет fillers + intro + artifacts', () => {
    const segs = [
      { i: 0, startSec: 0, endSec: 3, text: 'Всем привет друзья' },
      { i: 1, startSec: 3, endSec: 6, text: 'ну ээ ммм' },
      { i: 2, startSec: 6, endSec: 10, text: 'Важный контент о бизнесе' }
    ];
    const result = TS.runLocalDetectors(segs);
    assert.ok(result.labels.length >= 2);
    const labels = {};
    result.labels.forEach(l => { labels[l.label] = (labels[l.label] || 0) + 1; });
    assert.ok(labels.intro >= 1 || labels.filler >= 1);
  });

  test('с фильтром tasks=["filler"] — только fillers', () => {
    const segs = [
      { i: 0, startSec: 0, endSec: 3, text: 'Всем привет друзья' },
      { i: 1, startSec: 3, endSec: 6, text: 'ну ээ ммм' }
    ];
    const result = TS.runLocalDetectors(segs, { tasks: ['filler'] });
    assert.ok(result.labels.every(l => l.label === 'filler'));
  });
});

/* ─── isParagraphsStale (HIGH 6 мая 2026) ─── */
describe('TranscriptStructure.isParagraphsStale', () => {
  test('нет paragraphs → не stale (нечего перестраивать)', () => {
    assert.strictEqual(TS.isParagraphsStale({}), false);
    assert.strictEqual(TS.isParagraphsStale({ paragraphs: [], segments: [{ startSec: 0, endSec: 5 }] }), false);
  });

  test('нет segments → не stale', () => {
    const entry = {
      paragraphs: [{ startSec: 0, endSec: 5, segmentIdxs: [0] }],
      segments: []
    };
    assert.strictEqual(TS.isParagraphsStale(entry), false);
  });

  test('aligned paragraphs → not stale', () => {
    const entry = {
      segments: [
        { startSec: 0, endSec: 3.5 },
        { startSec: 3.5, endSec: 8.0 },
        { startSec: 9.0, endSec: 14.0 }
      ],
      paragraphs: [
        { startSec: 0, endSec: 8.0, segmentIdxs: [0, 1] },
        { startSec: 9.0, endSec: 14.0, segmentIdxs: [2] }
      ]
    };
    assert.strictEqual(TS.isParagraphsStale(entry), false);
  });

  test('segIdx out of range → stale', () => {
    /* Кейс из реального бага 6 мая 2026: после ripple_delete осталось 14 сегментов,
       но paragraphs[5].segmentIdxs=[14..21] ссылаются на удалённые. */
    const entry = {
      segments: [
        { startSec: 0, endSec: 3.5 },
        { startSec: 3.5, endSec: 8.0 }
      ],
      paragraphs: [
        { startSec: 0, endSec: 8.0, segmentIdxs: [0, 1] },
        { startSec: 10, endSec: 20, segmentIdxs: [2, 3, 4] }  /* indices >= length */
      ]
    };
    assert.strictEqual(TS.isParagraphsStale(entry), true);
  });

  test('drift > 1с между paragraph.startSec и segments[idxs[0]].startSec → stale', () => {
    /* Реальный кейс: paragraph[1] утверждает 35.18-43.84, segIdxs=[6,7],
       но фактический seg[6].startSec=34.00 — drift 1.18с → stale. */
    const entry = {
      segments: [
        { startSec: 0, endSec: 34.0 },
        { startSec: 34.0, endSec: 42.66 }
      ],
      paragraphs: [
        { startSec: 0, endSec: 34.0, segmentIdxs: [0] },
        { startSec: 35.18, endSec: 43.84, segmentIdxs: [1] }  /* drift 1.18с */
      ]
    };
    assert.strictEqual(TS.isParagraphsStale(entry), true);
  });

  test('малый drift (≤1с) → not stale (допустимая погрешность округления)', () => {
    const entry = {
      segments: [
        { startSec: 0.0, endSec: 5.0 },
        { startSec: 5.5, endSec: 10.0 }
      ],
      paragraphs: [
        { startSec: 0.0, endSec: 5.0, segmentIdxs: [0] },
        { startSec: 5.6, endSec: 10.1, segmentIdxs: [1] }  /* drift 0.1с */
      ]
    };
    assert.strictEqual(TS.isParagraphsStale(entry), false);
  });

  test('rebuild через buildStructure после stale-detect → not stale', () => {
    const entry = {
      segments: [
        { startSec: 0, endSec: 3, text: 'Привет всем.' },
        { startSec: 3.5, endSec: 8, text: 'Сегодня про монтаж.' }
      ],
      paragraphs: [
        { startSec: 100, endSec: 200, segmentIdxs: [55, 66] }  /* мусор */
      ],
      audioAnalysis: { silences: [] }
    };
    assert.strictEqual(TS.isParagraphsStale(entry), true);
    TS.buildStructure(entry);
    assert.strictEqual(TS.isParagraphsStale(entry), false);
    assert.ok(entry.paragraphs.length >= 1);
  });
});

describe('TranscriptStructure.analyzeForCutsWithLLM + local pre-labels', () => {
  test('filler сегменты НЕ отправляются в LLM', async () => {
    let llmSegments = [];
    const mockCC = {
      chatCompletions: (opts) => {
        const msg = opts.messages.find(m => m.role === 'user');
        if (msg) {
          try { llmSegments = JSON.parse(msg.content.split('\n')[0]).segments; } catch(e) {}
        }
        return Promise.resolve({
          choices: [{ message: { content: JSON.stringify({
            labels: llmSegments.map(s => ({ i: s.i, label: 'content', reason: '' }))
          })}}]
        });
      }
    };

    const segs = [
      { i: 0, startSec: 0, endSec: 3, text: 'ну ээ ммм вот' },
      { i: 1, startSec: 3, endSec: 8, text: 'Важное обсуждение стратегии развития компании на рынке' }
    ];

    const result = await TS.analyzeForCutsWithLLM(segs, {
      CloudRuClient: mockCC,
      settings: { baseUrl: 'http://test', apiKey: 'key', chatModel: 'test' },
      tasks: ['filler']
    });

    /* Сегмент 0 должен быть размечен локально как filler, НЕ отправлен в LLM */
    assert.strictEqual(result.labels.length, 2);
    assert.strictEqual(result.labels[0].label, 'filler');
    assert.ok(result.labels[0].reason.includes('[local]'));
    /* LLM должен был получить только сегмент 1 */
    assert.ok(llmSegments.length <= 1, 'LLM должен получить ≤1 сегмент, получил ' + llmSegments.length);
  });
});
