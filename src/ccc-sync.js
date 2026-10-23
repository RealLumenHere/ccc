'use strict';

// Glue between the pure OR-Set module (ccc-ops.js) and main.js (wq#2036).
// Electron-free on purpose: every side effect arrives through `deps`, so the
// whole state machine is unit-testable (test/ccc-sync.test.js).
//
// OFF by default. Enabled only when CCC_SYNC=1 is in the environment or a
// file named `ccc-sync.enabled` exists in userData. With it off, main.js
// behaves exactly as before (maybeStart returns null, every hook is a no-op).
//
// Scope: shares WHICH conversations are open. Order, pageOffset, geometry and
// colour stay machine-local. It opens and closes tiles; it never reloads one,
// so it cannot interrupt a streaming response. It also never closes the
// focused tile, and opens remote chats at the END of the tile list without
// touching the active tile or pageOffset, so a remote change never moves what
// the person is looking at.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('./ccc-ops');

const RECONCILE_MIN_GAP_MS = 5000;
const POLL_MS = 60000;
const COMPACT_MS = 6 * 3600 * 1000;
const MAX_OPEN_PER_RECONCILE = 8;

function createSync(deps) {
  const { dir, host, getTabs, openChat, closeChat, isProtected } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const oplog = ops.createLog(dir, host);
  let prev = [];
  let applying = false;
  let lastReconcile = 0;
  let timer = null;
  let compactTimer = null;

  // A local user action -> ops. Ignored while WE are applying a remote change,
  // otherwise opening a remote chat would echo back as a fresh local add.
  function onLocalChange() {
    if (applying) return [];
    const cur = getTabs();
    const emitted = [];
    for (const o of ops.localDelta(prev, cur)) {
      emitted.push(o.t === 'add' ? oplog.add(o.id, o.url, o.title, now()) : oplog.close(o.id, now()));
    }
    prev = cur;
    return emitted;
  }

  // Pull the merged view (other hosts' files may have changed under us) and
  // converge the local tile set toward it.
  function reconcile(force) {
    const t = now();
    if (!force && t - lastReconcile < RECONCILE_MIN_GAP_MS) return null;
    lastReconcile = t;
    const merged = ops.materialise(ops.readAllOps(dir));
    const p = ops.plan(getTabs(), merged, t);
    applying = true;
    const result = { emitted: 0, closed: [], opened: [], skippedClose: [] };
    try {
      for (const e of p.emit) { oplog.add(e.id, e.url, e.title, e.at); result.emitted++; }
      for (const id of p.toClose) {
        if (isProtected && isProtected(id)) { result.skippedClose.push(id); continue; }
        closeChat(id); result.closed.push(id);
      }
      for (const o of p.toOpen.slice(0, MAX_OPEN_PER_RECONCILE)) {
        openChat({ url: o.url || `https://claude.ai/chat/${o.id}`, title: o.title }); result.opened.push(o.id);
      }
    } catch (e) {
      log('reconcile error', e && e.message);
    } finally {
      prev = getTabs();
      applying = false;
    }
    if (result.closed.length || result.opened.length) log('reconcile', JSON.stringify(result));
    return result;
  }

  function start() {
    reconcile(true);
    try { ops.compact(dir, host, now()); } catch (e) { log('compact error', e.message); }
    timer = setInterval(() => reconcile(false), POLL_MS);
    compactTimer = setInterval(() => { try { ops.compact(dir, host, now()); } catch (_e) { /* next round */ } }, COMPACT_MS);
    if (timer.unref) timer.unref();
    if (compactTimer.unref) compactTimer.unref();
  }

  function stop() { clearInterval(timer); clearInterval(compactTimer); }

  return { start, stop, onLocalChange, reconcile, oplogFile: oplog.file };
}

function isEnabled(userDataDir, env) {
  env = env || process.env;
  if (env.CCC_SYNC === '1') return true;
  try { return fs.existsSync(path.join(userDataDir, 'ccc-sync.enabled')); } catch (_e) { return false; }
}

function hostName(env) {
  env = env || process.env;
  return String(env.CCC_HOST || os.hostname()).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'host';
}

// Returns null when disabled. `deps` = { getTabs, openChat, closeChat, isProtected, log }.
function maybeStart(userDataDir, deps, env) {
  if (!isEnabled(userDataDir, env)) return null;
  const dir = (env || process.env).CCC_SYNC_DIR || path.join(userDataDir, 'ccc-ops');
  const s = createSync(Object.assign({ dir, host: hostName(env) }, deps));
  s.start();
  return s;
}

module.exports = { createSync, maybeStart, isEnabled, hostName, RECONCILE_MIN_GAP_MS, MAX_OPEN_PER_RECONCILE };
