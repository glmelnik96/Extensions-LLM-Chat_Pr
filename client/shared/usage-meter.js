/**
 * usage-meter.js — session-scoped token/cost accumulator. Browser IIFE.
 *
 * Pure logic, no DOM, no network. Reads tariffs from FM_DEFAULTS.pricing
 * (weak coupling via global, same pattern as other shared modules).
 * Published as global.UsageMeter.
 *
 *   recordChat(model, usage)  — usage = { prompt_tokens, completion_tokens }.
 *                               Adds tokens; ₽ = in/1e6*inPerM + out/1e6*outPerM.
 *                               Unknown model → 0 ₽ (tokens still accumulate).
 *                               Broken/missing usage → no-op.
 *   recordWhisper(seconds)    — adds seconds; ₽ += seconds * whisperPerSec.
 *   getSummary()              — { inTokens, outTokens, totalTokens, whisperSec, rubles }.
 *   reset()                   — zeroes everything.
 *   onChange(cb)              — registers a callback fired after each record/reset.
 */
(function (global) {
  'use strict';

  var inTokens = 0;
  var outTokens = 0;
  var whisperSec = 0;
  var rubles = 0;
  var callbacks = [];

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function getPricing() {
    return (global.FM_DEFAULTS && global.FM_DEFAULTS.pricing) || null;
  }

  function getSummary() {
    return {
      inTokens: inTokens,
      outTokens: outTokens,
      totalTokens: inTokens + outTokens,
      whisperSec: whisperSec,
      rubles: rubles
    };
  }

  function fireChange() {
    var summary = getSummary();
    for (var i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i](summary);
      } catch (e) {
        /* one bad callback must not break the others */
      }
    }
  }

  function recordChat(model, usage) {
    if (!usage) return;
    if (!isFiniteNumber(usage.prompt_tokens) || !isFiniteNumber(usage.completion_tokens)) {
      return;
    }
    var prompt = Number(usage.prompt_tokens) || 0;
    var completion = Number(usage.completion_tokens) || 0;

    var inPerM = 0;
    var outPerM = 0;
    var pricing = getPricing();
    if (pricing && pricing.models && pricing.models[model]) {
      var rate = pricing.models[model];
      inPerM = Number(rate.inPerM) || 0;
      outPerM = Number(rate.outPerM) || 0;
    }

    var rub = (prompt / 1e6) * inPerM + (completion / 1e6) * outPerM;

    inTokens += prompt;
    outTokens += completion;
    rubles += rub;
    fireChange();
  }

  function recordWhisper(seconds) {
    var sec = Number(seconds);
    if (!isFiniteNumber(sec) || sec <= 0) return;

    var perSec = 0;
    var pricing = getPricing();
    if (pricing && isFiniteNumber(Number(pricing.whisperPerSec))) {
      perSec = Number(pricing.whisperPerSec) || 0;
    }

    whisperSec += sec;
    rubles += sec * perSec;
    fireChange();
  }

  function reset() {
    inTokens = 0;
    outTokens = 0;
    whisperSec = 0;
    rubles = 0;
    fireChange();
  }

  function onChange(cb) {
    if (typeof cb === 'function') {
      callbacks.push(cb);
    }
  }

  global.UsageMeter = {
    recordChat: recordChat,
    recordWhisper: recordWhisper,
    getSummary: getSummary,
    reset: reset,
    onChange: onChange
  };
})(typeof window !== 'undefined' ? window : this);
