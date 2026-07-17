/**
 * Тесты ReelsPipeline: чистая логика пайплайна «Рилс» (17.07.2026).
 *
 * Караоке-кьюи, правило точек, guard корректуры, ASS-генерация,
 * offset из vision-cx, ffmpeg-аргументы оверлея — всё без внешних зависимостей.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import assertLoose from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadReelsPipeline() {
  const filePath = path.join(__dirname, '..', 'client', 'shared', 'reels-pipeline.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = '})(window);';
  const idx = src.lastIndexOf(marker);
  if (idx === -1) throw new Error('reels-pipeline.js: expected footer ' + marker);
  src = src.slice(0, idx) + '})(root);' + src.slice(idx + marker.length);

  const root = {};
  const sandbox = { root, console, String, RegExp, Array, Object, JSON, Math, Number, Promise, Error, isFinite, parseInt, parseFloat, undefined };
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'reels-pipeline.js' });
  if (!root.ReelsPipeline) throw new Error('ReelsPipeline not attached to root');
  return root.ReelsPipeline;
}

const RP = loadReelsPipeline();

/* ═══ Правило точек ═══ */
describe('stripCueFinalPeriod', () => {
  it('точка в конце кью убирается', () =>
    assert.equal(RP.stripCueFinalPeriod('Привет мир.'), 'Привет мир'));
  it('?, !, … и ... остаются', () => {
    assert.equal(RP.stripCueFinalPeriod('Как дела?'), 'Как дела?');
    assert.equal(RP.stripCueFinalPeriod('Ура!'), 'Ура!');
    assert.equal(RP.stripCueFinalPeriod('Ну…'), 'Ну…');
    assert.equal(RP.stripCueFinalPeriod('Ну...'), 'Ну...');
  });
  it('точка в середине (в т.ч. конец 1-й строки) остаётся', () =>
    assert.equal(RP.stripCueFinalPeriod('Первое.\nВторое.'), 'Первое.\nВторое'));
  it('пустые/битые входы не падают', () => {
    assert.equal(RP.stripCueFinalPeriod(''), '');
    assert.equal(RP.stripCueFinalPeriod(null), '');
    assert.equal(RP.stripCueFinalPeriod('.'), '.');
  });
});

/* ═══ Караоке-кьюи ═══ */
describe('buildKaraokeCues', () => {
  it('char-weighted fallback: слова пропорциональны длине', () => {
    /* 'раз'=3, 'два'=3, 'три'=3, 'четыре'=6 → сумм=15, интервал=4с */
    const cues = RP.buildKaraokeCues([{ startSec: 10, endSec: 14, text: 'раз два три четыре' }], {});
    assert.equal(cues.length, 1);
    assert.equal(cues[0].words.length, 4);
    /* 'два': позиция 3/15..6/15 × 4с = 0.8..1.6 от start=10 */
    assertLoose.deepEqual(cues[0].words[1], { w: 'два', s: 10.8, e: 11.6 });
    assert.equal(cues[0].startSec, 10);
    assert.equal(cues[0].endSec, 14);
    /* первое слово начинается с start, последнее кончается на end */
    assert.equal(cues[0].words[0].s, 10);
    assert.ok(Math.abs(cues[0].words[3].e - 14) < 0.002);
  });
  it('word-level из Whisper используется как есть', () => {
    const seg = {
      startSec: 0, endSec: 3, text: 'привет мир',
      words: [{ w: 'привет', s: 0.2, e: 0.9 }, { w: 'мир', s: 1.1, e: 1.6 }]
    };
    const cues = RP.buildKaraokeCues([seg], {});
    assert.equal(cues[0].words[0].e, 0.9);
    assert.equal(cues[0].words[1].s, 1.1);
  });
  it('длинный сегмент режется: ≤2 строк по ≤20 симв, ≤4с; words попадают в свои кью', () => {
    const text = Array.from({ length: 20 }, (_, i) => 'слово' + i).join(' ');
    const cues = RP.buildKaraokeCues([{ startSec: 0, endSec: 20, text }], {});
    assert.ok(cues.length > 1);
    for (const c of cues) {
      assert.ok(c.text.split('\n').length <= 2);
      for (const ln of c.text.split('\n')) assert.ok(ln.length <= 20, 'строка ≤20: ' + ln);
      assert.ok(c.endSec - c.startSec <= 4 + 1e-9);
      assert.equal(c.words.map(w => w.w).join(' '), c.text.replace(/\n/g, ' '));
    }
    /* все слова сохранены, порядок сплошной */
    const all = cues.flatMap(c => c.words.map(w => w.w)).join(' ');
    assert.equal(all, text);
  });
  it('пустые/битые сегменты пропускаются', () => {
    const cues = RP.buildKaraokeCues(
      [{ startSec: 5, endSec: 5, text: 'x' }, null, { startSec: 0, endSec: 1, text: '  ' }], {});
    assert.equal(cues.length, 0);
  });
});

/* ═══ LLM-корректура: guard + применение ═══ */
describe('proofread', () => {
  it('guard: пунктуация/регистр — правка принята', () =>
    assert.equal(RP.proofreadGuardOk('привет, мир', 'Привет, мир!'), true));
  it('guard: исправление опечатки в слове (Левенштейн ≤2) — принято', () => {
    assert.equal(RP.proofreadGuardOk('превет мир', 'привет мир'), true);
    assert.equal(RP.proofreadGuardOk('карова даёт малако', 'корова даёт молоко'), true);
  });
  it('guard: добавленное/удалённое слово — отклонено', () => {
    assert.equal(RP.proofreadGuardOk('привет мир', 'привет весь мир'), false);
    assert.equal(RP.proofreadGuardOk('привет весь мир', 'привет мир'), false);
  });
  it('guard: заменённое слово (не опечатка) — отклонено', () => {
    assert.equal(RP.proofreadGuardOk('привет мир', 'здравствуй мир'), false);
    assert.equal(RP.proofreadGuardOk('кошка спит', 'собака спит'), false);
  });
  it('applyProofread: валидные правки применяются, переносы пересобраны, тайминги не тронуты', () => {
    const cues = [{
      startSec: 0, endSec: 2, text: 'превет\nмир',
      words: [{ w: 'превет', s: 0, e: 1 }, { w: 'мир', s: 1, e: 2 }]
    }];
    const r = RP.applyProofread(cues, [{ i: 0, text: 'привет мир' }]);
    assert.equal(r.applied, 1);
    assert.equal(r.rejected, 0);
    assert.equal(r.cues[0].text, 'привет\nмир');
    assert.equal(r.cues[0].words[0].w, 'привет');
    assert.equal(r.cues[0].words[0].s, 0);
    assert.equal(r.cues[0].words[1].e, 2);
    assert.equal(cues[0].text, 'превет\nмир', 'исходные кьюи не мутируются');
  });
  it('applyProofread: невалидная правка отклонена, битые i игнорируются', () => {
    const cues = [{ startSec: 0, endSec: 2, text: 'привет мир', words: [{ w: 'привет', s: 0, e: 1 }, { w: 'мир', s: 1, e: 2 }] }];
    const r = RP.applyProofread(cues, [{ i: 0, text: 'совсем другой текст' }, { i: 99, text: 'x' }, null]);
    assert.equal(r.applied, 0);
    assert.equal(r.rejected, 1);
    assert.equal(r.cues[0].text, 'привет мир');
  });
});

/* ═══ ASS-генерация ═══ */
describe('ASS', () => {
  const baseOpts = { w: 1080, h: 1920, fontName: 'SB Sans Text SemiBold', textColor: '#FFFFFF', hlColor: '#21A038' };
  it('assColor: #RRGGBB → &H00BBGGRR (BGR)', () => {
    assert.equal(RP.assColor('#21A038'), '&H0038A021');
    assert.equal(RP.assColor('#FFFFFF'), '&H00FFFFFF');
    assert.equal(RP.assColor('bad'), null);
    assert.equal(RP.assColor(null), null);
  });
  it('assTime: 61.234 → 0:01:01.23', () => {
    assert.equal(RP.assTime(61.234), '0:01:01.23');
    assert.equal(RP.assTime(0), '0:00:00.00');
    assert.equal(RP.assTime(3661.005), '1:01:01.00');
  });
  it('buildAss none: статичные Dialogue, стиль со шрифтом/цветом/PlayRes', () => {
    const ass = RP.buildAss(
      [{ startSec: 0, endSec: 2, text: 'привет\nмир', words: [] }],
      Object.assign({}, baseOpts, { anim: 'none' }));
    assert.ok(ass.includes('PlayResX: 1080') && ass.includes('PlayResY: 1920'));
    assert.ok(ass.includes('SB Sans Text SemiBold'));
    assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:02.00,Base,,0,0,0,,привет\\Nмир'));
  });
  it('buildAss color: \\k-теги в сантисекундах, лид первого слова поглощён', () => {
    const cue = { startSec: 1, endSec: 3, text: 'раз два', words: [{ w: 'раз', s: 1.5, e: 2 }, { w: 'два', s: 2, e: 3 }] };
    const ass = RP.buildAss([cue], Object.assign({}, baseOpts, { anim: 'color' }));
    /* раз: 1.0→2.0с = 100cs (лид 0.5 влит), два: 2.0→3.0с = 100cs */
    assert.ok(ass.includes('{\\k100}раз {\\k100}два'), ass);
    /* караоке: Primary = подсветка, Secondary = цвет текста */
    const styleLine = ass.split('\n').find(l => l.startsWith('Style: Base'));
    assert.ok(styleLine.includes('&H0038A021,&H00FFFFFF'), styleLine);
  });
  it('buildAss box: слой 0 текст + слой 1 пословные box-события', () => {
    const cue = { startSec: 0, endSec: 2, text: 'раз два', words: [{ w: 'раз', s: 0, e: 1 }, { w: 'два', s: 1, e: 2 }] };
    const ass = RP.buildAss([cue], Object.assign({}, baseOpts, { anim: 'box' }));
    assert.ok(ass.includes('Style: Box'));
    assert.equal((ass.match(/Dialogue: 1,/g) || []).length, 2);
    assert.equal((ass.match(/Dialogue: 0,/g) || []).length, 1);
    assert.ok(ass.includes('\\4a&HFF&'));
    /* box-события идут ПОД текстом (слой 1 не перекрывает слой 0? нет: слой 1 выше — но box рисуется BorderStyle=3 позади своего текста, текст слоя 1 прозрачный для не-текущих) */
    assert.ok(ass.includes('\\1a&HFF&'));
  });
  it('buildAss: переносы в karaoke-режиме сохраняются как \\N', () => {
    const cue = {
      startSec: 0, endSec: 2, text: 'раз\nдва',
      words: [{ w: 'раз', s: 0, e: 1 }, { w: 'два', s: 1, e: 2 }]
    };
    const ass = RP.buildAss([cue], Object.assign({}, baseOpts, { anim: 'color' }));
    assert.ok(ass.includes('{\\k100}раз\\N{\\k100}два'), ass);
  });
});

/* ═══ ffmpeg-аргументы оверлея ═══ */
describe('buildOverlayFfmpegArgs', () => {
  it('lavfi transparent + ass + prores4444 с альфой', () => {
    const args = RP.buildOverlayFfmpegArgs({ assPath: '/t/s.ass', w: 1080, h: 1920, fps: 25, durationSec: 12.5, outPath: '/t/o.mov' });
    const s = args.join(' ');
    assert.ok(s.includes('color=black@0.0:s=1080x1920:r=25'), s);
    assert.ok(s.includes('ass='), s);
    /* alpha=1 обязателен: без него vf_ass не пишет в альфа-плоскость →
       оверлей в Premiere полностью прозрачен (live-баг 17.07.2026) */
    assert.ok(s.includes(":alpha=1"), s);
    assert.ok(s.includes('prores_ks') && s.includes('yuva444p10le') && s.includes('-t 12.5'), s);
    assert.equal(args[args.length - 1], '/t/o.mov');
  });
  it('экранирование пути ass для Windows (C\\:/…)', () => {
    const args = RP.buildOverlayFfmpegArgs({ assPath: 'C:\\Users\\Глеб\\s.ass', w: 1080, h: 1920, fps: 25, durationSec: 1, outPath: 'o.mov' });
    assert.ok(args.join(' ').includes('C\\:/Users/Глеб/s.ass'), args.join(' '));
  });
});

/* ═══ План vision-запросов ═══ */
describe('visionPlan', () => {
  it('уникальные mediaPath, nest: пропускается с причиной', () => {
    const clips = [
      { name: 'A', mediaPath: '/a.mp4' },
      { name: 'B', mediaPath: '/a.mp4' },
      { name: 'N', mediaPath: 'nest:xyz' },
      { name: 'C', mediaPath: '/c.mp4' }
    ];
    const r = RP.visionPlan(clips);
    assertLoose.deepEqual(r.paths, ['/a.mp4', '/c.mp4']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'N');
  });
  it('пустые/битые клипы не ломают план', () => {
    const r = RP.visionPlan([null, { name: 'X' }, { name: 'Y', mediaPath: '' }]);
    assertLoose.deepEqual(r.paths, []);
  });
});

/* ═══ Char-weighted выравнивание + вычитание тишин ═══ */
describe('alignWordsChar', () => {
  it('char-weighted: длинное слово получает больше времени', () => {
    const out = RP.alignWordsChar(['я', 'коротко', 'сверхдлинное'], 0, 10, null);
    assert.equal(out.length, 3);
    assert.equal(out[0].s, 0);
    assert.equal(out[2].e, 10);
    const d0 = out[0].e - out[0].s;
    const d2 = out[2].e - out[2].s;
    assert.ok(d2 > d0 * 3, `d0=${d0} d2=${d2}`);
    /* слова стыкуются без дыр */
    assert.ok(Math.abs(out[0].e - out[1].s) < 0.002);
    assert.ok(Math.abs(out[1].e - out[2].s) < 0.002);
  });
  it('тишина в середине сегмента выкидывается из раскладки', () => {
    /* сегмент 0..10, тишина 4..8 → речь 0..4 и 8..10 (6с) */
    const sil = [{ startSec: 4, endSec: 8 }];
    const out = RP.alignWordsChar(['aa', 'bb', 'cc'], 0, 10, sil);
    /* ни одно слово не должно НАЧИНАТЬСЯ внутри тишины */
    for (const w of out) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), `слово начинается в тишине: ${JSON.stringify(w)}`);
    }
    /* последнее слово тянется до конца сегмента */
    assert.ok(Math.abs(out[2].e - 10) < 0.002);
    /* первое начинается с начала */
    assert.equal(out[0].s, 0);
  });
  it('тишина < 0.3с игнорируется', () => {
    const sil = [{ startSec: 5, endSec: 5.2 }];
    const out = RP.alignWordsChar(['aa', 'bb'], 0, 10, sil);
    /* раскладка как без тишин: aa занимает первую половину */
    assert.ok(Math.abs(out[0].e - 5) < 0.01, JSON.stringify(out));
  });
  it('тишина накрывает весь сегмент → деградация на весь интервал', () => {
    const sil = [{ startSec: 0, endSec: 10 }];
    const out = RP.alignWordsChar(['aa', 'bb'], 2, 8, sil);
    assert.equal(out[0].s, 2);
    assert.ok(Math.abs(out[1].e - 8) < 0.002);
  });
  it('толерантность к форме {start,end} (deterministic-pipelines style)', () => {
    const sil = [{ start: 4, end: 8 }];
    const out = RP.alignWordsChar(['aa', 'bb', 'cc'], 0, 10, sil);
    for (const w of out) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), JSON.stringify(w));
    }
  });
});

describe('buildKaraokeCues + silences', () => {
  it('opts.silences прокидывается в раскладку слов', () => {
    const segs = [{ startSec: 0, endSec: 10, text: 'раз два три' }];
    const sil = [{ startSec: 4, endSec: 8 }];
    const cues = RP.buildKaraokeCues(segs, { silences: sil });
    assert.ok(cues.length >= 1, 'хотя бы один кью');
    /* ни одно слово не должно НАЧИНАТЬСЯ внутри тишины */
    const allWords = cues.flatMap(c => c.words);
    assert.equal(allWords.length, 3, 'все 3 слова сохранены');
    for (const w of allWords) {
      assert.ok(!(w.s > 4.001 && w.s < 7.999), `слово в тишине: ${JSON.stringify(w)}`);
    }
  });
});

/* ═══ SRT-генерация ═══ */
describe('buildSrt', () => {
  it('формат: номер, HH:MM:SS,mmm --> ..., текст, пустая строка', () => {
    const cues = [
      { startSec: 0, endSec: 1.5, text: 'Привет', words: [] },
      { startSec: 61.25, endSec: 3661.007, text: 'Две\nстроки', words: [] }
    ];
    const srt = RP.buildSrt(cues);
    const expected =
      '1\n00:00:00,000 --> 00:00:01,500\nПривет\n\n' +
      '2\n00:01:01,250 --> 01:01:01,007\nДве\nстроки\n';
    assert.equal(srt, expected);
  });
  it('пустой вход → пустая строка', () => {
    assert.equal(RP.buildSrt([]), '');
  });
  it('невалидное время → 00:00:00,000, не NaN', () => {
    assert.equal(RP.srtTime(undefined), '00:00:00,000');
    assert.equal(RP.srtTime(NaN), '00:00:00,000');
    assert.equal(RP.srtTime(-5), '00:00:00,000');
  });
});

/* ═══ Пересборка кью после правки текста (модалка) ═══ */
describe('rebuildCueText', () => {
  const cue = {
    startSec: 10, endSec: 14,
    text: 'старый текст',
    words: [{ w: 'старый', s: 10, e: 12 }, { w: 'текст', s: 12, e: 14 }]
  };
  it('границы кью не двигаются, words пересобраны char-weighted', () => {
    const out = RP.rebuildCueText(cue, 'новый исправленный текст', {});
    assert.equal(out.startSec, 10);
    assert.equal(out.endSec, 14);
    assert.equal(out.words.length, 3);
    assert.equal(out.words[0].s, 10);
    assert.ok(Math.abs(out.words[2].e - 14) < 0.002);
    /* «исправленный» длиннее «новый» → больше времени */
    assert.ok((out.words[1].e - out.words[1].s) > (out.words[0].e - out.words[0].s));
  });
  it('перенос строк пересобирается greedy (20 симв / 2 строки по умолчанию)', () => {
    const out = RP.rebuildCueText(cue, 'очень длинная фраза которая не влезает в одну строку', {});
    assert.ok(out.text.indexOf('\n') !== -1, out.text);
    /* число слов в text = числу words */
    assert.equal(out.text.split(/[\n ]/).length, out.words.length);
  });
  it('тишины вычитаются при пересборке', () => {
    const out = RP.rebuildCueText(cue, 'раз два', { silences: [{ startSec: 11, endSec: 13 }] });
    for (const w of out.words) {
      assert.ok(!(w.s > 11.001 && w.s < 12.999), JSON.stringify(w));
    }
  });
  it('пустой текст → null', () => {
    assert.equal(RP.rebuildCueText(cue, '   ', {}), null);
  });
  it('исходный кью не мутирован', () => {
    RP.rebuildCueText(cue, 'другое', {});
    assert.equal(cue.text, 'старый текст');
    assert.equal(cue.words[0].w, 'старый');
  });
  it('fallback multi-word: не влезает → пополам, ровно один \\n, words === split', () => {
    /* Фраза из 7 слов: каждое слово 6–12 символов, ни одна пара подряд
       не влезает в 20 символов (min: «первое пятос» = 18 — влезает, но
       третий слот уже нет), поэтому _wrapWords(words,20,2) возвращает null
       и срабатывает best-effort: half = Math.ceil(7/2) = 4. */
    const phrase = 'первое второеслово третьеслово четвёртое пятоеслово шестоеслово седьмоеслово';
    const out = RP.rebuildCueText(cue, phrase, {});
    const n = phrase.split(' ').length; // 7
    const half = Math.ceil(n / 2);     // 4
    /* Ровно один перенос строки */
    assert.equal((out.text.match(/\n/g) || []).length, 1, 'ровно один \\n');
    /* Число токенов совпадает с числом words */
    assert.equal(out.text.split(/[\n ]/).length, out.words.length,
      'word-count parity text vs words');
    /* Первая строка содержит ceil(n/2) слов */
    assert.equal(out.text.split('\n')[0].split(' ').length, half,
      'первая строка = Math.ceil(n/2) слов');
  });
  it('fallback single oversized word: текст без \\n, words[0].s === startSec', () => {
    /* Одно слово длиной 34 символа > maxChars=20 → _wrapWords → null,
       best-effort: wrapped = words[0] (строка как есть). */
    const word = 'сверхдлинноесловобезпробеловвообще';
    const out = RP.rebuildCueText(cue, word, {});
    assert.equal(out.text, word, 'текст совпадает со словом');
    assert.ok(out.text.indexOf('\n') === -1, 'нет переноса строки');
    assert.equal(out.words.length, 1, 'ровно одно слово');
    assert.equal(out.words[0].s, cue.startSec, 'words[0].s === startSec');
  });
});

/* ═══ Vision offset ═══ */
describe('offsetPctFromCx', () => {
  it('центр → 0, края → ±50 с клампом', () => {
    assert.equal(RP.offsetPctFromCx(0.5), 0);
    assert.equal(RP.offsetPctFromCx(0.75), 25);
    assert.equal(RP.offsetPctFromCx(1.2), 50);
    assert.equal(RP.offsetPctFromCx(-0.2), -50);
  });
  it('невалидный cx → null', () => {
    assert.equal(RP.offsetPctFromCx('x'), null);
    assert.equal(RP.offsetPctFromCx(undefined), null);
    assert.equal(RP.offsetPctFromCx(NaN), null);
  });
});
