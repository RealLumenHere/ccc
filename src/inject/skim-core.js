/* ==========================================================================
   CCC Skim Layer — core engine (v0.2, 2026-08-10)

   v0.2 PERF FIX. v0.1 recomputed EVERYTHING on every pass: querySelectorAll
   over the whole conversation, a TreeWalker over every text node of every
   message, 7 regexes per node, then a full rebuild of all Highlight objects.
   The driver fired that on any body mutation — including composer churn — so
   typing in a long chat stuttered. v0.2 caches per block element and only
   recomputes blocks whose text actually changed.

   Design unchanged: ZERO node insertion.
     Tier A - Range styling via CSS Custom Highlight API. ::highlight() allows
              only color, background-color, text-decoration, text-shadow and
              -webkit-text-stroke-* (MDN); font-weight is NOT allowed, so
              weight is faked with -webkit-text-stroke-width (no reflow).
     Tier B - classList only (attribute change; not observed by the driver,
              so it cannot feed back into the mutation loop).
   ========================================================================== */
(function (root) {
  'use strict';

  var RULES = [
    { name: 'label', anchored: true,
      re: /^\s*([A-Z][A-Za-z0-9 '"\/&()#-]{0,34}:)(?=\s|$)/ },
    { name: 'good', re: /\b(SHIPPED|DONE|LIVE|PASSED|PASS|VERIFIED|RESOLVED|CLOSED|ARMED|ACTIVE)\b/g },
    { name: 'bad',  re: /\b(BLOCKED|FAILED|FAIL|BROKEN|BROKE|DEAD|ERROR|DOWN|HAZARD|STALE)\b/g },
    { name: 'warn', re: /\b(PENDING-FRANK|PENDING|OPEN|HELD|GATED|STAGED|TODO|NOTE|WARNING|RISK|CAUTION|UNCONFIRMED|UNKNOWN)\b/g },
    { name: 'ident', re: /\b(?:wq|aq|PR|issue|ticket)\s?#\d+/gi },
    { name: 'ident', re: /\b(?=[0-9a-f]{7,40}\b)(?:[a-f]*[0-9]){2,}[0-9a-f]*\b/g },
    { name: 'num',   re: /\b\d+(?:\.\d+)?\s?(?:W|kWh|GHz|MHz|GB|MB|KB|TB|ms|min|%)\b/g }
  ];

  var HLNAMES = ['label', 'good', 'bad', 'warn', 'ident', 'num'];
  var BLOCK_SEL = 'p, li, h1, h2, h3, h4, blockquote';
  var SKIP_SEL = 'pre, code, kbd, samp, textarea, input, [contenteditable="true"]';

  var CACHE = new WeakMap();   // block element -> { sig, ranges }
  var TRACKED = [];            // iterable list of cached blocks (pruned each pass)
  var SEALED = new WeakSet();  // message containers that can no longer change
  var enabled = true;

  function textNodesIn(el) {
    var out = [];
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  }

  function mkRange(node, s, e) {
    var rg = new Range();
    rg.setStart(node, s);
    rg.setEnd(node, e);
    return rg;
  }

  // cheap change signature: length + head + tail. Avoids re-walking stable text.
  function sigOf(el) {
    var t = el.textContent || '';
    return t.length + '|' + t.slice(0, 32) + '|' + t.slice(-16);
  }

  // compute ranges for ONE block. Returns { label:[], good:[], ... }
  function rangesFor(block) {
    var out = {};
    HLNAMES.forEach(function (n) { out[n] = []; });
    var nodes = textNodesIn(block);
    if (!nodes.length) return out;
    for (var r = 0; r < RULES.length; r++) {
      var rule = RULES[r];
      if (rule.anchored) {
        var m = rule.re.exec(nodes[0].nodeValue);
        if (m) {
          var st = m.index + m[0].indexOf(m[1]);
          out[rule.name].push(mkRange(nodes[0], st, st + m[1].length));
        }
        continue;
      }
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i], mm;
        rule.re.lastIndex = 0;
        while ((mm = rule.re.exec(node.nodeValue)) !== null) {
          if (mm[0].length === 0) { rule.re.lastIndex++; continue; }
          out[rule.name].push(mkRange(node, mm.index, mm.index + mm[0].length));
        }
      }
    }
    return out;
  }

  function tagBlock(el) {
    if (el.tagName === 'LI') { el.classList.add('ccc-skim-item'); return; }
    if (el.tagName !== 'P') return;
    var labelled = /^\s*[A-Z][A-Za-z0-9 '"\/&()#-]{0,34}:(\s|$)/.test(el.textContent || '');
    el.classList.toggle('ccc-skim-block', labelled);
  }

  // opts.deep = true ignores seals and re-scans every scope (safety sweep).
  function apply(scopes, opts) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    var deep = !!(opts && opts.deep);
    var list = scopes && scopes.length ? scopes : [document.body];
    var dirty = false, seen = 0, recomputed = 0;

    // prune blocks React has thrown away
    var live = [];
    for (var p = 0; p < TRACKED.length; p++) {
      if (TRACKED[p].isConnected) live.push(TRACKED[p]);
      else dirty = true;
    }
    TRACKED = live;

    for (var s = 0; s < list.length; s++) {
      // a message with another message below it is finished: seal and skip.
      // Only the last scope is re-scanned on a normal pass.
      if (!deep && SEALED.has(list[s])) continue;
      var blocks;
      try { blocks = list[s].querySelectorAll(BLOCK_SEL); } catch (e) { continue; }
      for (var b = 0; b < blocks.length; b++) {
        var el = blocks[b];
        if (el.closest(SKIP_SEL)) continue;
        seen++;
        var sig = sigOf(el), hit = CACHE.get(el);
        if (hit && hit.sig === sig) continue;          // unchanged -> reuse cache
        if (!hit) TRACKED.push(el);
        try {
          CACHE.set(el, { sig: sig, ranges: rangesFor(el) });
          tagBlock(el);
          recomputed++; dirty = true;
        } catch (e) { /* one bad block must not kill the pass */ }
      }
      if (s < list.length - 1) SEALED.add(list[s]);
    }

    if (!dirty) return { ok: true, skipped: true, blocks: seen };
    return publish(seen, recomputed);
  }

  // union cached ranges -> Highlight registry. Only runs when something moved.
  function publish(seen, recomputed) {
    var counts = {};
    if (!(root.CSS && root.CSS.highlights && typeof root.Highlight === 'function')) {
      return { ok: true, unsupported: true, blocks: seen };
    }
    for (var h = 0; h < HLNAMES.length; h++) {
      var name = HLNAMES[h], hl = new root.Highlight(), n = 0;
      for (var i = 0; i < TRACKED.length; i++) {
        var c = CACHE.get(TRACKED[i]);
        if (!c) continue;
        var rs = c.ranges[name];
        for (var j = 0; j < rs.length; j++) { try { hl.add(rs[j]); n++; } catch (e) {} }
      }
      counts[name] = n;
      if (n) root.CSS.highlights.set('ccc-skim-' + name, hl);
      else root.CSS.highlights.delete('ccc-skim-' + name);
    }
    return { ok: true, blocks: seen, recomputed: recomputed, counts: counts };
  }

  function clear() {
    if (root.CSS && root.CSS.highlights) {
      HLNAMES.forEach(function (n) { root.CSS.highlights.delete('ccc-skim-' + n); });
    }
    var els = document.querySelectorAll('.ccc-skim-block, .ccc-skim-item');
    for (var i = 0; i < els.length; i++) {
      els[i].classList.remove('ccc-skim-block', 'ccc-skim-item');
    }
    TRACKED = [];
    CACHE = new WeakMap();
    SEALED = new WeakSet();
  }

  function setEnabled(v) { enabled = !!v; if (!enabled) clear(); return enabled; }

  root.CCCSkim = {
    version: '0.2',
    rules: RULES,
    names: HLNAMES,
    apply: apply,
    clear: clear,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    tracked: function () { return TRACKED.length; },
    supported: !!(root.CSS && root.CSS.highlights)
  };
})(typeof window !== 'undefined' ? window : globalThis);
