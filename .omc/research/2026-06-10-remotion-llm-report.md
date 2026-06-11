# Remotion и экосистема «LLM + программный видеомонтаж» — исследование

**Дата:** 2026-06-10
**Контекст:** AI-видеоредактор как CEP-расширение Premiere Pro (LLM agent loop на Cloud.ru FM + детерминированные пайплайны ffmpeg/JS + применение к таймлайну через ExtendScript).
**Режим:** research only, только shipped-решения с первоисточниками.

---

## 1. Remotion core

### Что это
Remotion — фреймворк «видео как React-код»: композиция описывается JSX-компонентами, каждый кадр — это рендер React-дерева при заданном `frame`. Видео = чистая функция от номера кадра.
- Сайт/доки: https://www.remotion.dev/docs/
- Композиция: `<Composition>` с `durationInFrames`, `fps`, `width/height`, `defaultProps`. Внутри — `<Sequence from={N} durationInFrames={M}>` — это и есть «декларативный таймлайн как код»: смещение и длительность каждого элемента задаются пропсами, никакого мутируемого состояния таймлайна.
- Рендеринг: headless Chrome (server-side rendering, `@remotion/renderer`), скриншоты кадров → кодирование ffmpeg. Масштабирование — **Remotion Lambda** (AWS, рендер распараллеливается на сотни лямбд) и Cloud Run.
- **Remotion Player** (`@remotion/player`): React-компонент, проигрывающий композицию в браузере БЕЗ рендера в файл, с обновлением `inputProps` в рантайме. Это штатная механика «превью до рендера». https://www.remotion.dev/docs/player/ и https://www.remotion.dev/docs/player/player
- Лицензия: бесплатно для физлиц и небольших компаний, компаниям крупнее — платная Company License (https://www.remotion.dev/license). Для коммерческого продукта это надо учитывать.

### Модули, релевантные монтажу

| Модуль | Что делает | URL |
|---|---|---|
| `@remotion/captions` | Общий тип `Caption` `{text, startMs, endMs, timestampMs, confidence}` (word-level), конвертеры из Whisper, `createTikTokStyleCaptions()`, `parseSrt/serializeSrt` | https://www.remotion.dev/docs/captions/api |
| `@remotion/install-whisper-cpp` | Скачивает и запускает whisper.cpp локально из Node, `transcribe()` с word-level таймстемпами, `toCaptions()` → `Caption[]` | https://www.remotion.dev/docs/install-whisper-cpp/transcribe , https://www.remotion.dev/docs/install-whisper-cpp/to-captions |
| `@remotion/openai-whisper` | `openAiWhisperApiToCaptions()` — конвертация ответа OpenAI Whisper API (verbose_json) в тот же `Caption[]` | https://www.remotion.dev/docs/openai-whisper/openai-whisper-api-to-captions |
| `@remotion/media-parser` | Парсер mp4/mov/webm/mkv/avi/m3u8/ts/mp3/wav/aac/flac без зависимостей, 20+ полей метаданных, работает в браузере/Node/Bun, частичное чтение файла (не качает целиком), сэмплы для WebCodecs | https://www.remotion.dev/docs/media-parser/ |
| `@remotion/transitions` | Готовые переходы (`<TransitionSeries>`: fade, wipe, slide, clockWipe и т.д.) с тайминг-функциями | https://www.remotion.dev/docs/transitions/ |
| **Remotion Recorder** | Платный «hackable» рекордер/редактор на JS: запись webcam+screen (до 4 потоков), автоудаление тишины в начале/конце, word-level captions через whisper.cpp, **captions хранятся как редактируемый JSON**, главы с анимацией, b-roll, экспорт пресетами под платформы (1:1 / 16:9 / 9:16) | https://www.remotion.dev/docs/recorder/ |
| **Editor Starter** | Платный шаблон видеоредактора: timeline-UI, canvas, captioning, загрузка ассетов, 80+ feature-флагов; таймлайн — данные в React-состоянии | https://www.remotion.dev/docs/editor-starter/ , https://www.remotion.dev/docs/editor-starter/captioning |

---

## 2. LLM-интеграции с Remotion (shipped)

### 2.1 Официальное от Remotion

1. **System Prompt для LLM** — официальный поддерживаемый prompt, который учит модель механике Remotion (правила композиций, Sequence, interpolate/spring и т.п.). Публикуется и как `https://www.remotion.dev/llms.txt` (конвенция llmstxt.org).
   https://www.remotion.dev/docs/ai/system-prompt
2. **Гайд «Generate Remotion Code using LLMs»** — рекомендованный пайплайн:
   - LLM генерирует **код** (строку с React-компонентом), а не JSON сцен;
   - **structured output** через Vercel AI SDK `generateText()` + `Output.object()` с Zod-схемой: модель обязана вернуть `{code, title, durationInFrames, fps}` — валидация и авторетраи при несоответствии схеме;
   - предупреждение про «context rot»: вместо одного гигантского промпта — **skills**: отдельным дешёвым LLM-вызовом определяются нужные навыки (charts, typography, 3D, spring-physics…), и в контекст кладутся только релевантные куски знаний.
   https://www.remotion.dev/docs/ai/generate
3. **Remotion Skills** (январь 2026) — пакет скиллов для coding-агентов (`npx skills add remotion-dev/skills`), превращает Claude Code/Codex/OpenCode в инструмент производства видео: «prompt a video» при запущенном `npm run dev` (Remotion Studio как превью). Репозиторий https://github.com/remotion-dev/skills (помечен как internal, ставится через skills CLI). Гайд: https://www.remotion.dev/docs/ai/coding-agents ; обзор: https://gaga.art/blog/remotion-skills/
4. **Официальный Remotion MCP** (`@remotion/mcp`) — НЕ монтирует видео: единственный tool `remotion-documentation` — векторный поиск по докам (на CrawlChat) для AI-чатов в редакторах. https://www.remotion.dev/docs/ai/mcp
5. **AI SaaS Starter Kit** («Prompt to Motion Graphics») — Next.js-шаблон: чат → LLM стримит код → JIT-компиляция в браузере → живое превью в Remotion Player → экспорт через Lambda. Включает санитизацию недетерминированного вывода LLM, авторетраи при ошибках компиляции, выбор «точечная правка vs полная замена». https://www.remotion.dev/docs/ai/ai-saas-template
6. **AI-friendly документация**: каждая страница доступна как markdown (`.md`-суффикс, content negotiation `Accept: text/markdown`) — паттерн, который стоит копировать для собственной документации tool'ов. https://www.remotion.dev/docs/ai/

### 2.2 Сторонние MCP-серверы вокруг Remotion (shipped, но community-grade)

- **mcp-use/remotion-mcp-app** — MCP App: tool `create_video` + rule-tools; скомпилированный бандл возвращается как `structuredContent`, и виджет Remotion Player рендерится **прямо в чате** (ChatGPT/Claude) — модель «видит» играбельное превью и итерирует. https://github.com/mcp-use/remotion-mcp-app
- **dev-arctik/remotion-video-mcp** — мост Claude↔Remotion: скаффолд проекта, управление сценами, синхронизация аудио, рендер — всё MCP-тулами. https://github.com/dev-arctik/remotion-video-mcp
- **stephengpope/remotion-media-mcp** — генерация ассетов (изображения, видео Veo, музыка, TTS, субтитры) для Remotion-проектов. https://github.com/stephengpope/remotion-media-mcp
- **Remotion Superpowers** (DojoCoding) — плагин для Claude Code: команды вроде `/add-captions` (TikTok-капшены), стоковые футажи, AI review loop. https://www.claudepluginhub.com/commands/dojocodinglabs-remotion-superpowers/commands/add-captions
- Кикстарт-репо: https://github.com/jhartquist/claude-remotion-kickstart

### 2.3 Как именно LLM «монтирует» в Remotion-экосистеме

Три встречающихся уровня (по убыванию свободы):
1. **LLM пишет JSX/TSX-код композиции** (официальный путь Remotion: system prompt / skills / SaaS template). Плюс: максимум выразительности. Минус: нужна компиляция, санитизация, ретраи — Remotion прямо признаёт это и shipped механики самокоррекции.
2. **LLM возвращает structured output (Zod/JSON Schema)** — код как поле внутри валидируемого объекта, либо целиком параметры готовой композиции (props). Рекомендуемый Remotion способ контроля. https://www.remotion.dev/docs/ai/generate
3. **LLM правит только `inputProps` фиксированной композиции** — шаблон сделан человеком, LLM заполняет данные (тексты, тайминги, ассеты). Так работают продакшн short-form генераторы (Revid.ai — выросший из Typeframes генератор «вирусных» шортсов, https://www.revid.ai/ ; прямого подтверждения, что под капотом Remotion, нет — архитектура закрыта).

Вывод по паттерну: **чем ближе к продакшну, тем меньше свободы у LLM** — продукты сходятся к «LLM заполняет данные / план, детерминированный код рендерит». Это ровно наша архитектура.

---

## 3. Смежные shipped-решения «timeline as data + LLM»

### 3.1 Diffusion Studio (YC F24) — самый близкий нам по философии
- **@diffusionstudio/core** — браузерный композитинг-движок на TypeScript + WebCodecs (поверх Mediabunny): декларативный таймлайн, split, captions, **silence removal**, переходы, keyframes, realtime-превью, аппаратный рендер в браузере. https://github.com/diffusionstudio/core , https://www.npmjs.com/package/@diffusionstudio/core
- **diffusionstudio/agent** («Video Composer Agent») — агентский фреймворк для монтажа, активно развивается (110+ коммитов): **Code Agent вместо function calling** — LLM пишет JS/TS-код против API ядра и исполняет его в браузерной песочнице. Тулы: `DocsSearchTool` (RAG по докам ядра), `VisualFeedbackTool` (сэмплирует композицию 1 кадр/сек, vision-LLM оценивает результат → generator-evaluator цикл). https://github.com/diffusionstudio/agent ; разбор архитектуры: https://re-skill.io/blog/ai-video-editing-agent-re-skill-diffusion-studio
- Их аргумент: «JSON не создавался как язык действий, код — создавался»; для сложных композиций code-agent выразительнее tool calling. Но цена — песочница, контроль исполнения и визуальная самопроверка.

### 3.2 Editly
- `mifi/editly` — CLI/Node API: **MP4 из JSON5 edit spec** (clips → layers с типами video/title/image…), быстрый стриминговый ffmpeg-пайплайн. https://github.com/mifi/editly
- Статус: один мейнтейнер, развитие вялое; как формат «JSON edit spec» — рабочий референс, как зависимость — рискованно. Облачные наследники идеи — Shotstack (https://shotstack.io/), Creatomate, JSON2Video.

### 3.3 JSON2Video — «JSON-схема сцен + LLM» в проде
- REST API: POST `/movies` с JSON `{scenes: [{elements: [video|image|text|html|audio|voice|subtitles]}]}` — облачный рендер. Схема: https://json2video.com/docs/v2/api-reference/json-syntax
- **Официальный MCP-сервер** `npx @json2video/mcp`: Claude Code/Codex собирают сцены, TTS, субтитры и финальный MP4 из натурального языка. https://json2video.com/
- Это самый чистый shipped-пример паттерна «LLM генерирует JSON-план → детерминированный рендерер исполняет».

### 3.4 OpenTimelineIO (OTIO)
- ASWF-стандарт обмена таймлайнами, поддержан в большинстве NLE; свежие релизы (вплоть до конца 2025) добавили **experimental editing commands в C++** (insert, overwrite, roll…) поверх модели данных. https://github.com/AcademySoftwareFoundation/OpenTimelineIO , https://opentimelineio.readthedocs.io/
- Прямых shipped «LLM пишет OTIO» проектов не найдено; OTIO ценен как нейтральный сериализуемый формат edit-плана, но в Premiere нативного импорта OTIO нет (адаптеры сторонние) — для нас интерес ограничен.

### 3.5 FCPXML / EDL + LLM
- **DareDev256/fcpxml-mcp-server** — MCP-сервер (Python, ~8.9k LoC, 912 тестов, v0.6.0, активен): 53 тула — анализ таймлайна, QC (flash frames, gaps, дубли), правки (trim, reorder, transitions, split), **генерация rough cut / монтажа A/B-roll по параметрам (клипы, длительность, pacing)**, экспорт EDL/CSV, импорт SRT, конвертация в Resolve XML. Точность — rational arithmetic для frame-accuracy. https://github.com/DareDev256/fcpxml-mcp-server
- Любительский, но это прямое доказательство жизнеспособности паттерна «LLM через MCP-тулы оперирует таймлайном как данными» (наш аналог — ExtendScript-мост).

### 3.6 Eddie AI — shipped-конкурент в нашей нише
- Desktop-приложение + **helper-extension для Premiere Pro** (мост: тянет клипы/мультикамы/таймлайны из бина, возвращает готовый cut в Premiere с автоматическим relink). Транскрипт-driven rough cut, **AI-мультикам** (синк по аудио/визуалу, выбор ракурса), «Dirty Multicam» — импорт уже синхронизированных таймлайнов из Premiere/Resolve без подготовки. https://www.heyeddie.ai/workflows/adobe-premiere-pro , https://www.heyeddie.ai/features/multicam , https://help.heyeddie.ai/en/articles/9944879-send-your-edit-to-final-cut-pro-seamlessly , https://www.cined.com/eddie-ai-dirty-multicam-support-for-premiere-pro-and-davinci-resolve-launched/
- Отличие от нас: Eddie — внешнее приложение с round-trip; мы — внутри Premiere. Их «story framework → assembly beat by beat → авто-раскладка B-roll поверх A-roll spine» — ориентир для развития personal clipper / rough cut.

### 3.7 Chat Video Pro — прямой shipped-конкурент (CEP-панель!)
- CEP-панель в Premiere, мульти-LLM (Claude/Gemini/OpenAI): **Story Cutter** — анализ транскрипта секвенции, авто-rough-cut с детекцией хуков и удалением филлеров, правки кладутся прямо на таймлайн; генеративный блок (Sora/VEO/Kling через Fal.ai по wholesale-ценам), AI color (генерит Lumetri-луки), text-to-roto. Цена: $149.99 разово + личный Fal.ai-аккаунт (~$10/мес). https://www.chatvideopro.com/
- Важно для конкурентного анализа: они подтверждают рынок «LLM-панель внутри Premiere» и модель «без подписки, ключи свои».

### 3.8 Descript API (май 2026) — Underlord стал программируемым
- Публичный API в open beta: импорт файлов, создание проектов, **запуск действий Underlord программно** (Studio Sound, captions, перевод), поддержка MCP-подключений (Claude/GPT управляют Descript промптами). https://docs.descriptapi.com/ , https://www.newsfilecorp.com/release/297461/Descript-Launches-API-in-Open-Beta-with-Editing-and-Workflow-Updates
- Сигнал: лидер транскрипт-монтажа открывает агентный доступ — тренд «NLE как набор MCP-тулов» подтверждён рынком.

---

## 4. Что нам подцепить (ранжированный список)

### #1. Единый тип `Caption` + `createTikTokStyleCaptions()` — формат word-level токенов
- **Источник:** https://www.remotion.dev/docs/captions/api , https://www.remotion.dev/docs/captions/create-tiktok-style-captions , https://github.com/remotion-dev/template-tiktok
- **Что shipped:** open-source пакет: `Caption {text, startMs, endMs, timestampMs, confidence}`; пагинация в «страницы» одним параметром `combineTokensWithinMilliseconds` (большое значение → фразы, малое → word-by-word); токены `{text, fromMs, toMs}`; whitespace-конвенция (пробел в начале слова — разделитель страниц); конвертеры из whisper.cpp и OpenAI API; serializeSrt.
- **Усилия/ценность:** низкие / высокая. Алгоритм пагинации — ~100 строк чистой JS-логики, идеально ложится в наш deterministic-pipelines слой; рендер — в Premiere через ESS/MOGRT или SRT.
- **Vs наш подход:** у нас есть word-level транскрипт от whisper, но нет проверенного формата «страниц» для бёрнд-ин капшенов под шортсы. Перенять формат 1:1 (он де-факто стандарт в опенсорсе), не изобретать свой.

### #2. Structured output с JSON-схемой + автовалидация/ретраи для edit-плана
- **Источник:** https://www.remotion.dev/docs/ai/generate (Vercel AI SDK `Output.object()` + Zod), https://json2video.com/docs/v2/api-reference/json-syntax (схема movie/scenes/elements)
- **Что shipped:** Remotion официально рекомендует: LLM обязан вернуть объект по схеме, mismatch → автоматический retry. JSON2Video продаёт это как продукт годами.
- **Усилия/ценность:** низкие / высокая. У нас LLM уже возвращает разметку сегментов, а `removeIntervals` (deterministic-pipelines.js) — детерминированный план. Чего не хватает: формальной JSON-схемы edit-плана + валидации ответа LLM против неё с ретраем (GLM-5.1/DeepSeek поддерживают structured output / json mode на Cloud.ru). Это снимет класс ошибок «LLM вернул кривые таймстемпы».
- **Vs наш подход:** наш `removeIntervals {startSec, endSec}` — уже правильный «промежуточный формат», но он внутренний для каждого пайплайна. Стоит унифицировать в один версионируемый EditPlan (remove/keep/cutTo/marker), который генерируют и LLM-, и детерминированные источники, а применяет один ExtendScript-аппликатор.

### #3. Skills-паттерн против «context rot» (модульные знания вместо мегапромпта)
- **Источник:** https://www.remotion.dev/docs/ai/generate , https://www.remotion.dev/docs/ai/coding-agents , https://github.com/remotion-dev/skills
- **Что shipped:** Remotion Skills (янв 2026): дешёвый предварительный LLM-вызов определяет нужные навыки → в системный промпт инжектится только релевантное знание.
- **Усилия/ценность:** средние / высокая. Наш system prompt агента растёт (филлеры, мультикам, главы, LUFS…). Разбить на «скиллы» (per-tool инструкции + few-shot), подгружать по классификации запроса — меньше токенов на Cloud.ru, выше качество tool calling.
- **Vs наш подход:** сейчас, вероятно, один большой промпт; skills-подход — проверенная (Remotion + Claude Code экосистема) эволюция.

### #4. Generator-evaluator цикл с визуальным фидбеком (VisualFeedbackTool)
- **Источник:** https://re-skill.io/blog/ai-video-editing-agent-re-skill-diffusion-studio , https://github.com/diffusionstudio/agent
- **Что shipped:** агент Diffusion Studio после каждого шага сэмплирует композицию (1 fps) и vision-LLM решает «рендерить или править».
- **Усилия/ценность:** средние / средне-высокая. У нас есть ffmpeg: после применения edit-плана можно извлекать кадры на границах склеек (или 3-сек аудиопревью стыков) и давать LLM/пользователю на верификацию ДО ripple delete. Дешёвая версия: проверять только окрестности склеек, не весь ролик.
- **Vs наш подход:** мы применяем монтаж сразу на таймлайн; «оценка до применения» снижает цену ошибки (хотя у нас undo есть, доверие пользователя дороже).

### #5. Превью предложенного монтажа ДО применения (механика Remotion Player, реализация наша)
- **Источник:** https://www.remotion.dev/docs/player/ (паттерн), https://www.remotion.dev/docs/ai/ai-saas-template (превью→рендер цикл)
- **Что shipped:** вся Remotion-экосистема живёт циклом «LLM предложил → мгновенное превью в Player → пользователь одобрил → рендер». MCP-app даже рендерит играбельный Player в чате.
- **Усилия/ценность:** средние / высокая. Тащить сам Remotion в CEP не нужно: эквивалент — HTML5 `<video>` в панели с виртуальным плейлистом keep-интервалов (skip по `timeupdate`) поверх прокси-файла, или ffmpeg-превью склеек. Ключевая идея — **edit-план должен быть проигрываемым до применения**, это UX-стандарт ниши (Eddie, Descript, Remotion).
- **Vs наш подход:** сейчас пользователь видит текстовый `removeSummary`; «слышимое/видимое превью» — следующий уровень доверия.

### #6. Recorder-паттерны: captions как редактируемый JSON-артефакт + платформенные пресеты экспорта
- **Источник:** https://www.remotion.dev/docs/recorder/
- **Что shipped:** Recorder хранит капшены отдельным JSON-файлом с быстрым редактором правок; экспорт-пресеты (1:1 burned-in, 16:9 + SRT, 9:16); orphan-word prevention; авто-обрезка тишины в начале/конце.
- **Усилия/ценность:** низкие / средняя. Для personal clipper: (а) хранить транскрипт/капшены как JSON-артефакт проекта, правки пользователя не теряются при перегенерации; (б) пресеты «куда публикуем» определяют формат капшенов и кроп; (в) trim тишины на краях клипа — тривиальное дополнение к нашему RMS-пайплайну.
- **Vs наш подход:** у нас капшены — побочный продукт транскрипции; здесь они first-class data.

### #7. `@remotion/media-parser` как браузерный пробер метаданных
- **Источник:** https://www.remotion.dev/docs/media-parser/
- **Что shipped:** zero-dependency парсер контейнеров в браузере/Node: длительность, кодеки, размеры, fps, дорожки — частичным чтением файла, без ffprobe.
- **Усилия/ценность:** низкие / средняя. В CEP-панели можем валидировать медиа (drift fps NTSC, кодек, дорожки) мгновенно в JS до запуска ffmpeg-джоб; меньше round-trip'ов в node-host. Осторожно: лицензия Remotion распространяется и на пакеты (проверить применимость company license).

### #8. (Бонус, стратегическое) FCPXML/EDL-экспорт edit-плана как интероп
- **Источник:** https://github.com/DareDev256/fcpxml-mcp-server , https://help.heyeddie.ai/en/articles/9944879
- **Что shipped:** Eddie строит бизнес на round-trip XML; fcpxml-mcp доказывает генерируемость LLM-ом.
- **Усилия/ценность:** средние / низкая сейчас. Наш ExtendScript-мост сильнее (живой таймлайн), но экспорт нашего EditPlan в EDL/FCPXML — дешёвая страховка и канал в Resolve/FCP, плюс заготовка к UXP-миграции 2026 (если прямой API сменится, XML-импорт останется).

### Чего НЕ брать
- **Сам Remotion как рендерер** — не нужен: наш выход — таймлайн Premiere, а не MP4; Chrome-headless рендер дублирует то, что Premiere делает лучше; company license — лишний риск.
- **Code-agent (LLM пишет исполняемый JS)** как у Diffusion Studio — выразительно, но требует песочницы и противоречит нашему принципу «LLM только для семантики». Их же опыт показывает: нужны RAG по докам + визуальная самопроверка, т.е. высокая цена надёжности.
- **Editly** как зависимость — полумёртвый; только как референс JSON-spec.
- **OTIO** — пока нет нативного импорта в Premiere, отложить.

---

## Главный вывод

**Remotion как технологию не брать — брать паттерны.** Remotion решает другую задачу (рендер видео из кода в файл), а мы монтируем живой таймлайн Premiere. Но его AI-экосистема — самая зрелая в нише и подтверждает нашу архитектуру: продакшн-решения сходятся к «LLM выдаёт валидируемые данные (structured output / план), детерминированный код исполняет, пользователь видит превью до фиксации». Конкретно заимствуем: формат `Caption`/TikTok-pages (#1), JSON-схему EditPlan с валидацией и ретраями (#2), skills-разбиение промпта (#3), превью/визуальную верификацию плана до применения (#4–5). Конкурентный ландшафт (Chat Video Pro — CEP-панель за $149, Eddie AI — round-trip мультикам, Descript API/MCP) показывает, что ниша «агент внутри NLE» активно зарешивается — наши дифференциаторы (Cloud.ru/RU, живой ExtendScript-монтаж без round-trip) надо усиливать именно превью- и caption-механиками.

---

## Все источники

- https://www.remotion.dev/docs/ai/ ; /docs/ai/system-prompt ; /docs/ai/generate ; /docs/ai/coding-agents ; /docs/ai/mcp ; /docs/ai/ai-saas-template
- https://www.remotion.dev/llms.txt
- https://www.remotion.dev/docs/captions/api ; /docs/captions/create-tiktok-style-captions ; /docs/captions/caption
- https://www.remotion.dev/docs/install-whisper-cpp/transcribe ; /docs/install-whisper-cpp/to-captions ; /docs/openai-whisper/openai-whisper-api-to-captions
- https://www.remotion.dev/docs/media-parser/ ; /docs/transitions/ ; /docs/recorder/ ; /docs/editor-starter/ ; /docs/player/ ; /docs/player/player ; /license
- https://github.com/remotion-dev/skills ; https://github.com/remotion-dev/template-tiktok ; https://gaga.art/blog/remotion-skills/
- https://github.com/mcp-use/remotion-mcp-app ; https://github.com/dev-arctik/remotion-video-mcp ; https://github.com/stephengpope/remotion-media-mcp ; https://github.com/jhartquist/claude-remotion-kickstart
- https://www.claudepluginhub.com/commands/dojocodinglabs-remotion-superpowers/commands/add-captions
- https://github.com/diffusionstudio/core ; https://github.com/diffusionstudio/agent ; https://www.npmjs.com/package/@diffusionstudio/core ; https://re-skill.io/blog/ai-video-editing-agent-re-skill-diffusion-studio
- https://github.com/mifi/editly ; https://shotstack.io/
- https://json2video.com/ ; https://json2video.com/docs/v2/api-reference/json-syntax
- https://github.com/AcademySoftwareFoundation/OpenTimelineIO ; https://opentimelineio.readthedocs.io/
- https://github.com/DareDev256/fcpxml-mcp-server
- https://www.heyeddie.ai/workflows/adobe-premiere-pro ; https://www.heyeddie.ai/features/multicam ; https://help.heyeddie.ai/en/articles/9944879 ; https://www.cined.com/eddie-ai-dirty-multicam-support-for-premiere-pro-and-davinci-resolve-launched/ ; https://www.redsharknews.com/eddie-ai-nab-2026-ai-video-editing-rough-cut
- https://www.chatvideopro.com/
- https://docs.descriptapi.com/ ; https://www.newsfilecorp.com/release/297461/Descript-Launches-API-in-Open-Beta-with-Editing-and-Workflow-Updates
- https://www.revid.ai/
