# PremiereGPT / Premiere Copilot — реверс-разбор (2026-07-10)

> Источник: `C:\Program Files\Common Files\Adobe\CEP\extensions\PremiereGPTBeta`.
> На диске — только тонкий загрузчик. Реальное приложение тянется с сервера.
> Извлечённые артефакты (в `tmp/`, не в git): `pgpt_bundle.json` (сырой), `pgpt_app.pretty.js`
> (49 647 строк, beautified), `pgpt_app.js`/`.html`/`.css`.
> Номера строк ниже — по `tmp/pgpt_app.pretty.js`.

## 0. TL;DR — чем они принципиально отличаются от нас

| | Мы (ИИ: монтаж) | PremiereGPT |
|---|---|---|
| Агент-луп | **Клиентский** (panel.js, `runAgentLoop`) | **Серверный**, стримится в тонкий клиент по WebSocket |
| Доставка кода | Всё в расширении на диске | **HTML/CSS/JS тянется с сервера** (`/api/snake3`); **JSX host-функции тянутся по имени** (`POST /jsx`) |
| LLM | Cloud.ru (GLM-5.1/4.7, RU) | Anthropic Claude Sonnet 4.6 / Opus 4.6 + Gemini 3.5 Flash |
| Приватность | Локально-первично (RU-moat) | Облачно-зависимо (R2, серверный агент, WS) |
| Хосты | Только PPRO | **PPRO + DaVinci Resolve** (`/jsx_davinci`) |
| Vision | нет | Индекс кадров проекта + downscale-JPEG в модель |
| Монетизация | нет | Тиры/кредиты, «Opus ~5× дороже Sonnet», Stripe checkout |

Их архитектура — тяжёлый SaaS. Наша — приватный локальный инструмент. Мы **не должны**
копировать облачную зависимость (это против нашего RU-moat), но у них есть UX-паттерны и
набор фич, которые стоит перенять локально.

---

## 1. Полный список фич/инструментов

Host-функции (полный список из бандла, `$._MYFUNCTIONS.*`):

**Транскрипция/резка по тексту (Descript-стиль):**
- `exportFullAudioFromSequenceForTranscription`, `exportAudioTracksDirect`, `exportAudioSelection`
- `run_smart_claude_cut` (WS-tool) → `smartClaudeCutPipeline` — резка по смыслу через Claude, слова с флагом `deleted`, `extractDeletedRanges` считает диапазоны (стр. 33053)
- `perform_cut`, `perform_cut_including_audio`, `disableSegmentsInRange`, `removeDisabledClipsFast`, `supprimerClipsDesactives_PODCAST`
- `importCutXml`, `exportSequenceForXmlCut` — резка через FCP-XML реимпорт

**Тишина/джамп-каты:**
- `run_smart_silences` (WS-tool) → `smartSilencesPipeline`, `SilencesOver`, `silenceThreshold`, `silence_ranges`
- `exportAudioJumpCuts`, `exportAudioJumpCutsPreview`, `getOffsetJumpCuts`, `setOffsetJumpCuts`, `JUMPCUT_linkCLips`
- Пресеты на диске: `Audio_ForJumpCuts.epr`, `Audio_ForTranscriptionV2.epr`, `Audio_lowRes_NoEffect.epr`

**Диаризация (подкасты, мультикам по спикерам):**
- `DIARIZE_export`, `DIARIZE_getSequenceDuration`, `DIARIZE_importAudioAndCreateSequence`, `DIARIZE_perform_cuts`, `PODCATS_linkCLips`
- Пресет `Audio_ForDemucs.epr` (разделение стемов Demucs)

**Автозум / рефрейм / вертикаль (шортсы):**
- `AUTOZOOM_main`, `createVerticalExtract`, `createVerticalExtractInOut`, `TOOLS_getSequenceSize`, `Reframe`, `VerticalPadding`

**B-roll (автоподстановка):**
- `autoBroll_apply`, `autoBroll_collectBinClips`, `autoBroll_collectTrackClips`, `autoBroll_listBins`, `run_auto_broll` (WS)

**Цветокор:**
- `colorGrade_exportFrames`, `colorGrade_applyCDL`, `colorGrade_collectClips`, `colorGrade_placeAdjustmentLayers`, `run_color_grade` (WS) — экспорт кадров → анализ → CDL/adjustment layers

**Аудио-микс:**
- `run_audio_mix` (WS) → `audioMixCore`, `audioMix_collectTimelineInfo`, `setEffectParams`, `resolveEffectsAndReadProps`, `getAvailableEffects`

**Титры/маркеры:**
- `SMARTCAPTIONSV`, `importSRTAsCaption` (+ MOGRT-шаблон «Texte PremiereGPT.mogrt», 2009 строк) — стилизованные субтитры
- `addChapterMarkers`, `addSmartViralMarkers` — главы + «виральные» маркеры

**Vision / индекс проекта:**
- `indexProjectVideoFrames`, `exportCurrentFrameToTempPNG`, WS-tools `get_index_entry`/`save_index_entry`/`get_full_index`, `read_frame_b64_downscaled` (maxEdge 768) — мультимодальный анализ кадров
- Gen-AI (fal.ai): `VideoImageGeneration.epr`, генерация изображений/видео

**Утилиты:**
- `backupActiveSequence`, `createRewindPoint`/`rewindToPoint`/`rewindPointsStack` (стек чекпоинтов!), `seekToTime`, `importAndPlaceMedia`, `openFinderAndGetPath`, `deleteFile`

---

## 2. ExtendScript-слой — как устроен

- **Host-код НЕ лежит на диске.** `library.jsx` почти пустой (только `showAlert`). Функции
  тянутся по имени: `getJsxCode(name)` → `POST /jsx {jsx_function_name}` → `.result` (стр. 15105).
  Для DaVinci — `/jsx_davinci`. Затем `runRawExtendScriptCode(code)` исполняет (стр. 15022).
- **Паттерн вызова** (стр. 32732): сервер по WS шлёт `{type:"tool_call", method:"eval_script",
  args:{script}}`; клиент берёт имя функции `script.split("(")[0]`, тянет её тело `getJsxCode`,
  склеивает `тело + "\n" + вызов`, исполняет, `_sendResult(call_id, result)`.
- **Экспорт аудио для транскрипции** — через host-функции + `.epr`-пресеты (не `encodeSequence`
  напрямую в JS). Отдельные пресеты под задачу: транскрипция (моно, low-res), Demucs, jump-cuts.
- **Обработка ошибок host** централизована: `handleEvalScriptError` (стр. ~15170) распознаёт
  доменные коды (`track_count_mismatch`, `audio_too_long`, французское «Le nombre de file_paths
  doit correspondre») и показывает человеко-читаемый `showAlert` с эмодзи и инструкцией.

## 3. Backend / API

- **Загрузчик:** `GET https://api.premierecopilot.com/api/snake3` → `{html, css, js}`,
  инъекция в DOM (`index.html` на диске, стр. 128–163).
- **Агент-мост:** `PremiereAgentBridge` — WebSocket `wss://api.premierecopilot.com/ws/premiere/{email}`
  с heartbeat (ping/pong, watchdog, авто-reconnect) (стр. 32680+). **Агентный цикл Claude идёт на
  сервере**, клиент — исполнитель tool-call'ов.
- **REST (`api.post`):** `/jsx`, `/user/check-feature-access`, `/user/tier-info`, `/users/me/full`,
  `/token`, `/refresh`, `/resend-verification`, `/gen-ai/status`, `/gen-ai/increment`,
  `/ai-credits/costs`, `/create-checkout-session` (Stripe), `/claudecut/apply-cut` (аналитика
  применённых резов), `/track`, `/log-error`, `/errors/report`.
- **Хранилище:** Cloudflare **R2** (`upload_to_r2` с presigned-URL, `*.r2.cloudflarestorage.com`) —
  туда уходят аудио и кадры для серверного анализа.
- **Gen-AI:** fal.ai (`api.fal.ai`, `fal-ai/client`) — генерация изображений/видео, свой API-ключ.
- **Модели:** чат — Claude Sonnet 4.6 (fast) / Opus 4.6 (pro) / Gemini 3.5 Flash (cheap);
  «vibe»/моушен — Gemini 3 Flash / 3.1 Pro (стр. 18680+).

## 4. Промпт-инжиниринг / токены

- Токен-поповер (стр. 18590): разбивка контекста на **«System prompt + tools»** vs
  **«Thoughts & Actions»**, «% of the context window used», подсветка красным у лимита.
- Кредитная модель: «Credits depend on tokens consumed… **Opus consumes ~5× more credits than
  Sonnet**. Start a new conversation as often as possible — it keeps usage low.»
- Тулы и системный промпт определяются на **сервере** (в бандле их схем нет — только UI-обвязка).

## 5. UX-паттерны (что стоит перенять)

1. **Отличные человеко-читаемые сетевые ошибки** (стр. 14413–14438): под каждый код (`ENOTFOUND`,
   `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `EACCES`, self-signed/TLS-inspection, R2 502/503/504)
   — конкретный совет (проверь DNS/VPN/firewall, whitelist `*.r2.cloudflarestorage.com`, обратись
   к IT). У нас сетевые ошибки generic.
2. **Токен/контекст-поповер** — визуализация «сколько контекста съедено» + совет «начни новый
   чат». У нас есть usage-badge (₽/токены), но нет «% окна» и разбивки system-vs-actions.
3. **Стек rewind-точек** (`rewindPointsStack`) — множественные чекпоинты, не один undo.
4. **Доменные коды ошибок host** → дружелюбный алерт с инструкцией (`track_count_mismatch`,
   `audio_too_long → split in 2 segments`).
5. **Прогресс/статус** через `updateStatusMessage`.
6. **Feature-gating** (`checkFeatureAccess`, `checkMembershipAccess`) — понятные сообщения о лимитах.

## 6. Vision/кадры

- `indexProjectVideoFrames` строит индекс кадров бинов проекта; `read_frame_b64_downscaled`
  (maxEdge 768) отдаёт кадр в модель как base64-JPEG (экономия токенов). Используется для b-roll,
  цветокора, «виральных» маркеров. **У нас vision нет вообще** — это большой пробел для монтажа
  по смыслам (мы судим только по транскрипту, не по картинке).

## 7. Их слабые/хрупкие места (где мы уже сильнее)

- **Облачная зависимость:** без интернета/при firewall/VPN — не работает совсем (отсюда и целый
  каталог сетевых ошибок). Мы локальны.
- **Приватность:** аудио и кадры уходят на R2 + серверный агент. Для RU/чувствительного контента —
  стоп-фактор. Наш moat.
- **Динамическая доставка JSX по одной функции** — латентность + точка отказа на каждый tool-call
  (сетевой round-trip перед каждым host-вызовом). У нас host на диске, вызов мгновенный.
- **Смешанная локализация** (французские строки ошибок в проде — «Le nombre de file_paths…») —
  признак технического долга.
- **Нет структурной валидации границ** на клиенте перед host (всё гоняется на сервер).

---

## Топ-10 идей к переносу (локально, без облака)

1. **Vision по кадрам** — экспорт кадров ключевых сегментов (`exportCurrentFrameToTempPNG`-аналог)
   + downscale 768 + отдать в мультимодальную модель Cloud.ru при монтаже по смыслам. Судить не
   только по тексту.
2. **Человеко-читаемые сетевые/host-ошибки** с доменными кодами и инструкцией (перенять каталог).
3. **Токен/контекст-поповер**: расширить наш usage-badge до «% окна съедено» + разбивка
   system/tools vs actions + подсказка «начни новый чат».
4. **Стек чекпоинтов** (rewind-точки) вместо одного undo — множественный откат.
5. **Джамп-каты по тишине** как отдельный инструмент (silence-detect по RMS + порог + padding).
6. **Диаризация подкастов** — авто-нарезка мультикама по спикерам (у нас как раз мультикам-боль).
7. **Смарт-субтитры** через MOGRT-шаблон (стилизованные, а не голый SRT).
8. **Авто-вертикаль/рефрейм** для шортсов (`createVerticalExtractInOut`-аналог).
9. **«Виральные» маркеры** — LLM отмечает хуки/кульминации (у нас частично есть — усилить).
10. **Пресеты экспорта под задачу** (`.epr`): моно/low-res для транскрипции = быстрее и меньше
    Whisper-лимит 25MB.
