'use strict';

// Shared open-chat set across machines (wq#2036).
// Design: /home/lumen/foreman/research/wq2036_ccc_shared_state_design.md
//
// OR-Set keyed on claude.ai conversation id, over per-host append-only op
// logs (ccc-ops.<host>.jsonl). Each host appends ONLY to its own file and
// reads all of them, so any file transport is conflict-free by construction.
// A chat is open iff its newest 'add' stamp is greater than its newest
// 'close' stamp across all hosts. Stamp = (at, host), compared in that order,
// so ties break deterministically on host name.
//
// Pure module: no electron, no main.js wiring. Only `tabs` membership is
// shared; pageOffset, order and geometry stay machine-local.

const fs = require('fs');
const path = require('path');

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
const CONV_RE = /^https:\/\/claude\.ai\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

// A tile that has not been given a conversation yet (new chat, /recents, ...)
// has no id and is never shared.
function convIdFromUrl(url) {
  const m = CONV_RE.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

function opsFile(dir, host) {
  return path.join(dir, `ccc-ops.${host}.jsonl`);
}

function cmpStamp(a, b) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.host !== b.host) return a.host < b.host ? -1 : 1;
  return 0;
}

function validOp(o) {
  return o && (o.t === 'add' || o.t === 'close') && typeof o.id === 'string' &&
    Number.isFinite(o.at) && typeof o.host === 'string' && o.host.length > 0;
}

// Tolerates a torn last line (crash mid-append), blank lines and junk.
function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (validOp(o)) out.push(o); } catch (_e) { /* skip */ }
  }
  return out;
}

function readAllOps(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const ops = [];
  for (const n of names) {
    if (!/^ccc-ops\..+\.jsonl$/.test(n)) continue;
    try { ops.push(...parseLines(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch (_e) { /* unreadable file: skip */ }
  }
  return ops;
}

// id -> { open, url, title, addStamp, closeStamp }
function materialise(ops) {
  const m = new Map();
  for (const o of ops) {
    let e = m.get(o.id);
    if (!e) { e = { open: false, url: null, title: null, addStamp: null, closeStamp: null }; m.set(o.id, e); }
    const stamp = { at: o.at, host: o.host };
    if (o.t === 'add') {
      if (!e.addStamp || cmpStamp(stamp, e.addStamp) > 0) {
        e.addStamp = stamp; e.url = o.url || e.url; e.title = o.title || e.title;
      }
    } else if (!e.closeStamp || cmpStamp(stamp, e.closeStamp) > 0) {
      e.closeStamp = stamp;
    }
  }
  for (const e of m.values()) e.open = !!e.addStamp && (!e.closeStamp || cmpStamp(e.addStamp, e.closeStamp) > 0);
  return m;
}

// Per-host log handle. `at` is strictly increasing per host (even inside one
// millisecond, or after a clock step back), so a host's own add-then-close
// always resolves to closed.
function createLog(dir, host) {
  if (!host) throw new Error('createLog: host required');
  fs.mkdirSync(dir, { recursive: true });
  const file = opsFile(dir, host);
  let lastAt = 0;
  try { for (const o of parseLines(fs.readFileSync(file, 'utf8'))) if (o.at > lastAt) lastAt = o.at; } catch (_e) { /* new log */ }
  function append(op) {
    const at = Math.max(op.at || Date.now(), lastAt + 1);
    lastAt = at;
    const full = Object.assign({}, op, { at, host });
    fs.appendFileSync(file, JSON.stringify(full) + '\n');
    return full;
  }
  return {
    file,
    add(id, url, title, at) { return append({ t: 'add', id, url: url || null, title: title || null, at }); },
    close(id, at) { return append({ t: 'close', id, at }); },
  };
}

// What to do with the local tile set given the merged view. Pure.
//   localTabs: [{ url, lastActive }]   -> ops to emit, chats to open, chats to close
// A locally-open chat the log has never seen is new intent -> emit add.
// One the log says closed is closed remotely UNLESS the tile was used after
// that close (then it is a re-open -> emit add). Merged-open chats with no
// local tile are opened locally.
function plan(localTabs, merged, now) {
  const emit = [], toClose = [], toOpen = [];
  const local = new Set();
  for (const t of localTabs) {
    const id = convIdFromUrl(t.url);
    if (!id || local.has(id)) continue;
    local.add(id);
    const e = merged.get(id);
    const used = Number.isFinite(t.lastActive) ? t.lastActive : now;
    if (!e) emit.push({ t: 'add', id, url: t.url, title: t.title || null, at: used });
    else if (!e.open) {
      if (e.closeStamp && used > e.closeStamp.at) emit.push({ t: 'add', id, url: t.url, title: t.title || null, at: used });
      else toClose.push(id);
    }
  }
  for (const [id, e] of merged) if (e.open && !local.has(id)) toOpen.push({ id, url: e.url, title: e.title });
  return { emit, toClose, toOpen };
}

// Local user action -> ops. prevIds/curIds are conversation-id sets from two
// consecutive local snapshots. A tile navigating from chat X to chat Y is
// close(X) + add(Y).
function localDelta(prevTabs, curTabs) {
  const ids = (tabs) => { const m = new Map(); for (const t of tabs) { const id = convIdFromUrl(t.url); if (id) m.set(id, t); } return m; };
  const p = ids(prevTabs), c = ids(curTabs);
  const ops = [];
  for (const [id, t] of c) if (!p.has(id)) ops.push({ t: 'add', id, url: t.url, title: t.title || null });
  for (const id of p.keys()) if (!c.has(id)) ops.push({ t: 'close', id });
  return ops;
}

// Rewrite THIS host's file only. Drops ops that can never change the merged
// result: own non-maximal adds/closes, own adds already dominated by any
// host's newer close, and own close tombstones older than the TTL once no
// host still holds an older add for that id (dropping earlier would let a
// stale add resurrect the chat).
function compact(dir, host, now) {
  const all = readAllOps(dir);
  const merged = materialise(all);
  const file = opsFile(dir, host);
  let mine = [];
  try { mine = parseLines(fs.readFileSync(file, 'utf8')); } catch (_e) { return { kept: 0, dropped: 0 }; }
  const oldestAdd = new Map();
  for (const o of all) if (o.t === 'add') {
    const s = { at: o.at, host: o.host }, cur = oldestAdd.get(o.id);
    if (!cur || cmpStamp(s, cur) < 0) oldestAdd.set(o.id, s);
  }
  const keep = [];
  for (const o of mine) {
    const e = merged.get(o.id), s = { at: o.at, host: o.host };
    if (o.t === 'add') {
      if (cmpStamp(s, e.addStamp) !== 0) continue;                      // superseded add
      if (e.closeStamp && cmpStamp(e.closeStamp, s) > 0) continue;      // dominated by a newer close
    } else {
      if (cmpStamp(s, e.closeStamp) !== 0) continue;                    // superseded close
      const old = oldestAdd.get(o.id);
      const stale = now - o.at > TOMBSTONE_TTL_MS;
      if (stale && !e.open && (!old || cmpStamp(old, s) > 0)) continue; // safe tombstone GC
    }
    keep.push(o);
  }
  if (keep.length !== mine.length) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep.map((o) => JSON.stringify(o)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, file);
  }
  return { kept: keep.length, dropped: mine.length - keep.length };
}

module.exports = {
  TOMBSTONE_TTL_MS, convIdFromUrl, opsFile, readAllOps, materialise, createLog, plan, localDelta, compact, cmpStamp, parseLines,
};
