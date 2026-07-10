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
    if (!btn || btn.disabled) return;                      // Stop/absent -> let native handle
    e.preventDefault();
    e.stopImmediatePropagation();
    btn.click();
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
      log('limit lifted; resuming');
      if (pendingPrompt) { setComposer(pendingPrompt); }
      clickSend();
      post('resumed', {});
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
