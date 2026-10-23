/* ==========================================================================
   CCC Skim Layer — page driver (v0.2, 2026-08-10)

   v0.2 PERF FIX (Frank: "very stuttery when typing"). v0.1 observed
   document.body subtree/childList and ran a FULL pass 400ms after ANY
   mutation — including the composer's own churn while typing. Three fixes:
     1. Composer mutations are ignored outright. Typing schedules nothing.
     2. Debounce 400ms -> 900ms, and the pass runs in requestIdleCallback so
        it never competes with keystroke rendering.
     3. The pass is incremental (see skim-core v0.2): unchanged blocks are a
        string compare, not a re-walk, and the Highlight registry is only
        rebuilt when something actually changed.
   Kill switch, per tile, no restart: CCCSkim.setEnabled(false)
   ========================================================================== */
(function () {
  'use strict';
  if (window.__CCC_SKIM__) return;
  window.__CCC_SKIM__ = true;

  var SCOPE_SEL = [
    '[class*="font-claude-response"]',
    '[class*="claude-response-body"]',
    '[data-testid="assistant-message"]',
    '[class*="group/message-row"] [class*="prose"]'
  ].join(', ');
  // anything under here is the user's own typing surface - never a trigger
  var COMPOSER_SEL = 'div[class*="sticky"][class*="bottom-0"], [contenteditable="true"], form';

  function streaming() {
    return !!document.querySelector('button[aria-label*="Stop" i]');
  }
  function idle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 0);
  }
  function pass() {
    try {
      if (streaming() || !window.CCCSkim || !window.CCCSkim.isEnabled()) return;
      var s = document.querySelectorAll(SCOPE_SEL);
      if (!s.length) return;
      window.CCCSkim.apply(Array.prototype.slice.call(s));
    } catch (e) { /* cosmetic only */ }
  }

  function deepPass() {
    try {
      if (streaming() || !window.CCCSkim || !window.CCCSkim.isEnabled()) return;
      var s = document.querySelectorAll(SCOPE_SEL);
      if (s.length) window.CCCSkim.apply(Array.prototype.slice.call(s), { deep: true });
    } catch (e) {}
  }

  var t = null;
  function kick() { clearTimeout(t); t = setTimeout(function () { idle(pass); }, 900); }

  function relevant(muts) {
    for (var i = 0; i < muts.length; i++) {
      var n = muts[i].target;
      if (!n) continue;
      var el = n.nodeType === 1 ? n : n.parentElement;
      if (!el) continue;
      if (el.closest && el.closest(COMPOSER_SEL)) continue;   // typing -> ignore
      return true;
    }
    return false;
  }

  function arm() {
    if (!window.CCCSkim) return;
    document.documentElement.classList.add('ccc-pal-90s');
    idle(pass);
    new MutationObserver(function (muts) {
      if (relevant(muts)) kick();
    }).observe(document.body, { subtree: true, childList: true });
    // safety net for a quiet DOM after streaming ends; incremental so it is
    // a no-op string compare when nothing changed
    setInterval(function () { if (!streaming()) idle(function () { deepPass(); }); }, 15000);
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm);
  else if (document.body) arm();
})();
