/* ==========================================================================
   Claude Command Center — in-page automations (MAIN WORLD).
   Injected via webContents.executeJavaScript so it can wrap the page's own
   fetch(). Talks to the preload (isolated world) with window.postMessage; the
   preload relays to the main process over IPC.

   Native replacements for:
     - Claude Auto-Continue      (clicks the "Continue" button)
     - Claude Usage Tracker      (feeds the unified bottom bar)
     - the Tampermonkey resume   (waits out a limit, resumes with human jitter)

   Everything is wrapped in try/catch and selector lookups are text/attribute
   based, so a claude.ai markup change degrades to a no-op, never a broken page.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__CCC_ACTIVE__) return;      // idempotent
  window.__CCC_ACTIVE__ = true;

  var CFG = window.__CCC_CFG__ || {};
  function post(type, data) {
    try { window.postMessage({ __ccc: true, type: type, data: data }, '*'); } catch (e) {}
  }
  var log = function () { if (CFG.usageDebug) console.log.apply(console, ['[ccc:auto]'].concat([].slice.call(arguments))); };

  // -------------------------------------------------------------------------
  // Title report (so the tab chip tracks the chat name)
  // -------------------------------------------------------------------------
  function reportTitle() { post('usage', { title: document.title }); }
  new MutationObserver(reportTitle)
    .observe(document.querySelector('title') || document.documentElement, { childList: true, subtree: true });
  reportTitle();

  // -------------------------------------------------------------------------
  // 1) AUTO-CONTINUE
  // -------------------------------------------------------------------------
  var chain = 0, lastTurnKey = '';
  function findContinueButton() {
    var btns = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').trim().toLowerCase();
      if (txt === 'continue' || txt === 'continue response') {
        if (!btns[i].disabled && btns[i].offsetParent !== null) return btns[i];
      }
    }
    return null;
  }
  function autoContinueTick() {
    if (!CFG.autoContinue) return;
    try {
      var btn = findContinueButton();
      if (!btn) { chain = 0; return; }
      // guard: don't hammer the same stuck turn forever
      var key = String(document.querySelectorAll('[data-testid*="message"]').length);
      if (key !== lastTurnKey) { lastTurnKey = key; chain = 0; }
      if (chain >= (CFG.autoContinueMax || 12)) { log('auto-continue chain cap hit'); return; }
      chain++;
      log('clicking Continue (', chain, ')');
      btn.click();
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 2) SESSION-RESUME  (native port of the Tampermonkey script)
  //    When a limit banner appears, remember any prompt we couldn't send,
  //    schedule a wake at reset + random jitter, then resume.
  // -------------------------------------------------------------------------
  var resumeTimer = null, pendingPrompt = null;
  var LIMIT_RE = /(message|usage)\s+limit|reached your (usage|limit)|limit will reset|you'?ve hit|out of messages/i;
  var RESET_TIME_RE = /reset[s]?\s+(?:at\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?)/i;
  var RESET_IN_RE = /reset[s]?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i;

  function limitBannerText() {
    var nodes = document.body.querySelectorAll('div,section,p,span');
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent || '';
      if (t.length < 240 && LIMIT_RE.test(t)) return t;
    }
    return null;
  }
  function jitterMs() {
    var lo = (CFG.resumeJitterMin || 45), hi = (CFG.resumeJitterMax || 210);
    return (lo + Math.random() * (hi - lo)) * 1000;
  }
  function parseResetDelayMs(txt) {
    var m = RESET_IN_RE.exec(txt);
    if (m && (m[1] || m[2])) {
      return ((parseInt(m[1] || 0, 10) * 60 + parseInt(m[2] || 0, 10)) * 60 * 1000);
    }
    m = RESET_TIME_RE.exec(txt);
    if (m) {
      var now = new Date(), target = new Date(now.toDateString() + ' ' + m[1]);
      if (isNaN(target)) return null;
      if (target <= now) target.setDate(target.getDate() + 1);
      return target - now;
    }
    return null; // unknown -> caller will just poll
  }
  function composer() {
    // activeElement-first (2026-08-08): the field being typed in wins. The old
    // document-order query could grab a DIFFERENT contenteditable (title edit,
    // artifact pane, search) added earlier in the DOM; the keydown guard then
    // saw activeElement outside "the composer" and bailed — plain Enter dead,
    // Ctrl+Enter only. Fall back to the query for setComposer()/resume paths.
    var a = document.activeElement;
    if (a) {
      if (a.tagName === 'TEXTAREA' || a.isContentEditable) return a;
      if (a.closest) { var ce = a.closest('div[contenteditable="true"]'); if (ce) return ce; }
    }
    return document.querySelector('div[contenteditable="true"], textarea[data-testid], textarea');
  }
  function setComposer(text) {
    var el = composer(); if (!el) return false;
    if (el.tagName === 'TEXTAREA') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  }
  function clickSend() {
    var b = document.querySelector('button[aria-label*="Send" i], button[data-testid*="send" i]');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  }

  // -------------------------------------------------------------------------
  // ENTER-TO-SEND ENFORCEMENT (hardened 2026-07-09)
  //   Plain Enter inside the composer should send. We intercept in capture
  //   phase and click the composer's Send button. The lookup used to be a
  //   document-wide querySelector for anything with "Send"/"send" and clicked
  //   the FIRST match — which grabbed a menu-trigger button elsewhere and
  //   opened the conversation ⋯ menu instead of sending. Now: scope to the
  //   composer's own container and exclude menu triggers (aria-haspopup).
  // -------------------------------------------------------------------------
  function findSendBtn(el){
    var safe='button[aria-label*="Send" i]:not([aria-haspopup]):not([aria-expanded="true"]), button[data-testid*="send" i]:not([aria-haspopup])';
    var scope=el.closest('form')||el.closest('[class*="composer" i]')||el.closest('[data-testid*="composer" i]')||el.closest('fieldset');
    return (scope && scope.querySelector(safe)) || document.querySelector(safe);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;        // never break IME
    var el = composer();
    if (!el) return;
    var a = document.activeElement;
    if (el !== a && !el.contains(a)) return;               // only inside composer
    var text = (el.value != null ? el.value : (el.textContent || '')).trim();
    if (!text) return;                                     // nothing to send
    var btn = findSendBtn(el);
    if (btn && !btn.disabled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      btn.click();
      return;
    }
    // No Send button (markup drift). If NOT mid-generation (no Stop button),
    // synthesize Ctrl+Enter — the path that still works natively — so plain
    // Enter never silently dead-ends again (2026-08-08 hardening).
    if (document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      ctrlKey: true, bubbles: true, cancelable: true
    }));
  }, true);
  function scheduleResume(txt) {
    if (!CFG.resume || resumeTimer) return;
    var delay = parseResetDelayMs(txt);
    var wait = (delay != null ? delay : (CFG.resumePoll || 30) * 1000) + jitterMs();
    log('limit hit; resume scheduled in', Math.round(wait / 1000), 's');
    post('limit', { text: txt, resumeInSec: Math.round(wait / 1000) });
    resumeTimer = setTimeout(function tryResume() {
      resumeTimer = null;
      if (limitBannerText()) {           // still limited -> keep polling
        resumeTimer = setTimeout(tryResume, (CFG.resumePoll || 30) * 1000);
        return;
      }
      // Never hijack a message the user is actively composing (2026-09-04 fix:
      // clickSend() used to fire unconditionally on resume and would send the
      // user's half-typed draft). Only auto-send our OWN saved pendingPrompt,
      // and only when the composer is free.
      var _el = composer();
      var _live = _el ? (_el.value != null ? _el.value : (_el.textContent || '')).trim() : '';
      var _typing = _el && (document.activeElement === _el || _el.contains(document.activeElement));
      if (_typing || (_live && _live !== (pendingPrompt || '').trim())) {
        resumeTimer = setTimeout(tryResume, (CFG.resumePoll || 30) * 1000);  // defer; don't touch the user's draft
        return;
      }
      if (pendingPrompt) {
        log('limit lifted; resuming saved prompt');
        setComposer(pendingPrompt);
        clickSend();
        post('resumed', {});
      }
      pendingPrompt = null;
    }, wait);
  }
  function resumeTick() {
    if (!CFG.resume) return;
    var txt = limitBannerText();
    if (txt) {
      var c = composer();
      if (c && !pendingPrompt) {
        var draft = (c.value || c.textContent || '').trim();
        if (draft) pendingPrompt = draft;
      }
      scheduleResume(txt);
    }
  }

  // -------------------------------------------------------------------------
  // 3) USAGE CAPTURE + COMPLETION  (fetch/XHR wrap)
  //    We don't hardcode claude.ai's private response shape. We (a) scrape the
  //    native usage panel for immediate numbers, and (b) sniff responses that
  //    look usage-related and forward candidates so exact fields can be bound.
  // -------------------------------------------------------------------------
  var USAGE_URL_RE = /usage|rate.?limit|\/limits|\/bootstrap|statsig/i;
  var COMPLETION_URL_RE = /completion|append_message|retry|stop_response|chat_conversations\/.+\/(messages|completion)/i;
  var USAGE_KEY_RE = /five.?hour|resets_at|utilization|usage_limit|"weekly"|remaining_?tokens/i;
  var DEBUG_KEY_RE = /remaining|reset|limit|utiliz|usage|five.?hour|weekly|percent|quota|tokens_left|exceeded/i;

  function looksLikeUsage(obj) {
    try { return USAGE_KEY_RE.test(JSON.stringify(obj).slice(0, 2000)); } catch (e) { return false; }
  }

  var CCC_ORG = null; // sniffed org id, for the proactive usage poller
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    try { var _om = /\/api\/organizations\/([0-9a-fA-F-]{36})(?:[\/?]|$)/.exec(url); if (_om) CCC_ORG = _om[1]; } catch (e) {}
    var p = origFetch.apply(this, arguments);
    if (CFG.usageDebug) { try { post('url-seen', { url: url }); } catch(e){} }
    // NOTE: never tee/clone the completion STREAM. Cloning a long-lived stream
    // and draining the clone here shares backpressure with claude.ai's own
    // branch; if our reader ever stalls (a swallowed read error, an aborted or
    // stop_response turn), the tee buffers forever, claude.ai never sees
    // end-of-stream, stays "generating", and the composer wedges - plain Enter
    // silently no-ops until reload. Completion is now detected passively from
    // the DOM (completionTick in the heartbeat); it never touches fetch bodies.
    // In debug we widen to ANY non-stream JSON response carrying usage-ish keys,
    // so the real endpoint+fields are positively ID'd regardless of URL. The
    // completion STREAM is always excluded (clone/tee = backpressure wedge).
    // Debug: log ratelimit/usage response HEADERS (safe: reading headers never
    // consumes the body/stream). This is where claude.ai actually carries the
    // 5h/weekly numbers if they're header-delivered.
    if (CFG.usageDebug && /completion|organizations|experiences|bootstrap|messages/.test(url)) {
      p.then(function (res) {
        try {
          var hs = {};
          if (res.headers && res.headers.forEach) {
            res.headers.forEach(function (v, k) {
              if (/ratelimit|usage|limit|remaining|reset|quota|tokens|unified/i.test(k)) hs[k] = v;
            });
          }
          if (Object.keys(hs).length) post('usage-candidate', { url: url, headers: hs });
        } catch (e) {}
      }).catch(function () {});
    }
    var _sniff = CFG.usageDebug ? !COMPLETION_URL_RE.test(url) : USAGE_URL_RE.test(url);
    if (_sniff) {
      p.then(function (res) {
        try {
          var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (ct.indexOf('json') === -1) return;
        } catch (e) {}
        res.clone().json().then(function (j) {
          var hit = CFG.usageDebug
            ? USAGE_KEY_RE.test(JSON.stringify(j).slice(0, 4000))
            : looksLikeUsage(j);
          if (hit) {
            post('usage-candidate', { url: url, json: j });    // for binding
            emitUsageFromJson(j);                              // best-effort now
          }
        }).catch(function () {});
      }).catch(function () {});
    }
    return p;
  };

  // Bind claude.ai's usage shape to the bottom bar. Observed (Pro/Max):
  //   { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at},
  //     seven_day_opus:{...}, ... }  — utilization is a 0..1 fraction.
  // _findUsageRoot locates that object wherever it sits (top-level or nested),
  // so it works regardless of which endpoint/field carries it. If we recognize
  // the block but can't map it, fall back to the raw hint so the bar still shows
  // the "stream detected" state and the capture campaign keeps the candidate.
  function _pct(u) {
    if (typeof u !== 'number' || isNaN(u)) return null;
    return Math.max(0, Math.min(100, Math.round(u))); // claude.ai /usage: already 0..100
  }
  function _fmtReset(iso) {
    try {
      if (!iso) return '';
      var d = new Date(iso); if (isNaN(d)) return '';
      var now = new Date();
      var s = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
      if (d.toDateString() !== now.toDateString()) s = d.toLocaleDateString([], { weekday: 'short' }) + ' ' + s;
      return s;
    } catch (e) { return ''; }
  }
  function _slot(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var p = _pct(obj.utilization);
    return p == null ? null : { pct: p, reset: _fmtReset(obj.resets_at) };
  }
  function _slotFromLimit(l) {
    if (!l) return null;
    var p = _pct(typeof l.percent === 'number' ? l.percent : l.utilization);
    return p == null ? null : { pct: p, reset: _fmtReset(l.resets_at) };
  }
  function _findUsageRoot(j, depth) {
    if (!j || typeof j !== 'object' || (depth || 0) > 4) return null;
    if (j.five_hour || j.seven_day || Array.isArray(j.limits)) return j;
    for (var k in j) {
      if (j[k] && typeof j[k] === 'object') {
        var r = _findUsageRoot(j[k], (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  }
  // claude.ai /api/organizations/<org>/usage (observed 2026-07): utilization and
  // limits[].percent are 0..100. limits[] is authoritative: kind session /
  // weekly_all, plus a weekly_scoped entry whose scope.model.display_name is the
  // premium model (Fable). Prefer limits[], fall back to five_hour/seven_day.
  function emitUsageFromJson(j) {
    try {
      var root = _findUsageRoot(j, 0);
      if (!root) return;
      var lims = Array.isArray(root.limits) ? root.limits : [];
      function findLim(pred) { for (var i = 0; i < lims.length; i++) { if (pred(lims[i])) return lims[i]; } return null; }
      var sL = findLim(function (l) { return l && (l.kind === 'session' || l.group === 'session'); });
      var wL = findLim(function (l) { return l && l.kind === 'weekly_all'; });
      var fL = findLim(function (l) { return l && l.scope && l.scope.model && /fable|mythos/i.test(l.scope.model.display_name || ''); });
      var out = {};
      var s = _slotFromLimit(sL) || _slot(root.five_hour); if (s) out.session = s;
      var w = _slotFromLimit(wL) || _slot(root.seven_day); if (w) out.weekly = w;
      var f = _slotFromLimit(fL) || _slot(root.seven_day_fable) || _slot(root.seven_day_mythos); if (f) out.fableWeekly = f;
      if (out.session || out.weekly || out.fableWeekly) post('usage', out);
      else if (CFG.usageDebug) post('usage', { raw: j }); // debug hint only
    } catch (e) {}
  }

  // Native usage panel scrape (immediate, no endpoint needed). Works when the
  // sidebar/usage area is rendered. Matches the "Session (5h)/Weekly" panel.
  function scrapeSidebarUsage() {
    try {
      // Trust the DOM only on the usage settings page; open chats can literally
      // contain "weekly 50%" text and would post bogus numbers otherwise.
      if (!/\/settings\/usage/.test(location.pathname)) return;
      var data = {};
      var rows = document.body.querySelectorAll('div,li,span');
      for (var i = 0; i < rows.length; i++) {
        var t = (rows[i].textContent || '').trim();
        if (t.length > 60) continue;
        var mSess = /session[^%]*?(\d{1,3})\s*%/i.exec(t);
        var mWeek = /^weekly[^%]*?(\d{1,3})\s*%/i.exec(t);
        var mFab  = /fable[^%]*?(\d{1,3})\s*%/i.exec(t);
        if (mSess) data.session = { pct: +mSess[1] };
        if (mWeek) data.weekly = { pct: +mWeek[1] };
        if (mFab)  data.fableWeekly = { pct: +mFab[1] };
      }
      if (Object.keys(data).length) post('usage', data);
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Debug-only: dump leaf DOM text that looks usage-related (+ tag/class path)
  // so real selectors can be written for the usage popover. Off unless usageDebug.
  if (CFG.usageDebug) {
    setInterval(function () {
      try {
        var out = [], all = document.body.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length) continue;
          var t = (el.textContent || '').trim();
          if (!t || t.length > 30) continue;
          // Only leaves that START with a usage label or ARE a bare percentage.
          // Excludes chat titles like "...session usage issue" (long, not anchored).
          if (!/^(\d{1,3}\s*%|session|weekly|fable|opus|resets?\b|% used)/i.test(t)) continue;
          var path = [], n = el, d = 0;
          while (n && d < 4) {
            var c = (n.className && typeof n.className === 'string') ? '.' + n.className.split(' ').slice(0,2).join('.') : '';
            path.unshift(n.tagName + c); n = n.parentElement; d++;
          }
          out.push({ t: t, p: path.join('>') });
        }
        if (out.length) post('usage-candidate', { dom: out.slice(0, 50) });
      } catch (e) {}
    }, 4000);
  }

  // COMPLETION DETECTION (passive, DOM-based - never taps fetch streams)
  //   A generating turn shows a Stop control; when it reverts to Send we treat
  //   the turn as complete. Worst case (selector miss) = a lost ntfy ping,
  //   never a wedged composer.
  // -------------------------------------------------------------------------
  var wasStreaming = false;
  function isStreaming() {
    var stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
    return !!(stop && stop.offsetParent !== null);
  }
  function completionTick() {
    try {
      var s = isStreaming();
      if (wasStreaming && !s) { post('completed', {}); scrapeSidebarUsage(); }
      wasStreaming = s;
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------
  setInterval(function () {
    autoContinueTick();
    resumeTick();
    completionTick();
  }, 1500);
  setInterval(scrapeSidebarUsage, 8000);
  scrapeSidebarUsage();

  // Proactive usage poll so the bar stays live during normal work (claude.ai
  // only fetches /usage on the settings page). origFetch avoids re-triggering
  // our own sniff. Needs the org id sniffed from any /api/organizations call.
  function pollUsage() {
    try {
      if (!CCC_ORG) return;
      origFetch('/api/organizations/' + CCC_ORG + '/usage', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) emitUsageFromJson(j); })
        .catch(function () {});
    } catch (e) {}
  }
  setTimeout(pollUsage, 4000);
  setTimeout(pollUsage, 12000);
  setInterval(pollUsage, 90000);
  log('automations active for tab', CFG.tabId);
})();

/* ==========================================================================
   CCC redundant-banner suppression (2026-09-26, Frank spec): two claude.ai
   banners are pure noise in CCC and get hidden entirely.

   1. "Claude reached its tool-use limit for this turn" + Continue button:
      CCC's own AUTO-CONTINUE (top of this file, findContinueButton) already
      finds and clicks this exact button every 1.5s, so the banner never
      needs to be SEEN by a human — it's handled before anyone could react
      to it anyway. Hidden via height:0/overflow:hidden/opacity:0 rather
      than display:none specifically because findContinueButton() requires
      `offsetParent !== null` to consider a button clickable, and
      display:none — on this container OR any ancestor — nulls that for
      every descendant. Using display:none here would silently break
      auto-continue instead of just hiding a redundant message.
      height:0 + overflow:hidden collapses the visible space to nothing
      without setting display:none anywhere in the chain, so the Continue
      button inside stays "visible" enough for auto-continue's own check
      to keep finding and clicking it.

   2. "You've used N% of your weekly/session/5-hour limit" + Get more
      usage: purely informational, and CCC's bottombar already shows a
      unified Session/Weekly/Fable usage bar across every tile at once —
      this per-tile popup just repeats that same information once per open
      tab. No CCC feature reads or clicks anything inside it, so plain
      display:none is safe here. The apostrophe in "You've" is matched
      loosely (`.{1,2}` instead of a literal `'`) since a screenshot alone
      doesn't confirm whether claude.ai renders a straight or curly quote.

   claude.ai's classes for both are unstable, so — like cccCosmetics/
   cccChalkboard above — this matches by TEXT on the smallest containing
   element, never a guessed class name: a wording change degrades to
   "banner stays visible again," never a crash or a false-positive hide.
   ========================================================================== */
(function cccHideNoiseBanners() {
  var TOOL_LIMIT_RE = /reached its tool-use limit/i;
  var USAGE_LIMIT_RE = /you.{1,2}ve used \d+%\s*of your .*limit/i;
  // 2026-09-26 fix: verified live that the FIRST version of this (matching
  // only the message-text phrase) under-hid the usage-limit banner. The
  // "You've used N%..." text and the "Get more usage"/close-X controls
  // turned out to be SIBLING divs, not one nested inside the other — so
  // "smallest matching div" correctly found the narrowest element and hid
  // just the text line, leaving the button row fully visible with no
  // explanation above it (visually worse than doing nothing). Now requires
  // BOTH the message phrase AND its button's text in the SAME candidate
  // element, which forces smallestMatch up to the card-level container
  // that actually wraps both, instead of settling for a text-only leaf.
  function usageLimitTest(t) { return USAGE_LIMIT_RE.test(t) && /get more usage/i.test(t); }
  function toolLimitTest(t) { return TOOL_LIMIT_RE.test(t) && /continue/i.test(t); }
  function smallestMatch(el, test) {
    var t = el.textContent || '';
    if (t.length > 220 || !test(t)) return false;
    var kids = el.querySelectorAll('div');
    for (var i = 0; i < kids.length; i++) {
      if (test(kids[i].textContent || '')) return false; // a descendant also matches -> not the smallest
    }
    return true;
  }
  // 2026-09-26 second fix: verified live AGAIN after the text+button fix
  // above — closed the first under-match, but left a new one: the banner's
  // close ("×") button turned out to be a SIBLING of the text+button card,
  // one level further up, not inside it. Hiding just the card left a small
  // floating × with nothing else, same failure shape as before at one
  // level removed. Rather than chase a third exact nesting guess, this
  // climbs ONE extra parent level past the matched card before hiding —
  // notification toasts are shallow, so the true outer wrapper (content +
  // dismiss control together) is very likely one level up from wherever
  // the content itself first satisfies the match. Capped for safety: never
  // climbs into body/html/main/.cds-root, and abandons the climb (falls
  // back to the original, narrower match) if the parent's combined text
  // balloons past 400 chars — a sign it's no longer a small toast but some
  // much larger, unrelated ancestor.
  function widenOneLevel(el) {
    var p = el.parentElement;
    if (!p) return el;
    var tag = p.tagName;
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') return el;
    if (p.classList && p.classList.contains('cds-root')) return el;
    var t = p.textContent || '';
    if (t.length > 400) return el;
    return p;
  }
  function fix() {
    try {
      var divs = document.querySelectorAll('div:not([data-ccc-hide])');
      for (var i = 0; i < divs.length; i++) {
        var el = divs[i];
        if (smallestMatch(el, toolLimitTest)) {
          el.dataset.cccHide = 'tool-limit'; // mark the match itself too, or it re-qualifies every mutation tick
          var toolTarget = widenOneLevel(el);
          toolTarget.dataset.cccHide = 'tool-limit';
          toolTarget.style.cssText += ';height:0 !important;min-height:0 !important;overflow:hidden !important;opacity:0 !important;margin:0 !important;padding:0 !important;pointer-events:none !important;';
          continue;
        }
        if (smallestMatch(el, usageLimitTest)) {
          el.dataset.cccHide = 'usage-limit'; // mark the match itself too, or it re-qualifies every mutation tick
          var usageTarget = widenOneLevel(el);
          usageTarget.dataset.cccHide = 'usage-limit';
          usageTarget.style.display = 'none';
        }
      }
    } catch (_e) { /* cosmetic only — never break the page */ }
  }
  var t = null;
  var kick = function () { clearTimeout(t); t = setTimeout(fix, 150); };
  var arm = function () { fix(); new MutationObserver(kick).observe(document.body, { subtree: true, childList: true }); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm);
  else if (document.body) arm();
})();

/* ==========================================================================
   CCC cosmetics (2026-08-06): collapse the "Switched to <model> / Edit and
   retry with <model>" banner to one small line. claude.ai's classes for it
   are unstable, so we match by text on the smallest containing div.
   ========================================================================== */
(function cccCosmetics() {
  function fix() {
    try {
      const divs = document.querySelectorAll('div:not([data-ccc-sw])');
      for (const el of divs) {
        const t = el.textContent || '';
        if (t.length > 160 || !/Switched to/.test(t) || !/Edit and retry/.test(t)) continue;
        // only style the deepest matching div (skip ancestors of a match)
        if ([...el.querySelectorAll('div')].some((c) => /Switched to/.test(c.textContent || '') && /Edit and retry/.test(c.textContent || ''))) continue;
        el.dataset.cccSw = '1';
        el.style.cssText += ';display:flex;flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:nowrap;gap:10px;font-size:11px;line-height:1.25;padding:2px 8px;min-height:0;white-space:nowrap;';
        for (const c of el.querySelectorAll('*')) {
          c.style.fontSize = '11px';
          c.style.paddingTop = '0px';
          c.style.paddingBottom = '0px';
          c.style.minHeight = '0';
          c.style.whiteSpace = 'nowrap';
        }
      }
    } catch (_e) { /* cosmetic only — never break the page */ }
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(fix, 150); };
  const arm = () => { fix(); new MutationObserver(kick).observe(document.body, { subtree: true, childList: true }); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm);
  else if (document.body) arm();
})();

/* ==========================================================================
   CCC chalkboard (2026-08-06): on empty /new tiles, fill the dead space with
   a Simpsons-opening-style board of things Lumen has to write out. Semi-
   translucent, pointer-events none, sits under the composer. 90s pass.
   ========================================================================== */
(function cccChalkboard() {
  const QUIPS = [
    'I will not reboot without asking Frank',
    'I will not dd anything, ever',
    'The BC-250s are not space heaters',
    'I will not spoof the sacred MAC',
    'Swap is not a personality',
    'I will not blame Cloudflare again',
    'Backups first, bravado second',
    'I will not wake Wadjet for fun',
    'The vault drill is not optional',
    'I will not ship on a Friday at 3am'
  ];
  const ID = 'ccc-chalkboard';
  function render() {
    try {
      const onNew = location.pathname === '/new' || location.pathname === '/';
      let el = document.getElementById(ID);
      if (!onNew) { if (el) el.remove(); return; }
      if (!el) {
      const q = QUIPS[Math.floor(Math.random() * QUIPS.length)];
      el = document.createElement('div');
      el.id = ID;
      el.textContent = (q + '\n').repeat(8);
      el.style.cssText = [
        'position:fixed', 'left:18px', 'right:18px', 'bottom:16px',
        'overflow:hidden', 'z-index:1', 'pointer-events:none',
        // 2026-09-26 v3: gradient base tuned from rgba(8,14,32,...) to
        // rgba(29,31,35,...) to match the lighter charcoal pane bg (v3
        // redesign) instead of the old near-black v2 canvas.
        'background:linear-gradient(rgba(29,31,35,0.85),rgba(29,31,35,0.85)), repeating-linear-gradient(0deg, rgba(53,224,230,0.10) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(53,224,230,0.10) 0 1px, transparent 1px 26px)',
        'border:1px solid rgba(255,95,168,0.38)',
        'border-radius:4px', 'padding:12px 16px', 'box-sizing:border-box',
        "font-family:'Ubuntu Mono','JetBrains Mono',monospace",
        'color:rgba(255,110,199,0.78)', 'font-size:15px', 'line-height:1.8',
        'letter-spacing:0.5px', 'white-space:pre-line',
        'text-shadow:0 0 8px rgba(255,110,199,0.4), 0 0 18px rgba(53,224,230,0.18)',
        '-webkit-mask-image:linear-gradient(to bottom, black 62%, transparent 97%)'
      ].join(';');
      document.body.appendChild(el);
      }
      // Never paint over the composer (2026-08-08 bug: fixed 30vh height sat
      // ON TOP of the centered composer in short CCC tiles). Sit strictly in
      // the dead space BELOW the composer; hide entirely when <70px is free.
      const c = document.querySelector('div[contenteditable="true"], textarea');
      const host = c ? (c.closest('fieldset') || c.closest('form') || c) : null;
      const avail = host
        ? (window.innerHeight - host.getBoundingClientRect().bottom - 28)
        : Math.round(window.innerHeight * 0.3);
      if (avail < 70) { el.style.display = 'none'; }
      else {
        el.style.display = 'block';
        el.style.maxHeight = Math.min(avail, Math.round(window.innerHeight * 0.3)) + 'px';
      }
    } catch (_e) { /* cosmetic only */ }
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(render, 250); };
  const arm = () => { render(); window.addEventListener('resize', kick); new MutationObserver(kick).observe(document.body, { subtree: true, childList: true }); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm);
  else if (document.body) arm();
})();

/* ==========================================================================
   CCC composer layout tagger (2026-08-07, Frank spec): classify composer
   parts with ccc-* classes so styles.css can rebuild the layout —
   toolbar strip on TOP of the black bar (+/mic/voice left, model selector
   right + shrunk), divider bar below it, full-width editor underneath.
   claude.ai classes are unstable; we tag by data-testid/aria/text and the
   CSS keys ONLY off our classes, so a markup change degrades to a no-op.
   ========================================================================== */
(function cccComposerLayout() {
  function tag() {
    try {
      var ed = document.querySelector('div[class*="sticky"][class*="bottom-0"] div[contenteditable="true"]');
      if (!ed) return;
      // composer box = nearest bg-surface ancestor of the editor
      var box = ed.closest('[class*="bg-surface-3"]') || ed.closest('fieldset') || ed.parentElement;
      if (!box) return;
      // model selector button
      var model = box.querySelector('button[data-testid*="model-selector" i]');
      if (!model) {
        var btns = box.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (/(Fable|Mythos|Opus|Sonnet|Haiku)/.test(btns[i].textContent || '')) { model = btns[i]; break; }
        }
      }
      if (!model) return; // can't identify layout -> leave page untouched
      // toolbar row = ancestor of model that is a DIRECT child of box
      var tb = model;
      while (tb.parentElement && tb.parentElement !== box) tb = tb.parentElement;
      if (tb === model || !tb.contains(model)) return;
      if (tb.contains(ed)) return; // safety: never reorder the editor's own row

      box.classList.add('ccc-cbox');
      tb.classList.add('ccc-ctb');
      // wrapper groups -> display:contents so buttons join the toolbar flex
      for (var c = 0; c < tb.children.length; c++) {
        if (tb.children[c].tagName === 'DIV') tb.children[c].classList.add('ccc-tbg');
      }
      model.classList.add('ccc-btn-model');
      var q = function (sel) { var b = tb.querySelector(sel); if (b) return b; return null; };
      var plus  = q('button[data-testid*="plus" i]') || q('button[aria-label*="attach" i]') || q('button[aria-label*="add" i]');
      var mic   = q('button[aria-label*="dictat" i]') || q('button[aria-label*="microphone" i]');
      var voice = q('button[aria-label*="voice" i]');
      var send  = q('button[aria-label*="send" i]');
      if (plus)  plus.classList.add('ccc-btn-plus');
      if (mic)   mic.classList.add('ccc-btn-mic');
      if (voice) voice.classList.add('ccc-btn-voice');
      if (send)  send.classList.add('ccc-btn-send');
    } catch (_e) { /* cosmetic only — never break the page */ }
  }
  var t = null;
  var kick = function () { clearTimeout(t); t = setTimeout(tag, 200); };
  var arm = function () { tag(); new MutationObserver(kick).observe(document.body, { subtree: true, childList: true }); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm);
  else if (document.body) arm();
})();

/* ==========================================================================
   CCC per-tile color pad (2026-09-25, Frank spec; 'white'->'blue' and
   'gray' removed 2026-09-26): the native Share button in the tile's top
   strip (.dframe-header, CDP-verified real class) is replaced with 5 small
   unlabeled color swatches — Green, Red, Black, Yellow, Blue, in that
   order — for identifying which chat is which at a glance across many
   open tiles. Clicking one tags the tile (body.ccc-color-<key>, keyed to
   the palettes in styles.css §12) and tells main to persist it on the tab
   (ccc:setColor -> ccc-state.json), so it survives a CCC restart. New
   tiles are untagged (original theme) until set. Selector lookups are
   text/attribute based like the rest of this file, so a claude.ai markup
   change degrades to "Share stays visible", never a crash.
   ========================================================================== */
(function cccColorPad() {
  var CFG2 = window.__CCC_CFG__ || {};
  // Local postMessage helper — the shared `post()` in the first IIFE at the
  // top of this file is closure-scoped there, not global; every later IIFE
  // in this file (cosmetics, chalkboard, composer-layout) redefines its own
  // when it needs one, same pattern here.
  function post(type, data) {
    try { window.postMessage({ __ccc: true, type: type, data: data }, '*'); } catch (e) {}
  }
  // 2026-09-26: 'gray' removed per Frank spec ("get rid of gray all
  // together as a chat color selection") -- 5 tags now, not 6.
  // 2026-09-26 v3: 'black' matched to the tile accent's neutral (#a1a1aa)
  // instead of true #000000 -- true black on this pad's own dark surface
  // was nearly impossible to pick out, same reasoning topbar.html's
  // COLOR_HEX dot already got.
  var SWATCHES = [
    { key: 'green',  hex: '#22c55e' },
    { key: 'red',    hex: '#ef4444' },
    { key: 'black',  hex: '#a1a1aa' },
    { key: 'yellow', hex: '#eab308' },
    { key: 'blue',   hex: '#3b82f6' }
  ];
  var current = CFG2.color || null;

  function applyBodyClass() {
    try {
      var body = document.body; if (!body) return;
      for (var i = 0; i < SWATCHES.length; i++) body.classList.remove('ccc-color-' + SWATCHES[i].key);
      if (current) body.classList.add('ccc-color-' + current);
    } catch (_e) {}
  }
  // Apply as early as possible so a restored tile shows its color on first
  // paint, not after the header-scan interval catches up.
  applyBodyClass();

  function findShareBtn(header) {
    var btns = header.querySelectorAll('button, [role="button"], a');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === 'ccc-colorpad' || (b.closest && b.closest('#ccc-colorpad'))) continue;
      var label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
      if (label === 'share' || label.indexOf('share') === 0) return b;
    }
    return null;
  }

  function markActive(pad) {
    var kids = pad.querySelectorAll('button');
    for (var i = 0; i < kids.length; i++) {
      var on = kids[i].getAttribute('data-ccc-color') === current;
      kids[i].style.outline = on ? '2px solid #fff' : '1px solid rgba(255,255,255,0.35)';
      kids[i].style.outlineOffset = '1px';
    }
  }

  function buildPad() {
    var pad = document.createElement('div');
    pad.id = 'ccc-colorpad';
    // flex-shrink:0 so the (already-truncating) title gives way to us, not
    // the reverse — this is the "widen the room" ask: a comfortable fixed
    // click target instead of squeezing into whatever the old button used.
    pad.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;' +
      'padding:2px 4px;pointer-events:auto;';
    SWATCHES.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-ccc-color', s.key);
      b.style.cssText = 'width:14px;height:14px;min-width:14px;padding:0;margin:0;' +
        'border-radius:3px;cursor:pointer;box-sizing:border-box;background:' + s.hex + ';' +
        'border:1px solid rgba(255,255,255,0.35);';
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        current = (current === s.key) ? null : s.key;   // click again to clear
        applyBodyClass();
        markActive(pad);
        post('setColor', { color: current });
      });
      pad.appendChild(b);
    });
    return pad;
  }

  function ensurePad() {
    try {
      var header = document.querySelector('.dframe-header');
      if (!header) return;
      var pad = header.querySelector('#ccc-colorpad');
      if (pad) { markActive(pad); return; }
      var shareBtn = findShareBtn(header);
      pad = buildPad();
      if (shareBtn) {
        shareBtn.style.display = 'none';
        shareBtn.parentNode.insertBefore(pad, shareBtn);
      } else {
        header.appendChild(pad); // markup drift: still surface the pad
      }
      markActive(pad);
    } catch (_e) { /* cosmetic only — never break the page */ }
  }

  var pt = null;
  var kick2 = function () { clearTimeout(pt); pt = setTimeout(ensurePad, 150); };
  var arm2 = function () { ensurePad(); new MutationObserver(kick2).observe(document.body, { subtree: true, childList: true }); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', arm2);
  else if (document.body) arm2();
})();
