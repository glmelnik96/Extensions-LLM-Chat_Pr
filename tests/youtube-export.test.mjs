import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadYouTubeExport } from './load-youtube-export.mjs';

const YT = loadYouTubeExport();

describe('YouTubeExport.formatTimestamp', () => {
  test('M:SS для < 1 часа', () => {
    assert.equal(YT.formatTimestamp(0), '0:00');
    assert.equal(YT.formatTimestamp(5), '0:05');
    assert.equal(YT.formatTimestamp(65), '1:05');
    assert.equal(YT.formatTimestamp(3599), '59:59');
  });

  test('H:MM:SS для ≥ 1 часа', () => {
    assert.equal(YT.formatTimestamp(3600), '1:00:00');
    assert.equal(YT.formatTimestamp(3725), '1:02:05');
    assert.equal(YT.formatTimestamp(7200), '2:00:00');
  });

  test('отрицательные → 0', () => {
    assert.equal(YT.formatTimestamp(-5), '0:00');
  });

  test('дробные секунды округляются вниз', () => {
    assert.equal(YT.formatTimestamp(5.9), '0:05');
    assert.equal(YT.formatTimestamp(60.4), '1:00');
  });
});

describe('YouTubeExport.formatChaptersForYouTube', () => {
  test('пустой массив → пустая строка', () => {
    assert.equal(YT.formatChaptersForYouTube([]), '');
    assert.equal(YT.formatChaptersForYouTube(null), '');
    assert.equal(YT.formatChaptersForYouTube(undefined), '');
  });

  test('первый маркер уже на 0:00 — оставляет', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 0, name: 'Вступление' },
      { timeSec: 60, name: 'Основная часть' }
    ]);
    const lines = r.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '0:00 Вступление');
    assert.equal(lines[1], '1:00 Основная часть');
  });

  test('первый маркер не на 0:00 — добавляет «Вступление»', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 30, name: 'Тема' },
      { timeSec: 90, name: 'Другая' }
    ]);
    const lines = r.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '0:00 Вступление');
    assert.equal(lines[1], '0:30 Тема');
    assert.equal(lines[2], '1:30 Другая');
  });

  test('первый маркер 0.3с — снимает на 0:00 (без дублирования)', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 0.3, name: 'Хук' },
      { timeSec: 60, name: 'Тема' }
    ]);
    const lines = r.split('\n');
    assert.equal(lines.length, 2, 'не должно появиться «Вступление» — есть свой маркер близко к 0');
    assert.equal(lines[0], '0:00 Хук');
  });

  test('сортировка по timeSec', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 120, name: 'Третья' },
      { timeSec: 0, name: 'Первая' },
      { timeSec: 60, name: 'Вторая' }
    ]);
    const lines = r.split('\n');
    assert.equal(lines[0], '0:00 Первая');
    assert.equal(lines[1], '1:00 Вторая');
    assert.equal(lines[2], '2:00 Третья');
  });

  test('маркер за 1 час → H:MM:SS формат', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 0, name: 'Старт' },
      { timeSec: 3725, name: 'После часа' }
    ]);
    const lines = r.split('\n');
    assert.equal(lines[1], '1:02:05 После часа');
  });

  test('пустое имя → «Глава»', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 0, name: '' },
      { timeSec: 60 }
    ]);
    const lines = r.split('\n');
    assert.equal(lines[0], '0:00 Глава');
    assert.equal(lines[1], '1:00 Глава');
  });

  test('одна глава — формат корректен (хоть и невалидно для YouTube ≥3)', () => {
    const r = YT.formatChaptersForYouTube([
      { timeSec: 0, name: 'Только одна' }
    ]);
    assert.equal(r, '0:00 Только одна');
  });

  test('не мутирует исходный массив', () => {
    const original = [{ timeSec: 30, name: 'A' }, { timeSec: 60, name: 'B' }];
    const snapshot = JSON.parse(JSON.stringify(original));
    YT.formatChaptersForYouTube(original);
    assert.deepEqual(original, snapshot, 'исходный массив не должен меняться');
  });

  test('non-array → пустая строка', () => {
    assert.equal(YT.formatChaptersForYouTube('not array'), '');
    assert.equal(YT.formatChaptersForYouTube({}), '');
  });
});
