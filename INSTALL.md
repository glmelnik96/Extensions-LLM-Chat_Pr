# INSTALL.md — пошаговая установка

> Полное руководство по установке плагина «ИИ: монтаж» (Extensions-LLM-Chat_Pr) для Adobe Premiere Pro.
> Краткий вариант — в [README.md](README.md). Эта страница — для тех, кто ставит **с нуля на новой машине**.

⏱ Время полной установки: 10–15 минут.

---

## ⚠️ Перед началом

Убедись, что есть:
- **Adobe Premiere Pro 2024 или новее** (PP 24, 25, 26 — все поддерживаются; PP 23 и старше — нет, manifest требует `[24.0,99.9]`)
- **macOS 11+** или **Windows 10/11**
- **API-ключ Cloud.ru Foundation Models** (получи на https://cloud.ru/)
- **Права администратора** (для установки ffmpeg на Windows / для `defaults write` на macOS)

---

## 🍎 macOS — пошагово

### Шаг 1 — Установить ffmpeg (3 мин)

Через Homebrew:

```bash
brew install ffmpeg
```

**Проверка** (обязательно!):

```bash
which ffmpeg
# Ожидаемый ответ: /opt/homebrew/bin/ffmpeg (Apple Silicon) или /usr/local/bin/ffmpeg (Intel)

ffmpeg -version | head -1
# Ожидаемый ответ: ffmpeg version 6.x или 7.x
```

⚠️ Если `which ffmpeg` ничего не выводит — ffmpeg не в PATH. Транскрибация и audio analysis работать не будут. Установи Homebrew (https://brew.sh/) и повтори.

### Шаг 2 — Включить CEP Debug Mode (1 мин)

Без этого CEP **не загружает unsigned-расширения** — наш плагин просто не появится в меню Extensions.

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

**Проверка:**

```bash
defaults read com.adobe.CSXS.12 PlayerDebugMode
# Ожидаемый ответ: 1
```

⚠️ **Полностью закрой Premiere после этой команды (Cmd+Q, не просто закрыть окно).** CEP перечитывает PlayerDebugMode только при холодном старте процесса.

### Шаг 3 — Склонировать репо в правильное место (2 мин)

```bash
cd ~/Library/Application\ Support/Adobe/CEP/extensions/
git clone <repo-url> Extensions-LLM-Chat_Pr
cd Extensions-LLM-Chat_Pr
```

Если папки `~/Library/Application Support/Adobe/CEP/extensions/` ещё нет — создай:

```bash
mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions/
```

**Проверка:**

```bash
ls CSXS/manifest.xml host/premiere.jsx client/unified/index2.html
# Все три файла должны существовать
```

### Шаг 4 — Снять macOS quarantine (если архив был распакован) (10 сек)

Только если ты получил папку через AirDrop / .zip / Telegram / Dropbox — `git clone` этого не вызывает.

```bash
sudo xattr -dr com.apple.quarantine .
```

### Шаг 5 — Создать fm-secrets.js и вписать API-ключ (2 мин)

```bash
cp client/shared/fm-secrets.example.js client/shared/fm-secrets.js
```

Открой `client/shared/fm-secrets.js` в редакторе:

```js
var FM_SECRETS = { apiKey: 'ВПИСАТЬ-СЮДА-СВОЙ-CLOUD-RU-API-КЛЮЧ' };
```

**Проверка:**

```bash
grep -n "apiKey" client/shared/fm-secrets.js
# Ожидаемый ответ: строка должна содержать твой реальный ключ, не '' и не 'YOUR-KEY'
```

⚠️ `fm-secrets.js` в `.gitignore` — он остаётся на твоей машине, в репозиторий не попадает. Это правильно, **не** убирай его из gitignore.

### Шаг 6 — Запустить Premiere и открыть панель (1 мин)

1. Открой Adobe Premiere Pro (если был открыт — **полный рестарт** через Cmd+Q + повторный запуск)
2. Открой любую секвенцию (или создай новую)
3. **Window → Extensions → ИИ: монтаж**

Должна открыться панель с двумя вкладками: «Чат» и «Инструменты».

⚠️ **Если в меню Extensions нет «ИИ: монтаж»** — переходи в раздел [Troubleshooting](#-troubleshooting) ниже.

### Шаг 7 — Smoke-тест (3 мин)

1. Подготовь тестовую секвенцию: 3–5 клипов на V1/A1, общей длительностью 1–3 минуты.
2. На таймлайне поставь **In/Out точки** (клавиши `I` и `O`).
3. На вкладке «Чат» нажми **«Транскрибировать In–Out»**.
4. Жди — индикатор LED идёт: красный → жёлтый → зелёный.
5. Когда зелёный, в чате напиши: `что на таймлайне?` — должна вернуться структура секвенции.
6. Напиши: `почисти паразитов` — должен предложиться план вырезок.

**Если все 6 шагов прошли — установка завершена ✅.**

---

## 🪟 Windows — пошагово

### Шаг 1 — Установить ffmpeg

1. Скачать с https://ffmpeg.org/download.html (Windows builds → gyan.dev → release essentials)
2. Распаковать в `C:\ffmpeg` **или** `C:\Program Files\ffmpeg` — плагин проверяет оба пути автоматически (`C:\ffmpeg\bin\ffmpeg.exe`, `C:\Program Files\ffmpeg\bin\ffmpeg.exe`), PATH в этом случае не обязателен
3. Если распаковал в другое место — добавь его `bin` в системный PATH:
   - `Win+Pause` → Advanced system settings → Environment Variables → System variables → Path → Edit → New
   - Плагин найдёт ffmpeg через `where ffmpeg`
4. Открыть **новый** PowerShell (старый PATH не подхватит):

```powershell
ffmpeg -version
# Ожидаемый ответ: версия + список configured features
```

### Шаг 2 — Включить CEP Debug Mode

Через regedit:

1. `Win+R` → `regedit`
2. Перейти: `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12`
3. Если папки `CSXS.12` нет — создать (правый клик → New → Key)
4. В правой панели создать **DWORD (32-bit) Value** с именем `PlayerDebugMode` и значением `1`

Альтернатива через PowerShell (admin):

```powershell
New-ItemProperty -Path "HKCU:\SOFTWARE\Adobe\CSXS.12" -Name "PlayerDebugMode" -Value 1 -PropertyType DWORD -Force
```

**Проверка:**

```powershell
Get-ItemProperty -Path "HKCU:\SOFTWARE\Adobe\CSXS.12" -Name "PlayerDebugMode"
# Ожидаемый ответ: PlayerDebugMode : 1
```

⚠️ **Полностью закрой Premiere** после установки PlayerDebugMode.

### Шаг 3 — Склонировать репо

```powershell
cd "$env:APPDATA\Adobe\CEP\extensions\"
git clone <repo-url> Extensions-LLM-Chat_Pr
cd Extensions-LLM-Chat_Pr
```

Если папки `extensions` ещё нет — создать:

```powershell
mkdir "$env:APPDATA\Adobe\CEP\extensions" -ErrorAction SilentlyContinue
```

### Шаг 4 — Создать fm-secrets.js

```powershell
Copy-Item client\shared\fm-secrets.example.js client\shared\fm-secrets.js
notepad client\shared\fm-secrets.js
# Вписать apiKey, сохранить
```

### Шаги 5–6 — Открытие панели и smoke-тест

Те же, что шаги 6–7 в разделе macOS выше. Только убедись, что Premiere — **полностью** новый процесс после смены `PlayerDebugMode`.

---

## ✅ Чеклист первого запуска

После установки проверь по списку:

- [ ] **`Window → Extensions → ИИ: монтаж`** есть в меню
- [ ] Панель открывается без красных ошибок в верхней части
- [ ] Чат принимает сообщения и отвечает
- [ ] LED транскрипта виден (красный — нет транскрипта; это нормально на чистом старте)
- [ ] Кнопка «Транскрибировать In–Out» не выдаёт «ffmpeg не найден»
- [ ] После транскрипта LED становится зелёным
- [ ] В чате на «что на таймлайне?» возвращается структура секвенции

Если **все 7 пунктов ОК — система готова к работе**.

---

## 🆘 Troubleshooting

### Проблема: `ИИ: монтаж` нет в меню `Window → Extensions`

**Причины (по убыванию вероятности):**

1. **PlayerDebugMode = 0 или не установлен**

   Проверь:
   ```bash
   # macOS
   defaults read com.adobe.CSXS.12 PlayerDebugMode
   # Должно вывести: 1
   ```
   Если выводит `0` или ошибку «not exist» — выполни Шаг 2 ещё раз и **полностью перезапусти Premiere**.

2. **Папка установлена в неправильное место**

   ```bash
   ls ~/Library/Application\ Support/Adobe/CEP/extensions/Extensions-LLM-Chat_Pr/CSXS/manifest.xml
   ```
   Если файла нет — папка не там. Размести именно по этому пути (не в Downloads, не в Documents).

3. **Premiere не перезапущена после смены PlayerDebugMode**

   Cmd+Q (полный quit), потом снова открой.

4. **Premiere слишком старая** (`< 24.0`)

   Open Premiere → меню About — нужна **2024 или новее**. Manifest явно отвергает PP 23.

---

### Проблема: «Не настроен API (fm-secrets.js / fm-defaults.js)»

**Причина:** `fm-secrets.js` отсутствует или `apiKey` пустой.

**Фикс:**
```bash
ls client/shared/fm-secrets.js
# Если No such file — выполни Шаг 5 (создать из example)

grep apiKey client/shared/fm-secrets.js
# Если значение пустое или 'YOUR-KEY' — впиши реальный ключ Cloud.ru
```

После правки **закрой и снова открой панель** (Window → Extensions → ИИ: монтаж).

---

### Проблема: «ffmpeg не найден» при транскрибации

**Причина:** ffmpeg не в PATH или установлен в нестандартное место.

**Фикс macOS:**
```bash
which ffmpeg
# Если ничего — установи через brew:
brew install ffmpeg
which ffmpeg
# Должен вернуть путь типа /opt/homebrew/bin/ffmpeg

# Перезапусти Premiere после установки ffmpeg, чтобы CEP-Node подхватил PATH
```

**Фикс Windows:**
```powershell
where ffmpeg
# Если "Could not find files" — либо положи ffmpeg в C:\ffmpeg\bin или
# C:\Program Files\ffmpeg\bin (плагин проверяет оба сам), либо добавь свою
# bin-папку в PATH (см. Шаг 1 Windows)
# Перезапусти Premiere
```

⚠️ Плагин ищет ffmpeg по фиксированным путям (`findFfmpegPath` в `audio-preprocess.js`): macOS — `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; Windows — `C:\ffmpeg\bin`, `C:\Program Files\ffmpeg\bin`; затем fallback на `which`/`where` (PATH). CEP-Chromium наследует PATH из контекста, в котором запущен Premiere, поэтому если ffmpeg в произвольном месте — добавь его в PATH **до** запуска Premiere.

---

### Проблема: «ExtendScript вернул ошибку. raw=EvalScript error.» при первой операции

**Причина:** Cold-start race у CEP 12 на macOS — ExtendScript-движок не успевает прогреться к первому вызову.

**Текущее состояние:** В `client/shared/bridge-premiere.js` есть retry с backoff (0/300/900 мс), он автоматически повторяет вызов на холодном старте. Видимая ошибка означает что и через 3 retry не сработало.

**Фикс:**
1. Cmd+Q Premiere → подождать 5 сек → запустить снова
2. Открыть панель — повторить ту операцию, что фейлилась
3. Если стабильно повторяется — открой DevTools (`http://localhost:8098`), сделай Cmd+R reload панели, посмотри Console на красные ошибки. Скриншот → пришли разработчику.

См. `.omc/research/pp26-compatibility-analysis.md` для глубокой диагностики.

---

### Проблема: Транскрибация повисла > 5 минут

**Причины:**
- Большой файл (длинная In/Out зона)
- Медленная сеть к Cloud.ru
- Cloud.ru API недоступен

**Фикс:**
1. Открой DevTools (`localhost:8098`) → Console — там видны прогресс-сообщения от чанков.
2. Network tab — проверь, идут ли запросы к `foundation-models.api.cloud.ru` и какой статус.
3. Если всё висит — отмени операцию (Esc / красная кнопка стопа в панели), уменьши In/Out до 30 сек и повтори.

Если повторяется на коротких видео — `apiKey` неверный или Cloud.ru недоступна.

---

### Проблема: Чат отвечает «401 Unauthorized» / «invalid API key»

**Причина:** `apiKey` в `fm-secrets.js` неверный или истёк.

**Фикс:**
1. Получи новый ключ на https://cloud.ru/ → Foundation Models → API keys
2. Впиши в `client/shared/fm-secrets.js`
3. Закрой и снова открой панель

---

### Проблема: «JSON is undefined» / любая операция падает с ReferenceError в ExtendScript

**Причина:** Часть сборок движка ExtendScript в Premiere **не имеют нативного объекта `JSON`**. Без него все ~85 вызовов `JSON.stringify/parse` в host падали, и плагин не работал вовсе. Баг проявляется только на определённых машинах/ОС (на других JSON присутствует), поэтому коварен при переносе.

**Фикс:** В `host/premiere.jsx` встроен JSON-полифилл с защитным гардом (`if (typeof JSON === 'undefined')`) — ставится только там, где нативного JSON нет, и безопасен везде. Проверь, что версия host свежая:
```bash
grep -n "JSON-полифилл для ExtendScript" host/premiere.jsx   # должна найтись
grep -n "_EXT_PRM_.version" host/premiere.jsx                # должно быть >= '2.6.1'
# Если не нашлось — у тебя старая версия. Сделай git pull, полный рестарт Premiere.
```

> Сопутствующее: ExtendScript — это ES3, в нём нет `String.trim`, `Array.forEach`, `Object.keys`. Если правишь host — не используй эти методы (host их обходит вручную).

---

### Проблема: Что-то совсем странное

1. Открой DevTools нашей панели:
   ```
   http://localhost:8098
   ```
   Откроется список — клик на нашу панель, в новой вкладке откроется DevTools. Перейди на **Console**.

2. Сделай скрин Console + расскажи разработчику:
   - Что нажимал
   - Что появилось в Console (красные ошибки в первую очередь)
   - Версия Premiere (Help → About)
   - Версия macOS / Windows
   - Размер файла видео

---

## 📚 Связанные документы

- [README.md](README.md) — обзор плагина и быстрый старт
- [docs/MANUAL_TESTS.md](docs/MANUAL_TESTS.md) — полный чеклист ручного тестирования
- [docs/DEV_ARTIFACTS.md](docs/DEV_ARTIFACTS.md) — артефакты разработки и known issues
- `.omc/research/pp26-compatibility-analysis.md` — глубокая диагностика PP 2026

---

## 🔄 Если ставишь не первый раз

После `git pull` свежей версии:
1. **Cmd+Q Premiere** (полный quit)
2. Открой Premiere заново
3. Открой панель

`fm-secrets.js` и кэш транскриптов остаются — переустанавливать ffmpeg / PlayerDebugMode не нужно.

Если после `git pull` появились новые скрипты в `client/shared/` (видно по `git diff`) — они подхватятся автоматически, никаких ручных действий.
