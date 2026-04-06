# Архив внешнего исследования (референсы)

Связанный документ продукта: [PREMIERE_AI_ASSISTANT.md](PREMIERE_AI_ASSISTANT.md).

---

**Согласованный ТЗ-документ (6 задач, составные запросы, исключения):** [PREMIERE_AI_ASSISTANT.md](PREMIERE_AI_ASSISTANT.md)

---

## Требуемые задачи (актуальный перечень — 6 шт.)

Запрос пользователя может объединять **несколько пунктов сразу** (черновой монтаж), а не только по одному.

1. Порезать видео по таймкодам (например: обрежь до 1 минуты, удали после 3 минуты).
2. Склеивать одно видео с другим.
3. Синхронизация видео и аудио и двух видео по аудиодорожкам.
4. Удалять паузы.
5. Удалять конкретные речевые фрагменты по смыслу (например: удали вступление про котиков).
6. Склеивать два конкретных речевых фрагмента из разных видео (например: фрагмент из видео №1 + фрагмент из видео №2, остальное убрать).

**Исключено из скоупа:** автоматический B-roll из папки «по смыслу к рассказу» — в [PREMIERE_AI_ASSISTANT.md](PREMIERE_AI_ASSISTANT.md) зафиксировано как нереализуемое в рамках заявленного стека (Cloud.ru FM без полноценной vision-цепочки для произвольных изображений).

---

Ниже — **исходный отчёт Perplexity** по GitHub (сохранён как справка). Ключевые выводы:

## Что реально существует

**Ни одного готового решения, которое покрывает все 6 задач целиком** — стек нужно собирать из нескольких компонентов. Лучшие кандидаты:

### 🔌 MCP-серверы (управление Premiere через LLM)

- **[adb-mcp](https://github.com/mikechambers/adb-mcp)** (396 ⭐) — самый зрелый. AI ↔ MCP Server (Python) ↔ Proxy (Node.js) ↔ UXP Plugin ↔ Premiere. Тестировался с Claude Desktop. Поддерживает trim/split по таймкоду, склейку, мультикам.
- **[hetpatel-11/Adobe_Premiere_Pro_MCP](https://playbooks.com/mcp/adobe-premiere-pro)** — 65 инструментов (50+ рабочих): `trim_clip`, `split_clip`, `create_multicam_sequence` с синхронизацией по аудио. Каталог: [Glama — Adobe Premiere Pro MCP](https://glama.ai/mcp/servers/@hetpatel-11/Adobe_Premiere_Pro_MCP).

### ✂️ Удаление пауз

- **[auto-editor](https://github.com/WyattBlue/auto-editor)** — CLI, Python, 25k+ звёзд. `auto-editor video.mp4 --export premiere` — экспортирует готовый XML в Premiere ([релизы](https://github.com/WyattBlue/auto-editor/releases)). Обзор: [Skywork — Premiere + AI editing](https://skywork.ai/skypage/en/unlocking-video-editing-adobe-premiere/1981241710777434112).
- **[clean-cut](https://github.com/EduardoAndreu/clean-cut)** — бесплатный open-source CEP-плагин прямо внутри Premiere, без командной строки.

### 🎬 Семантический монтаж по транскрипту

- **[buttercut](https://github.com/barefootford/buttercut)** — WhisperX транскрибирует видео с тайм-кодами, Claude Code выбирает нужные фрагменты («возьми рассказ про котиков из video1, добавь к video2»), Ruby генерирует XML для Premiere.

### B-roll по смыслу

- **Не входит в целевой скоуп** (см. [PREMIERE_AI_ASSISTANT.md](PREMIERE_AI_ASSISTANT.md)). В отчёте ранее отмечалось: готового open-source решения под семантический B-roll в Premiere **нет**; ближайшие обходные пути — MCP `import_folder` + ручная/слабая эвристика — **не приняты** как обязательная задача продукта.

## Главное ограничение

Adobe UXP API для Premiere Pro пока **экспериментальный** — часть timeline-операций недоступна, возможны silent failures. Более надёжный путь — CEP-расширения (legacy). Удаление конкретных речевых фрагментов через MCP работает через цепочку: транскрипция → LLM находит таймкоды → `split_clip` + `remove_from_timeline` (см. инструменты Adobe Premiere Pro MCP выше).

---

## Архив ссылок из экспорта Perplexity

Полный набор URL из исходного ответа (без нумерации в тексте). Основные проекты продублированы встроенными ссылками в разделе «Что реально существует».

### GitHub, MCP, каталоги, продукты

- [mikechambers/adb-mcp](https://github.com/mikechambers/adb-mcp)
- [Glama — Adobe Premiere Pro MCP](https://glama.ai/mcp/servers/@hetpatel-11/Adobe_Premiere_Pro_MCP)
- [playbooks.com — Adobe Premiere Pro MCP](https://playbooks.com/mcp/adobe-premiere-pro)
- [david-t-martel/adobe-mcp](https://github.com/david-t-martel/adobe-mcp)
- [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) · [releases](https://github.com/WyattBlue/auto-editor/releases) · [discussions](https://github.com/WyattBlue/auto-editor/discussions) · [help](https://github.com/WyattBlue/auto-editor/discussions/categories/1-help) · [actions](https://github.com/WyattBlue/auto-editor/actions) · [профиль](https://github.com/WyattBlue)
- [awesome.ecosyste.ms — auto-editor](https://awesome.ecosyste.ms/projects/github.com%2FWyattBlue%2Fauto-editor)
- [RSK48/AutoCut-Pro/releases](https://github.com/RSK48/AutoCut-Pro/releases)
- [barefootford/buttercut](https://github.com/barefootford/buttercut)
- [Anil-matcha/AI-B-roll](https://github.com/Anil-matcha/AI-B-roll)
- [sasoder/stockpile](https://github.com/sasoder/stockpile)
- [michaelmickspad/PremiereProWithAutoHotKey](https://github.com/michaelmickspad/PremiereProWithAutoHotKey)
- [PremierePro-EditForge](https://github.com/PremierePro-EditForge)
- [market-mcp.com — premiere-pro-automation](https://market-mcp.com/mcp/premiere-pro-automation)
- [mcpmarket.com — Adobe Premiere Pro](https://mcpmarket.com/es/server/adobe-premiere-pro-1) · [premiere-pro-automation](https://mcpmarket.com/server/premiere-pro-automation)
- [premiere-ai-tools-and-plugins-free](https://github.com/premiere-ai-tools-and-plugins-free/)
- [helenejmlp/adobe-premiere-pro](https://github.com/helenejmlp/adobe-premiere-pro)
- [AdobeDocs/uxp-premiere-pro-samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Adobe-Premiere-Pro-wb38pp](https://github.com/Adobe-Premiere-Pro-wb38pp)
- [leancoderkavy/premiere-pro-mcp](https://github.com/leancoderkavy/premiere-pro-mcp)
- [cameron-astor/jumpcut](https://github.com/cameron-astor/jumpcut)
- [FL-Studio-gy35hr](https://github.com/FL-Studio-gy35hr)
- [adobe-cep](https://github.com/adobe-cep)
- [kvadratni/speech-mcp](https://github.com/kvadratni/speech-mcp)
- [Agrarvolution/com.agrarvolution.autotimecodecorrection](https://github.com/Agrarvolution/com.agrarvolution.autotimecodecorrection)
- [DareDev256/fcpxml-mcp-server](https://github.com/DareDev256/fcpxml-mcp-server)
- [PipedreamHQ/awesome-mcp-servers](https://github.com/PipedreamHQ/awesome-mcp-servers)
- [tankvn/awesome-ai-tools](https://github.com/tankvn/awesome-ai-tools)
- [topics/video-editing-workflow](https://github.com/topics/video-editing-workflow)
- [MartinAparicioPons/Auto-Editor](https://github.com/MartinAparicioPons/Auto-Editor)
- [NVIDIA-AI-Blueprints/video-search-and-summarization](https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization)
- [CopperPanMan/Premiere-Pro-Silence-Cutter](https://github.com/CopperPanMan/Premiere-Pro-Silence-Cutter)
- [cogtoolslab/video-broll-public2024](https://github.com/cogtoolslab/video-broll-public2024)
- [EduardoAndreu/clean-cut](https://github.com/EduardoAndreu/clean-cut)

### Сайты и блоги

- [autocut.com](https://www.autocut.com) · [блог — cut silences](https://www.autocut.com/en/blogs/cut-silences/)
- [moreyummy.com — AI video editing](https://moreyummy.com/ai-video-editing/)
- [cutback.video — silence in Premiere](https://cutback.video/blog/how-to-automatically-remove-silence-in-premiere-pro-using-ai-(2025-guide)) · [rough cut + chat AI](https://cutback.video/blog/how-to-create-an-auto-rough-cut-in-premiere-pro-with-chat-based-ai-editing)
- [Skywork — unlocking Premiere editing](https://skywork.ai/skypage/en/unlocking-video-editing-adobe-premiere/1981241710777434112)

### YouTube (обзоры и демо)

- [watch?v=Y7VFK81NTIc](https://www.youtube.com/watch?v=Y7VFK81NTIc)
- [watch?v=EgkqhE5Rv_4](https://www.youtube.com/watch?v=EgkqhE5Rv_4&lc=UgxbaW8qaNXCNeux41Z4AaABAg)
- [watch?v=-Ng2bDweE3Y](https://www.youtube.com/watch?v=-Ng2bDweE3Y)
- [watch?v=Rd-sbnNpBLM](https://www.youtube.com/watch?v=Rd-sbnNpBLM)
- [watch?v=1S2o2clDvRU](https://www.youtube.com/watch?v=1S2o2clDvRU)
- [watch?v=DxznNEC4GXw](https://www.youtube.com/watch?v=DxznNEC4GXw)
- [watch?v=jtyJnwdlyWA](https://www.youtube.com/watch?v=jtyJnwdlyWA)
- [watch?v=hQ_LB74R4A8](https://www.youtube.com/watch?v=hQ_LB74R4A8)
- [watch?v=9OSrzBSOFUU](https://www.youtube.com/watch?v=9OSrzBSOFUU)
- [watch?v=By8Z69Uf9BA](https://www.youtube.com/watch?v=By8Z69Uf9BA)
- [watch?v=TBSjkQx13vA](https://www.youtube.com/watch?v=TBSjkQx13vA)
- [watch?v=pbFHTTAVZDA](https://www.youtube.com/watch?v=pbFHTTAVZDA)
- [watch?v=qCGEvcBqApo](https://www.youtube.com/watch?v=qCGEvcBqApo)
- [watch?v=g2-MG64oLss](https://www.youtube.com/watch?v=g2-MG64oLss)
- [watch?v=Kvl6Y2dIDX0](https://www.youtube.com/watch?v=Kvl6Y2dIDX0)
- [watch?v=EubWs0AKFX8](https://www.youtube.com/watch?v=EubWs0AKFX8)
- [watch?v=dXepG5Xkydg](https://www.youtube.com/watch?v=dXepG5Xkydg&vl=es)

### Reddit

- [r/VideoEditing — community plugin update](https://www.reddit.com/r/VideoEditing/comments/1mgp6yp/free_premiere_pro_plugin_community_update_i_added/)
- [r/editors — CleanCut](https://www.reddit.com/r/editors/comments/1m4x5ps/cleancut_a_free_opensource_plugin_to_remove/)
- [r/premiere — CleanCut](https://www.reddit.com/r/premiere/comments/1m4x3k8/cleancut_a_free_opensource_plugin_to_remove/)
- [r/VideoEditing — auto silence remover](https://www.reddit.com/r/VideoEditing/comments/vcjopa/auto_silence_remover_free/)
- [r/premiere — open source plugin](https://www.reddit.com/r/premiere/comments/1mgp0yw/free_open_source_premiere_pro_plugin_community/)

### Препринты и статьи (arxiv, ACM, ACL)

- [arxiv 2312.17294.pdf](https://arxiv.org/pdf/2312.17294.pdf)
- [arxiv 2403.08299.pdf](https://arxiv.org/pdf/2403.08299.pdf)
- [arxiv 2209.11453.pdf](https://arxiv.org/pdf/2209.11453.pdf)
- [arxiv 2410.22129.pdf](https://arxiv.org/pdf/2410.22129.pdf)
- [arxiv 2305.04772.pdf](https://arxiv.org/pdf/2305.04772.pdf)
- [ACM 10.1145/3613904.3642495](https://dl.acm.org/doi/pdf/10.1145/3613904.3642495)
- [arxiv 2408.10758.pdf](http://arxiv.org/pdf/2408.10758.pdf)
- [arxiv 2306.09541.pdf](https://arxiv.org/pdf/2306.09541.pdf)
- [arxiv abs/2312.03047v1](https://arxiv.org/abs/2312.03047v1)
- [arxiv html/2403.16048](https://arxiv.org/html/2403.16048)
- [arxiv html/2306.08707v3](https://arxiv.org/html/2306.08707v3)
- [arxiv html/2405.12211](https://arxiv.org/html/2405.12211)
- [arxiv 2503.20782.pdf](http://arxiv.org/pdf/2503.20782.pdf)
- [arxiv html/2403.17693](https://arxiv.org/html/2403.17693)
- [arxiv 2312.08882.pdf](http://arxiv.org/pdf/2312.08882.pdf)
- [arxiv html/2503.07598v1](https://arxiv.org/html/2503.07598v1)
- [arxiv 2309.12867.pdf](https://arxiv.org/pdf/2309.12867.pdf)
- [arxiv 2305.08389.pdf](http://arxiv.org/pdf/2305.08389.pdf)
- [arxiv html/2412.09513v1](https://arxiv.org/html/2412.09513v1)
- [ACL 2023 findings 741](https://aclanthology.org/2023.findings-acl.741.pdf)
- [arxiv 2403.15377v4.pdf](http://arxiv.org/pdf/2403.15377v4.pdf)
- [arxiv html/2503.11571](https://arxiv.org/html/2503.11571)
- [arxiv 2405.18406.pdf](http://arxiv.org/pdf/2405.18406.pdf)
- [arxiv html/2312.06708v1](https://arxiv.org/html/2312.06708v1)
- [arxiv html/2501.00645v1](https://arxiv.org/html/2501.00645v1)
- [arxiv 2410.11062.pdf](http://arxiv.org/pdf/2410.11062.pdf)
- [arxiv 2409.12466.pdf](http://arxiv.org/pdf/2409.12466.pdf)
- [arxiv html/2407.14841v1](https://arxiv.org/html/2407.14841v1)
- [arxiv html/2501.14646v1](https://arxiv.org/html/2501.14646v1)
- [arxiv html/2405.16537](https://arxiv.org/html/2405.16537)
- [arxiv 2310.15247.pdf](https://arxiv.org/pdf/2310.15247.pdf)
- [arxiv html/2411.15738](https://arxiv.org/html/2411.15738)
