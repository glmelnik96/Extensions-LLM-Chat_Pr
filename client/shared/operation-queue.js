/**
 * Очередь операций панели — сериализация асинхронных действий против гонок.
 *
 * Проблема: onSend / onTranscribeTimeline / onAudioOnlyAnalyze каждый
 * самостоятельно ставил `runAbort = createAbortPair()` и крутил async-работу.
 * Запуск второй операции поверх первой перезатирал runAbort (кнопка «Стоп»
 * переставала отменять первую) и пускал две async-цепочки параллельно против
 * общего состояния (ExtendScript-мост, ContextStore) → порча данных.
 *
 * Здесь — единый мьютекс на одну операцию за раз:
 *   - tryBegin(label) — захватить, если свободно (политика reject-if-busy:
 *     для правок таймлайна параллелизм небезопасен, очередь на устаревшем
 *     снимке хуже явного отказа);
 *   - end()           — освободить.
 * FIFO-режим enqueue() удалён в ревью 06.08.2026 — панель нигде его
 * не использовала (везде reject-if-busy).
 */
(function (global) {
  function createOperationQueue() {
    var running = false;
    var runningLabel = null;

    return {
      /** Захватить мьютекс, если свободно. true — захвачено, false — занято. */
      tryBegin: function (label) {
        if (running) return false;
        running = true;
        runningLabel = label != null ? label : null;
        return true;
      },

      /** Освободить мьютекс. */
      end: function () {
        running = false;
        runningLabel = null;
      },

      isBusy: function () { return running; },
      label: function () { return runningLabel; }
    };
  }

  global.OperationQueue = { create: createOperationQueue };
  /* Export for testing */
  global._operationQueueInternals = { createOperationQueue: createOperationQueue };
})(window);
