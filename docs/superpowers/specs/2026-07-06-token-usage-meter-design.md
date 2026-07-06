# Счётчик токенов и стоимости сессии (₽ по тарифам Cloud.ru)

**Дата:** 2026-07-06
**Статус:** дизайн утверждён, к реализации

## Цель

Показывать в панели один суммарный бейдж за сессию: сколько токенов (вход/выход)
израсходовано на LLM-вызовы и сколько это стоит в рублях по тарифам Cloud.ru,
включая стоимость транскрипции Whisper (тарифицируется посекундно).

Мерило успеха: пользователь в любой момент видит накопленный расход сессии, не
покидая панель. Точность ₽ соответствует официальным тарифам Cloud.ru.

## Тарифы Cloud.ru (снято со скриншотов каталога 2026-07-06)

| Модель                | Роль(и)                     | Вход ₽/1M | Выход ₽/1M |
|-----------------------|-----------------------------|-----------|------------|
| zai-org/GLM-5.1       | chat / analysis / findMoments | 198.86  | 829.60     |
| deepseek-ai/DeepSeek-V4-Pro | code                  | 183.00    | 732.00     |
| zai-org/GLM-4.7       | chapter / fast              | 549.00    | 793.00     |
| openai/gpt-oss-120b   | резерв                      | 15.86     | 61.00      |
| moonshotai/Kimi-K2.6  | резерв                      | 175.68    | 725.90     |
| openai/whisper-large-v3 | транскрипция              | 0.01 ₽/сек аудио (=0.6 ₽/мин) | — |

> ⚠ Важно: **GLM-4.7 больше НЕ бесплатна** (ранее в комментариях кода значилась
> FREE). Актуально 549/793 ₽/M. chapterModel и fastModel теперь платные.

Прочие модели каталога (GigaChat, MiniMax, Qwen) не назначены на роли — их тарифы
можно занести в карту для полноты, но они не вызываются.

## Архитектура

Три единицы, слабо связанные через `global` (как `FM_DEFAULTS`).

### 1. Карта тарифов — `fm-defaults.js`

Добавить машиночитаемый объект `FM_DEFAULTS.pricing`:

```js
pricing: {
  currency: '₽',
  models: {
    'zai-org/GLM-5.1':            { inPerM: 198.86, outPerM: 829.60 },
    'deepseek-ai/DeepSeek-V4-Pro':{ inPerM: 183.00, outPerM: 732.00 },
    'zai-org/GLM-4.7':            { inPerM: 549.00, outPerM: 793.00 },
    'openai/gpt-oss-120b':        { inPerM: 15.86,  outPerM: 61.00 },
    'moonshotai/Kimi-K2.6':       { inPerM: 175.68, outPerM: 725.90 }
  },
  whisperPerSec: 0.01
}
```

Цены раньше жили только в комментарии-шапке; выносим в объект. Комментарий-шапку
обновить (GLM-4.7 не FREE).

### 2. Накопитель — `client/shared/usage-meter.js` (новый, браузерный IIFE)

Публикует `global.UsageMeter` со state сессии:

- `recordChat(model, usage)` — `usage = {prompt_tokens, completion_tokens}`.
  Прибавляет токены; ₽ = `prompt/1e6*inPerM + completion/1e6*outPerM`.
  Модель не в карте → 0 ₽ (тихо), но токены суммируются.
  Битый/отсутствующий `usage` → no-op.
- `recordWhisper(seconds)` — прибавляет `seconds`; ₽ += `seconds * whisperPerSec`.
- `getSummary()` → `{ inTokens, outTokens, totalTokens, whisperSec, rubles }`.
- `reset()` — обнуляет.
- `onChange(cb)` — регистрирует колбэк, дёргается после каждой записи (для бейджа).

Чистая логика, без DOM и сети. Тарифы читает из `FM_DEFAULTS.pricing`.

### 3. Точка сбора — `cloudru-client.js`

Единственный choke point: все LLM-вызовы идут через `chatCompletions`, вся
транскрипция — через `transcribeAudio`. Внутри, если `global.UsageMeter` доступен:

- `chatCompletions`: перед возвратом → `UsageMeter.recordChat(model, resp.usage)`.
  Работает и для нестриминга (уже есть `data.usage`), и для стриминга (см. поток).
- `transcribeAudio`: после парса ответа → `UsageMeter.recordWhisper(duration)`.

Слабая связь: `if (global.UsageMeter) UsageMeter.recordChat(...)` — клиент не
зависит жёстко от метра (как от `FM_DEFAULTS`).

### 4. Бейдж — `client/unified/panel.js` + `styles.css`

Компактный текст в статус-области: `Σ 12.3K↑ 4.5K↓ · 4.82 ₽`.
Обновляется по `UsageMeter.onChange`. Скрыт до первого вызова.

## Поток данных

**Нестриминг** (analysis/chapters/structured): ответ содержит
`data.usage = {prompt_tokens, completion_tokens, total_tokens}`. Пишем как есть.
Модель — из `data.model` (fallback `opts.model`).

**Стриминг** (`parseSSEStream`): usage сейчас теряется. Добавляем в тело запроса
`stream_options: { include_usage: true }`. Провайдер шлёт финальный чанк с
`choices: []` и `usage`. В `parseSSEStream` ловим `chunk.usage`, возвращаем в
агрегированном объекте `{ choices, model, usage }`. Далее — общий код-путь
`recordChat`.

**Whisper** (`transcribeAudio`): `response_format: verbose_json` возвращает
`duration` (сек аудио). При чанкинге каждый POST добавляет свои секунды —
суммируется естественно. Формат без `duration` → 0 (no-op).

**Формула ₽:**
```
rub_chat    = inTok/1e6 * inPerM + outTok/1e6 * outPerM
rub_whisper = seconds * whisperPerSec
rubles      = Σ rub_chat + Σ rub_whisper
```

## Граничные случаи

- Модель не в карте тарифов → 0 ₽, токены суммируются (новая модель не роняет чат).
- `usage` отсутствует (провайдер не прислал) → запись пропускается.
- Abort/ошибка до ответа → ничего не пишется.
- Whisper без `duration` → 0 сек.

## Тесты

`tests/usage-meter.test.mjs` (`node --test`, IIFE-загрузка как
`load-nest-reconstruct.mjs`):

- `recordChat` GLM-5.1: 1M вход + 1M выход → 198.86 + 829.60 = 1028.46 ₽.
- `recordChat` DeepSeek: проверка формулы.
- неизвестная модель → 0 ₽, токены суммируются.
- `recordWhisper(120)` → 1.20 ₽.
- накопление нескольких вызовов → верная сумма, `getSummary`.
- битый/отсутствующий `usage` → без падения, счётчик не растёт.
- `onChange` дёргается при записи; `reset` обнуляет.

## YAGNI (не делаем)

Персистентность между сессиями, экспорт CSV, лимиты/алерты, разбивка по моделям
в UI (выбрано «суммарно»), настройка валюты.

## Затрагиваемые файлы

- `client/shared/fm-defaults.js` — карта `pricing` + обновить шапку (GLM-4.7 не FREE).
- `client/shared/usage-meter.js` — новый.
- `client/shared/cloudru-client.js` — `stream_options`, ловля `usage` в
  `parseSSEStream`, вызовы `recordChat`/`recordWhisper`.
- `client/unified/panel.js` — бейдж + подписка `onChange` + подключение
  `usage-meter.js` в загрузку.
- `client/shared/styles.css` — стиль бейджа.
- `tests/usage-meter.test.mjs` — новый.
