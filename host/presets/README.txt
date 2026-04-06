Пресет для транскрибации области In–Out на таймлайне
=====================================================

Панели «монтаж по тексту» и «маркеры» могут экспортировать аудио между In и Out через
Sequence.exportAsMediaDirect — нужен файл пресета Adobe Media Encoder (.epr), только аудио.

Как получить файл TimelineAudio.epr:
1. В Premiere: Файл → Экспорт → Медиа (или Cmd+M / Ctrl+M).
2. Формат: только аудио (например WAV или MP3).
3. «Сохранить пресет…» → сохраните как TimelineAudio.epr
4. Положите файл сюда:

   Extensions-LLM-Chat_Pr/host/presets/TimelineAudio.epr

Либо укажите абсолютный путь к любому .epr в client/shared/fm-defaults.js → exportAudioPresetPath.

Если пресета нет: при одном аудиоклипе в In–Out плагин попытается передать путь к исходному файлу
(ограничение по длительности — maxDirectTranscribeMediaSec в fm-defaults.js).
