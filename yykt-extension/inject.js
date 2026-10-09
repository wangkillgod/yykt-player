// Runs in the PAGE world (manifest: "world": "MAIN") at document_start,
// BEFORE any site script executes.
//
// Why: the player sometimes fires a NATIVE alert()
//   "网络异常，请检查网络并刷新网页重新加载试试"
// A native alert freezes the whole tab's JS main thread - even the
// extension content script cannot click it. The only reliable fix is to
// neutralize alert() before the site ever calls it. Suppressing it behaves
// exactly like a user clicking "确定" instantly, and playback continues.
(function() {
  'use strict';
  try {
    window.alert = function(msg) {
      try { console.warn('[YYKT] suppressed native alert:', msg); } catch(e) {}
      // no-op = same as the user clicking 确定 immediately
    };
  } catch(e) {}
})();
