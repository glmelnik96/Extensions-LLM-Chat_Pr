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
 *   - end()           — освободить и разбудить следующего в FIFO-очереди;
 *   - enqueue(fn)     — поставить задачу в FIFO и выполнить, когда освободится.
 */
(function (global) {
  function createOperationQueue() {
    var running = false;
    var runningLabel = null;
    var waiters = []; /* [{ resolve, label }] — FIFO */

    function _acquire(label) {
      running = true;
      runningLabel = label != null ? label : null;
    }

    var q = {
      /** Захватить мьютекс, если свободно. true — захвачено, false — занято. */
      tryBegin: function (label) {
        if (running) return false;
        _acquire(label);
        return true;
      },

      /** Освободить мьютекс и передать его следующему ожидающему (FIFO). */
      end: function () {
        if (waiters.length) {
          var next = waiters.shift();
          runningLabel = next.label != null ? next.label : null;
          /* running остаётся true — мьютекс сразу переходит к next */
          next.resolve();
          return;
        }
        running = false;
        runningLabel = null;
      },

      /** Поставить задачу в FIFO-очередь. Возвращает promise результата taskFn.
       *  Мьютекс захватывается/освобождается автоматически. */
      enqueue: function (taskFn, label) {
        var turn;
        if (!running) {
          _acquire(label);
          turn = Promise.resolve();
        } else {
          turn = new Promise(function (resolve) {
            waiters.push({ resolve: resolve, label: label });
          });
        }
        return turn.then(function () {
          return Promise.resolve()
            .then(taskFn)
            .then(
              function (v) { q.end(); return v; },
              function (e) { q.end(); throw e; }
            );
        });
      },

      isBusy: function () { return running; },
      label: function () { return runningLabel; },
      pendingCount: function () { return waiters.length; }
    };
    return q;
  }

  global.OperationQueue = { create: createOperationQueue };
  /* Export for testing */
  global._operationQueueInternals = { createOperationQueue: createOperationQueue };
})(window);
