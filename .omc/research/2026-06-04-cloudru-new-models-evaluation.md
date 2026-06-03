# Cloud.ru Phase 2 — Evaluation of GLM-5.1, Kimi K2.6, DeepSeek V4 Pro

**Date:** 2026-06-04
**Branch:** feat/multicam-2a-speaker-detection (parallel task, не относится к multicam)
**Trigger:** Cloud.ru выпустили три новых SOTA-модели. Пользовательский запрос:
«Изучи, поднимет ли это качество, требуется ли что-то переписать. Лимиты и расходы
не так важны, как качественный прирост».

## TL;DR

Мигрируем `fm-defaults.js` на новое распределение ролей:

| Роль | Было | Стало | Почему |
|---|---|---|---|
| `chatModel` | GLM-4.7 | **GLM-5.1** | Лучший FC, 202K, thinking-on |
| `analysisModel` | GLM-4.7 | **GLM-5.1** | Тот же, но `thinkingPolicy.analyze=false` обязателен |
| `chapterModel` | GLM-4.7 | **DeepSeek-V4-Pro** | 7× быстрее, 1M контекст, RU OK |
| `findMomentsModel` | GLM-4.7 | **GLM-5.1** | thinking=false |
| `codeModel` | Qwen3-Coder-Next | **DeepSeek-V4-Pro** | 1M контекст под большие диффы |
| `fastModel` | gpt-oss-120b | без изменений | Дёшево/быстро для роутинга |
| `chatParams.max_tokens` | 8000 | **16000** | Контексты выросли, делаем запас |

Пайплайн и промпты переписывать не нужно. Меняется только конфиг и комментарии.

## Endpoint и формат

`https://foundation-models.api.cloud.ru/v1/chat/completions`, OpenAI-compat.

Все три модели поддерживают:
- Function Calling (tools / tool_choice)
- Structured Output (response_format: json_object)
- Streaming (SSE)
- max_tokens до 32000 (подтверждено compat-тестом)

## Прайс и контекст (на 4 июня 2026)

| Модель | Контекст | Input ₽/M | Output ₽/M |
|---|---|---|---|
| deepseek-ai/DeepSeek-V4-Pro | 1 048 576 | 183.00 | 732.00 |
| zai-org/GLM-5.1 | 202 144 | 198.86 | 829.60 |
| moonshotai/Kimi-K2.6 | 262 144 | 175.68 | 725.90 |

## Тестовая методика

Три скрипта, прогнаны напрямую через openai SDK против Cloud.ru endpoint:

1. `test_models_v2.py` — четыре сценария (JSON-классификация, главы, агент,
   агент-без-thinking) × три модели.
2. `test_compat.py` — кросс-совместимость флагов, max_tokens-cap, large-input probe.
3. `test_glm_long.py` — финальная проверка GLM-5.1 c явным thinking=false на 14K input.

Все output-файлы сохранены: `C:\Users\Глеб\AppData\Local\Temp\{results,compat,glm_long}.txt`.

## Ключевые находки

### 1. GLM-5.1: thinking на больших input — фатально

```
GLM-5.1 + thinking=True + 14K input  → 'NoneType' object is not subscriptable
GLM-5.1 + thinking=True + 14K + max=8000 → тот же NoneType
GLM-5.1 + thinking=False + 14K input → 0.67s, ответ "1000" (корректно)
```

Модель сжигает весь max_tokens в `reasoning_content`, итоговый `content` приходит
null, SDK падает на `r.choices[0].message.content[:100]`. Это не баг SDK — модель
действительно не отдаёт ответ.

**Следствие:** `thinkingPolicy.analyze=false` обязательно. То же для `findMoments`
(одноразовая ретривал-классификация).

### 2. Kimi K2.6: chat_template_kwargs не работает

```
Kimi-K2.6 + chat_template_kwargs.enable_thinking=False → 18.39s, finish=length, JSON FAIL
                                                        (всё равно сжёг 2000 tokens на reasoning)
Kimi-K2.6 + chat_template_kwargs.enable_thinking=True  → ≈сопоставимое время
Kimi-K2.6 + extra_body.enable_thinking=False           → 1.68s, content="Привет"
```

Moonshot использует другой контракт: флаг должен быть на верхнем уровне `extra_body`,
не внутри `chat_template_kwargs`. Наш `cloudru-client.js` сейчас передаёт только
второй формат. Чтобы использовать Kimi, нужен адаптер по vendor-prefix модели.

**Решение:** Kimi пока не назначаем ни на одну роль. Если в будущем понадобится
(например, для специфичных RU-задач — Kimi показал чуть лучший живой RU-тон в
TEST B), добавим адаптер в `cloudru-client.js`.

### 3. DeepSeek V4 Pro: молчаливо игнорирует наш thinking-флаг

```
DeepSeek + chat_template_kwargs.enable_thinking=True → 5.08s, OK
DeepSeek + extra_body.thinking.type=enabled         → 0.38s, OK, но без reasoning_content
```

Не падает, не ругается, просто игнорирует. **Безопасно** — наш единый передатчик
`opts.enableThinking → body.chat_template_kwargs.enable_thinking` ничего не сломает.
Native DeepSeek-thinking (`extra_body.thinking.type=enabled`) не пробрасывается из
панели — но это и не нужно: DeepSeek и без него держит long-context reasoning.

### 4. TEST A — Structured JSON (классификация 6 сегментов)

| Модель | thinking | Время | JSON | Точность |
|---|---|---|---|---|
| GLM-5.1 | False | **3.65s** | ✓ | 6/6, разумные категории |
| Kimi-K2.6 | False | 18.39s | ✗ | finish=length, ответ пустой |
| DeepSeek-V4 | n/a | 6.32s | ✓ | 6/6, чуть конссервативнее GLM (больше "content") |

GLM-5.1 — победитель по скорости и схеме. DeepSeek рабочий fallback.

### 5. TEST B — Главы для 12-минутного подкаста

| Модель | thinking | Время | EN-leak | Качество |
|---|---|---|---|---|
| GLM-5.1 | True | 22.80s | 0 | 5 глав, хорошие |
| Kimi-K2.6 | True | 24.12s | 0 | 5 глав, чуть точнее по теме медитации |
| DeepSeek-V4 | n/a | **3.14s** | 0 | 6 глав, гранулярнее (выделил outro) |

**DeepSeek-V4 в 7× быстрее при сопоставимом качестве** — отсюда и выбор для
`chapterModel`.

### 6. TEST C — Multi-step agent (4 tools)

| Модель | Время | Tool call |
|---|---|---|
| GLM-5.1 (thinking=True) | 3.58s | get_timeline_snapshot ✓ |
| GLM-5.1 (thinking=False) | 1.16s | get_timeline_snapshot ✓ |
| Kimi-K2.6 (thinking=True) | 6.65s | get_timeline_snapshot ✓ |
| Kimi-K2.6 (thinking=False) | 6.36s | get_timeline_snapshot ✓ |
| DeepSeek-V4 | 16.45s | get_timeline_snapshot ✓ |

Все модели делают первый шаг правильно. GLM-5.1 заметно шустрее в роли агента —
дополнительное подтверждение выбора `chatModel = GLM-5.1`.

## Что не требует изменений

- **Промпты** (`agent-system-prompt.js`, `agent-prompts.js`) — модели GLM-5.1 и
  DeepSeek-V4 одинаково хорошо понимают существующие system-инструкции на русском.
- **`cloudru-client.js`** — наш текущий формат thinking-флага работает для GLM,
  безопасно игнорируется DeepSeek, не работает для Kimi (но Kimi не используется).
- **Пайплайн analyze→chapter→agent** — структура та же, меняется только модель.
- **Структура tool-схем** — все три тестировали с одной и той же JSON-схемой.

## Что мы НЕ делаем (явно)

1. **Не делаем Kimi-адаптер** — пока ни одна роль не выигрывает от Kimi сильнее,
   чем от пары GLM-5.1 + DeepSeek-V4. Адаптер — лишний риск.
2. **Не убираем gpt-oss-120b** как `fastModel` — он по-прежнему оптимален для
   intent-routing (≈80₽/M vs ≈1000₽/M у новых) и для коротких "что на таймлайне".
3. **Не лезем в DeepSeek native thinking** (`extra_body.thinking.type=enabled`) —
   compat-тест показал, что reasoning_content не возвращается отдельным полем,
   а пайплайн их и не использует.

## Файлы изменены

- `client/shared/fm-defaults.js`
  - Каталог моделей обновлён, добавлены DeepSeek-V4-Pro / GLM-5.1 / Kimi-K2.6
  - Распределение ролей и пояснения
  - `chatParams.max_tokens: 8000 → 16000`
  - Комментарии `thinkingPolicy` отражают находки TEST D

## Открытые вопросы / Follow-ups

- Запустить end-to-end на реальном transcript-чанке (50 сегментов) и сравнить
  GLM-5.1 vs ранее работавший GLM-4.7 на точности классификации фильтров.
- Если в продакшене DeepSeek-V4 на 4-часовых подкастах начнёт отдавать
  слишком мало глав — увеличить `max_tokens` в `buildTopicsWithLLM` или
  переключиться обратно на GLM-5.1 (thinking=true достаточно для глав).
- Phase 2C: рассмотреть DeepSeek-V4 для AI-отчётов по сессии (`report` role) —
  возможно прирост качества за счёт 1M контекста и нативной long-context разводки.
