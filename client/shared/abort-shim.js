/**
 * AbortController для старых CEF в CEP + общий флаг для cooperative abort.
 */
(function (global) {
  if (typeof global.AbortController === 'function') {
    global.createAbortPair = function () {
      var ac = new global.AbortController();
      return {
        signal: ac.signal,
        abort: function () {
          ac.abort();
        },
        get aborted() {
          return ac.signal.aborted;
        }
      };
    };
    return;
  }

  global.AbortController = function AbortController() {
    var aborted = false;
    this.signal = { _listeners: [] };
    var sig = this.signal;
    Object.defineProperty(sig, 'aborted', {
      get: function () {
        return aborted;
      }
    });
    sig.addEventListener = function () {};
    sig.removeEventListener = function () {};
    this.abort = function () {
      if (aborted) return;
      aborted = true;
    };
  };

  global.createAbortPair = function () {
    var ac = new global.AbortController();
    return {
      signal: ac.signal,
      abort: function () {
        ac.abort();
      },
      get aborted() {
        return ac.signal.aborted;
      }
    };
  };
})(typeof window !== 'undefined' ? window : this);
