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
