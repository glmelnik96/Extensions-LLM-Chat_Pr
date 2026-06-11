# Конкурентная разведка: Chat Video Pro + Descript API/MCP
**Дата:** 2026-06-10 · **Метод:** 23 веб-запроса/фетча первоисточников (сайты продуктов, доки, changelog, пресс-релизы, обзоры)

---

## 1. Chat Video Pro (chatvideopro.com) — прямой конкурент в Premiere

### 1.1 Что это
Нативное **CEP-расширение** (Common Extensibility Platform, не UXP) для Adobe Premiere Pro 2025+ (требует v25.0, рекомендуется 2026). Windows 10/11, Intel Mac, Apple Silicon. Позиционирование: «AI command center без подписки» — разовая покупка + BYO API key. Продаётся на aescripts.
Источники: [chatvideopro.com](https://www.chatvideopro.com/), [docs: What is CVP](https://docs.chatvideopro.com/getting-started/what-is-chat-video-pro), [aescripts](https://aescripts.com/chat-video-pro/).

### 1.2 Полный список фич

| Фича | Как работает |
|---|---|
| **Story Cutter** (rough cut по транскрипту) | Читает транскрипт активной секвенции, стримит «paper cut» (саундбайты с verbatim-цитатами и таймкодами HH:MM:SS:FF), вставляет на таймлайн. Hook detection, дедупликация дублей, классификация спикеров, удаление филлеров. Только диалоговый контент. |
| **Story Scribe** (транскрипция) | Word-level транскрипция, 99+ языков; ElevenLabs или локальные модели (Whisper local/cloud). Также принимает экспорт из Text panel Premiere (JSON/CSV/plain), SRT, VTT, ElevenLabs JSON. |
| **Генерация видео/B-roll** | 10+ моделей: Sora 2, VEO 3.1, Kling, Hailuo, Seedance, Wan. Результат кладётся прямо на трек у playhead. |
| **Генерация изображений/тамбнейлов** | Imagen, Flux, Recraft, Bria; AI-хуки для обложек. |
| **VFX/решуты** | Стилизация, перезасветка, смена гардероба, AI-переходы между клипами. |
| **Background removal / rotoscoping** | Текстовые маски через SAM 3. |
| **Upscaling** | До 4K через Topaz, Bria, Recraft Crisp. |
| **Color Grade Assistant** | Анализ кадров, применение Lumetri-луков в один клик, генерация кастомных .cube LUT. |
| **Brand Voice Assistant** | SEO-заголовки и описания под тон канала. |
| **Video Prompter Assistant** | LLM доводит черновое описание до структурированного промпта для генеративной модели. |
| **Голосовые команды** | Hands-free промптинг. |

Источники: [chatvideopro.com](https://www.chatvideopro.com/), [docs](https://docs.chatvideopro.com/getting-started/what-is-chat-video-pro), [products](https://www.chatvideopro.com/products/).

### 1.3 Story Cutter — детальный workflow (главный конкурент нашему пайплайну)
Источник: [docs: Story Cutter Assistant](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant).

1. Пользователь готовит source-секвенцию со всем футажом.
2. **Экспортирует транскрипт из Text panel Premiere** (JSON предпочтительно — word-level тайминги; plain text/CSV — только sentence-level). Т.е. CVP **опирается на нативную транскрипцию Premiere**, свой Story Scribe — опция.
3. Открывает «conversation starter» Story Cutter, прикрепляет транскрипт скрепкой.
4. **Линкует source-таймлайн** «фиолетовой пилюлей» (purple pill) — авто-линк по совпадению имён, иначе вручную.
5. Пишет промпт: хронометраж, платформа, тип видео, креативная цель («брифуй как живого монтажёра»).
6. LLM **стримит структурированный paper cut**: саундбайты, verbatim-цитаты, таймкоды, маркеры секций.
7. **Превью**: клик по таймкоду в paper cut перебрасывает playhead Premiere на этот момент source-таймлайна.
8. Применение: стрелка ↓ — вставить один саундбайт у playhead; кнопка **Insert Rough Cut** — вся подборка с section markers и синхронными мультитрек-клипами.

**Команды:** `/select pass` (все моменты по категориям: хуки, value, эмоц. пики, CTA), `/top 5 soundbites` (с рекомендацией платформ), `/social clip` (60-сек версия: hook → value → CTA), `/batch` (несколько задач из одного транскрипта последовательно без репромптинга), `/new video`.

**Модели (выбор в Settings):** GPT-5.2 Thinking (сложные редакторские решения), Claude Sonnet 4.6 (story-driven cuts), Gemini 3.1 Pro (длинные транскрипты, 1M контекст — 2+ часа без сплита). Стоимость прохода Story Cutter ≈ **$0.30**.

**Мультикам:** только «стопка синхронных камер на V1/V2/V3» (каждая камера — свой трек, без пустых треков снизу). **Не умеет переключать углы внутри нативного multicam-клипа Premiere** — один multicam-клип читается как один слой. Нельзя двигать клипы после транскрибации — таймштампы привязаны к позициям, иначе ре-транскрипция.

**Undo:** традиционного undo **нет** — итерация промптами в том же треде («вырежи 30 сек из секции 2», «замени третий саундбайт»). Non-destructive: исходники не трогаются, rough cut собирается у playhead.

### 1.4 Цены и модель
Источник: [products](https://www.chatvideopro.com/products/), [aescripts](https://aescripts.com/chat-video-pro/).
- **Base $149.99** (1 место) / **Workflow Bundle $169.99** (2 ключа + folder template) / **Creator Bundle $199.99** (+250 LUT, 12 export-пресетов, Video Prompter PDF). Lifetime, бесплатные обновления, 7-дневный возврат (только лицензия).
- **Один ключ — FAL.ai** (бесплатная регистрация): «add one API key, and Chat Video Pro handles the routing» — и LLM (Claude/GPT-5.5/Gemini), и генеративные модели идут через FAL по wholesale-тарифам. Видео $0.03–0.25/сек, картинки $0.002–0.02, «типичный месяц < $10».
- Лицензия привязана к одной машине, переносится через деактивацию.

### 1.5 Приватность/телеметрия
«By default, Chat Video Pro collects nothing» — ключ и лицензия локально, на FAL уходят только промпты и конкретные кадры/клипы генерации. Телеметрия opt-in (анонимные ошибки и счётчики фич). ([chatvideopro.com](https://www.chatvideopro.com/))

### 1.6 Отзывы
Третьесторонних отзывов **почти нет** (продукт свежий): целевые поиски по Reddit r/premiere и форумам не дали ни одного треда — обсуждение живёт в YouTube-демо самого вендора ([Rough Cut demo](https://www.youtube.com/watch?v=hQ_LB74R4A8), [Full demo](https://www.youtube.com/watch?v=3tlWda8jsf4), [Story Cutter](https://www.youtube.com/watch?v=FDzgRG4yCkQ)) и на странице aescripts (единичный позитив: «had an issue with the transcription feature, now it seems to be fixed»). Вывод: рынок ещё не сформировал мнение — окно для нас.

### 1.7 Чего у CVP НЕТ (наши преимущества)
- ❌ **Cut silences без транскрипта** (RMS/ffmpeg) — Story Cutter работает только при наличии диалога и транскрипта.
- ❌ **Настоящий мультикам-свитчинг** по громкости микрофонов — CVP не переключает углы, только вставляет синхронные стеки.
- ❌ **LUFS-нормализация** — нет вообще (есть только цветокор-ассистент, аудио-обработки нет).
- ❌ **Главы YouTube** — нет (Brand Voice делает только заголовки/описания).
- ❌ **Карточка-подтверждение с verification** (сколько вырежется/останется) — у CVP paper cut показывает «что войдёт», но не считает дельту хронометража до/после.
- ❌ **Удаление филлеров/пауз как отдельный детерминированный пайплайн** — у CVP филлеры удаляются только внутри прохода Story Cutter (пересборка), нет razor+ripple на исходной секвенции.
- ❌ RU-рынок: оплата FAL.ai картой + доступ к Sora/VEO из РФ затруднены — **наш moat (Cloud.ru, без VPN) против CVP работает напрямую**.
- ❌ Undo/rollback — не документирован.

### 1.8 Что у CVP сильнее нас
- ✅ Генеративный стек (B-roll, VFX, upscale, rotoscope) — целая категория, которой у нас нет.
- ✅ Деплой результата прямо на таймлайн у playhead без импорт-диалогов.
- ✅ «Paper cut» как читаемый промежуточный артефакт + клик-по-таймкоду = превью без рендера.
- ✅ Слэш-команды как дешёвые пресеты намерений.
- ✅ Чтение нативного транскрипта Premiere (Text panel JSON) — не заставляет платить за повторную транскрипцию.
- ✅ Бизнес-модель «$150 раз и навсегда + BYO key» — сильный месседж против подписок.

---

## 2. Descript API + MCP + Underlord (открытая бета 14 мая 2026)

### 2.1 API (docs.descriptapi.com)
Запуск open beta — **14 мая 2026** ([пресс-релиз](https://www.newsfilecorp.com/release/297461/Descript-Launches-API-in-Open-Beta-with-Editing-and-Workflow-Updates), [Yahoo Finance](https://finance.yahoo.com/sectors/technology/articles/descript-launches-api-open-beta-123000258.html)). Цитата CEO Laura Burkhauser: «shift toward more flexible and connected production environments».

**Операции** ([docs.descriptapi.com](https://docs.descriptapi.com/)):
- **Import** — проект + медиа из URL или прямой аплоад (MP4, MOV h264/HEVC, WAV, FLAC, AAC, MP3).
- **Agent Edit** — `POST /v1/jobs/agent` с `{project_id, prompt}`; «Anything Underlord can do in the app, it can do through the API»: Studio Sound, удаление филлеров, highlight clips, captions, генерация B-roll, перевод/дубляж. Возвращает `job_id`; по завершении — `result.agent_response` с резюме сделанного. Рекомендация доков: **one-shot промпт со всей информацией** — диалог через API непрактичен.
- **Publish** — рендер и шаринг композиции (480p–4K) как web-link; локального экспорта файла в бете нет.
- **Export Transcript** — plain/Markdown/HTML/RTF/DOCX, спикеры и таймкоды опционально.
- **Jobs** — list/monitor/cancel фоновых задач.
- **Projects** — list/get.
- **Edit in Descript** — одноразовые import-URL для партнёрских интеграций (ссылки живут 3 часа, one-time use).

**Auth:** Bearer-токены, скоупятся на Drive, наследуют права пользователя (Settings → API tokens). **Лимиты:** 429 + `Retry-After`; metadata-эндпоинты ~1000 req/час ([agentsapis.com](https://agentsapis.com/descript-api/)). **Цены:** отдельного API-прайса нет — расходуются **media minutes** плана (импорт/процессинг) и **AI credits** (Underlord-правки). Free: 1 медиа-час + 100 кредитов; Hobbyist $16/мес (10 ч, 400 кр.); Creator $24/мес (35 ч, 1300 кр.); Business $50/мес ([Cleanvoice breakdown](https://cleanvoice.ai/blog/descript-api-pricing/), [descript.com/pricing](https://www.descript.com/pricing)). Кредиты не переносятся на следующий месяц; free — экспорт с watermark.

### 2.2 MCP-сервер
Официальный hosted-сервер `https://api.descript.com/v2/mcp`, запущен в начале мая 2026, remote HTTP, **OAuth через браузер** (без ключей в конфиге), бесплатен как интерфейс ([theclick.ai](https://theclick.ai/library/descript/), [help: MCP overview](https://help.descript.com/hc/en-us/articles/46056322186509-Descript-MCP-overview)).

**Тулы** (по [Activepieces](https://www.activepieces.com/mcp/descript) + theclick):
1. `import_media` — медиа из URL/файла в новый или существующий проект (+опционально композиция)
2. `agent_edit` — Underlord по natural-language инструкции (модификация или генерация проекта)
3. `publish_project` — share-link + downloadable export
4. `get_job_status` — статус фоновой джобы по ID
5. `list_projects` — фильтры по имени/дате/автору
6. `get_project` — детали: композиции, медиафайлы
7. Custom API call; триггер `job_completed` (в Activepieces-обёртке)

Поддерживается **таргетинг папки в Drive и конкретной композиции** в мультикомпозиционном проекте; real-time прогресс задач виден в Claude/ChatGPT. Ограничение: работает только над проектами Descript — для Premiere-пользователей бесполезен напрямую (наша ниша не задета).

### 2.3 Underlord 2026 — агентские возможности
Источники: [descript.com/underlord](https://www.descript.com/underlord), [Underlord v2 changelog 06.01.2026](https://descript.canny.io/changelog/announcingunderlord-v2), [help: Underlord](https://help.descript.com/hc/en-us/articles/36803785502221-Underlord-beta-Your-AI-co-editor-in-Descript), [Season 7](https://www.descript.com/blog/article/descript-season-7-rooms-zoom-automatic-multicam).

- Мультишаговые задачи одним промптом: «remove filler words, tighten pacing, create 3 social clips».
- Инструменты: Remove Filler Words, Studio Sound, Create Clips (шортсы/highlight reels), Eye Contact, captions, сцены/лейауты, lower thirds, bleep, центрирование спикера, «cut to the exciting parts» (retention-оптимизация), скрипты по промпту, документы/слайды → видео, генерация видео по тексту, перевод+дубляж 30+ языков (Business+), AI-аватары.
- **Automatic Multicam** (Season 7): авто-переключение раскладки при смене спикера, реакционные кадры при быстром диалоге; требует мультитрек-записи из Descript Rooms (4K, локальная запись + прогрессивный аплоад) или Zoom-импорта.
- **Underlord v2 (янв 2026):** −20% AI-кредитов на полный монтаж; выбор модели пользователем — Claude Haiku 4.5 (дёшево/быстро), Claude Opus 4.5 (макс. качество), Sonnet 4.5, Gemini 3.0 Pro, GPT 5.2.

### 2.4 UX-паттерны цикла подтверждения (главное, что стоит копировать)
Источники: [help: Undo/rollback Underlord](https://help.descript.com/hc/en-us/articles/36958274409357-Undo-or-rollback-changes-made-by-Underlord-beta), [Underlord v2](https://descript.canny.io/changelog/announcingunderlord-v2), [how to prompt](https://help.descript.com/hc/en-us/articles/38217205340813-How-to-prompt-Underlord-effectively).

1. **План до действия:** Underlord публикует initial plan, стримит ход рассуждений по мере правок и **периодически останавливается спросить «on the right track?»**. Рекомендованный паттерн: draft plan → approval → apply.
2. **Чекпоинты:** перед каждым применением правок в чат вставляется checkpoint-сообщение; к нему можно откатиться в течение сессии.
3. **Revert-кнопка** в action bar под каждым ответом агента (переименована из «rollback» ради понятности).
4. **Version History** как страховка, если сессия закрыта/обновлена.
5. **Итоговое резюме** (`agent_response` в API) — что именно сделано.
6. **Прозрачность стоимости:** v2 маркетируется через «−20% кредитов на видео» — расход агента это публичная метрика UX.

---

## 3. Ранжированный список механик для заимствования

| # | Механика | Что shipped (URL) | Перенос в наш Premiere-плагин | Усилия | Ценность | Чем лучше нашего текущего |
|---|---|---|---|---|---|---|
| 1 | **Чекпоинт + Revert под каждым действием агента** | Underlord: checkpoint-сообщение в чате перед правкой + Revert в action bar ([help](https://help.descript.com/hc/en-us/articles/36958274409357-Undo-or-rollback-changes-made-by-Underlord-beta)) | Перед removeIntervals снимаем снапшот секвенции (Duplicate sequence через ExtendScript или сериализация списка интервалов) и рисуем кнопку «Откатить» под карточкой результата | **M** | **high** | У нас подтверждение есть только ДО монтажа; после применения отката нет — это №1 страх пользователя при доверии агенту |
| 2 | **Кликабельные таймкоды → playhead (превью без рендера)** | CVP paper cut: клик по таймкоду двигает playhead Premiere ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | В нашей verification-карточке сделать каждый интервал «вырежется/останется» кликабельным → `seqence.setPlayerPosition()` через ExtendScript | **S** | **high** | Наша карточка показывает только числа; пользователь не может прослушать спорный интервал перед подтверждением |
| 3 | **План → пауза-вопрос → применение** | Underlord v2: initial plan, стриминг рассуждений, паузы «on the right track?» ([changelog](https://descript.canny.io/changelog/announcingunderlord-v2)) | В agent loop добавить системный паттерн: перед вызовом монтажных тулов агент обязан выдать план списком и дождаться «да»; для дешёвых операций — skip | **S** (промпт+1 состояние UI) | **high** | Сейчас подтверждение одно и в конце; раннее согласование плана снижает прожиг токенов Cloud.ru и переделки |
| 4 | **Чтение нативного транскрипта Premiere (Text panel JSON)** | CVP принимает экспорт Text panel JSON/CSV + SRT/VTT ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | Принимать готовый транскрипт Premiere как вход вместо обязательного whisper-прогона: парсер JSON Text panel → наш формат интервалов | **M** | **high** | Экономит время и деньги пользователю, у которого транскрипт уже есть; снимает барьер «ждать whisper 20 минут» |
| 5 | **Слэш-команды-пресеты намерений** | CVP: `/select pass`, `/top 5 soundbites`, `/social clip`, `/batch`, `/new video` ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | В чат добавить автокомплит слэш-команд, маппящихся на наши детерминированные пайплайны (`/тишина`, `/филлеры`, `/мультикам`, `/главы`, `/шортс`) | **S** | **mid** | Мост между чатом и панелью «Инструменты»: новичок открывает возможности без чтения доков |
| 6 | **Paper cut как промежуточный артефакт** | CVP стримит структурированный список саундбайтов с цитатами и секциями до вставки ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | Для вырезания отступлений/филлеров показывать не только счётчики, а список «что останется» с цитатами из транскрипта, секционными маркерами и чекбоксами выборочного применения | **M** | **high** | Наша verification агрегатная; выборочное применение интервалов = доверие + точность без полного отказа |
| 7 | **`/batch` — несколько дельивераблов из одного транскрипта** | CVP `/batch`: длинный кат → social clip → selects одной очередью ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | Очередь пайплайнов в один прогон: транскрипция → филлеры → главы → шортс; результаты независимы | **M** | **mid** | Сейчас пользователь запускает тулы по одному; батч = «обработай выпуск целиком» одной кнопкой |
| 8 | **Итоговое резюме агента (agent_response)** | Descript API возвращает резюме сделанного по завершении джобы ([docs](https://docs.descriptapi.com/)) | После применения монтажа постить в чат карточку-отчёт: вырезано N интервалов, −MM:SS, новый хронометраж, ссылка на revert | **S** | **mid** | Замыкает цикл доверия; сейчас после apply пользователь сам проверяет таймлайн |
| 9 | **Выбор LLM-модели per-task с подсказками** | CVP рекомендует модель под задачу; Underlord v2 даёт выбор Haiku/Opus/Gemini ([v2](https://descript.canny.io/changelog/announcingunderlord-v2)) | В Settings: GLM-5.1 для быстрых правок, DeepSeek для длинных транскриптов — с подсказкой «когда какую» и автовыбором по длине транскрипта | **S** | **mid** | У нас выбор моделей есть, но без guidance; снижает счета Cloud.ru и таймауты на 2-часовых подкастах |
| 10 | **Публичная метрика расхода («−20% кредитов»)** | Underlord v2 маркетирует экономию кредитов ([v2](https://descript.canny.io/changelog/announcingunderlord-v2)) | Показывать в чате стоимость прогона (токены Cloud.ru → ₽) до и после; CVP аналогично публикует «$0.30 за проход Story Cutter» | **S** | **mid** | Прозрачность цены — аргумент для RU-аудитории, привыкшей к подпискам с тёмным расходом |
| 11 | **`/social clip` формула hook→value→CTA** | CVP: 60-сек версия с хуком, value-моментом и CTA ([docs](https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant)) | Усилить personal clipper: LLM-разметка хук/value/CTA в транскрипте, сборка клипа по формуле, а не только «лучший момент» | **M** | **mid** | Наш clipper ищет моменты; формула повествования даёт более досматриваемые шортсы |
| 12 | **MCP-сервер поверх наших пайплайнов** | Descript: hosted MCP `api.descript.com/v2/mcp`, OAuth, jobs ([theclick](https://theclick.ai/library/descript/)) | Экспонировать наши детерминированные пайплайны как MCP-тулы (локальный сервер при открытом Premiere) — пользователь дирижирует монтажом из Claude/ChatGPT | **L** | **mid→high (стратегически)** | Никто на рынке не даёт MCP-управление таймлайном Premiere; Descript заперт в своей экосистеме — мы можем стать «Descript MCP для Premiere» |
| 13 | **B-roll/генерация через FAL-подобный шлюз** | CVP: один FAL-ключ роутит 20+ моделей ([products](https://www.chatvideopro.com/products/)) | Через Cloud.ru/доступные RU-модели (Kandinsky и т.п.) — генерация B-roll на таймлайн | **L** | **low (пока)** | Категория есть у CVP, у нас нет; но RU-модели видео слабее, отложить до паритета качества |

### Анти-заимствования (что НЕ копировать)
- **Пересборка вместо ripple-delete:** Story Cutter строит новый rough cut у playhead вместо правки исходной секвенции — наш подход razor+ripple на месте «честнее» для монтажёров, сохраняем.
- **Хрупкая привязка к позициям клипов** («не двигайте клипы после транскрибации») — наша связка транскрипт↔интервалы должна оставаться устойчивой к правкам или явно ре-валидироваться.
- **Отсутствие undo у CVP** — подтверждение, что наш фокус на verification + (новый) revert — правильное отличие.

---

## 4. Источники
- https://www.chatvideopro.com/ · https://www.chatvideopro.com/products/
- https://docs.chatvideopro.com/getting-started/what-is-chat-video-pro
- https://docs.chatvideopro.com/conversation-starters/story-cutter-assistant
- https://aescripts.com/chat-video-pro/ (фрагменты через поиск; прямой доступ 403)
- YouTube-демо: https://www.youtube.com/watch?v=hQ_LB74R4A8 · https://www.youtube.com/watch?v=3tlWda8jsf4 · https://www.youtube.com/watch?v=FDzgRG4yCkQ
- https://docs.descriptapi.com/
- Пресс-релиз API beta (14.05.2026): https://www.newsfilecorp.com/release/297461/Descript-Launches-API-in-Open-Beta-with-Editing-and-Workflow-Updates · https://finance.yahoo.com/sectors/technology/articles/descript-launches-api-open-beta-123000258.html
- https://theclick.ai/library/descript/ (MCP обзор)
- https://www.activepieces.com/mcp/descript (список тулов)
- https://agentsapis.com/descript-api/ (лимиты, Edit in Descript)
- https://cleanvoice.ai/blog/descript-api-pricing/ · https://www.descript.com/pricing
- https://www.descript.com/underlord
- https://descript.canny.io/changelog/announcingunderlord-v2 (06.01.2026)
- https://help.descript.com/hc/en-us/articles/36958274409357 (undo/rollback; через поисковые выдержки, прямой доступ 403)
- https://help.descript.com/hc/en-us/articles/38217205340813 (how to prompt Underlord)
- https://www.descript.com/blog/article/descript-season-7-rooms-zoom-automatic-multicam
