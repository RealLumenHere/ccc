'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Small hand-rolled persistence (no electron-store dep to avoid version churn).
// State shape:
// {
//   tabs: [ { id, url, title, lastActive, sidebarExpanded, color } ],
//   pageOffset: number,
//   zoomFactor: number,
//   columnFractions: number[] | null
// }
// color: null | 'green'|'red'|'black'|'gray'|'yellow'|'white' — per-tile
// identification tag set from the in-header color pad (2026-09-25).
// zoomFactor: applies to every chat tile at once (Ctrl+=/-/0, 2026-09-25).
// columnFractions: manual tile-width split from dragging the seam between
// tiles, one fraction per column, sums to 1; null = equal split. Resets
// itself (in main.js) whenever the live column count no longer matches its
// length, e.g. after moving CCC to a different-resolution monitor.

function stateFile() {
  return path.join(app.getPath('userData'), 'ccc-state.json');
}

function load() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tabs)) return null;
    return data;
  } catch (_e) {
    return null; // first run or corrupt -> caller supplies defaults
  }
}

let pending = null;

// Synchronous flush for close/quit paths. The debounced save is fine
// mid-session, but win 'close' -> app.quit() kills the process before a
// 400ms timer can fire — tabs closed just before quitting resurrected on
// next launch (2026-08-06 zombie-tab bug). This cancels any pending timer
// and writes immediately.
function saveNow(getState) {
  clearTimeout(pending); pending = null;
  try {
    const data = getState();
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, stateFile()); // atomic on same fs
  } catch (e) {
    console.error('[ccc] state saveNow failed:', e.message);
  }
}

function saveDebounced(getState, delayMs) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    try {
      const data = getState();
      const tmp = stateFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, stateFile()); // atomic on same fs
    } catch (e) {
      console.error('[ccc] state save failed:', e.message);
    }
  }, delayMs);
}

module.exports = { load, saveDebounced, saveNow, stateFile };
