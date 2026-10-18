import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadIife } from './helpers.mjs';

/* Инвариант конфигурации (18.10.2026): роли и цепочки фолбэков ссылаются только
   на модели из knownModels — курируемого списка чат-моделей, доступных проекту
   ключа. Иначе сбой основной модели уходил в фолбэк на 403 «not available for
   this project», и пользователь видел ошибку чужой модели. */
const D = loadIife('client/shared/fm-defaults.js', 'FM_DEFAULTS');
const known = D.knownModels.map((m) => m.id);

describe('fm-defaults: роли и фолбэки — только доступные модели', () => {
  test('текстовые роли ∈ knownModels (fastModel может быть пустым)', () => {
    for (const role of ['chatModel', 'fastModel', 'analysisModel', 'chapterModel', 'findMomentsModel', 'codeModel']) {
      if (role === 'fastModel' && D.fastModel === '') continue;
      assert.ok(known.includes(D[role]), role + '=' + D[role] + ' нет в knownModels');
    }
  });

  test('каждое звено modelFallbacks ∈ knownModels, без ссылки на саму себя', () => {
    for (const [primary, chain] of Object.entries(D.modelFallbacks)) {
      for (const fb of chain) {
        assert.ok(known.includes(fb), primary + ' → ' + fb + ' нет в knownModels');
        assert.notEqual(fb, primary, 'самоссылка ' + primary);
      }
    }
  });

  test('у каждой модели из knownModels есть цепочка фолбэков и тариф', () => {
    for (const id of known) {
      assert.ok((D.modelFallbacks[id] || []).length > 0, 'нет фолбэков для ' + id);
      assert.ok(D.pricing.models[id], 'нет тарифа для ' + id);
    }
  });
});
