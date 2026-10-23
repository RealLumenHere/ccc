'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BaseWindow, WebContentsView, session,
  ipcMain, globalShortcut, Menu, nativeTheme, shell, clipboard
} = require('electron');

// Google blocks OAuth in embedded webviews when UA advertises Electron
app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/\S+/, "").replace(/\sclaude-command-center\/\S+/i, "");

const CFG = require('./config');
const store = require('./persistence');
const cccOps = require('./ccc-ops');
const cccSyncMod = require('./ccc-sync');   // wq#2036, OFF unless CCC_SYNC=1 or userData/ccc-sync.enabled

// Per-tile ID color tag (2026-09-25, 'white'->'blue' + 'gray' removed
// 2026-09-26, Frank spec). Single source of truth so createTab()'s restore
// path and the ccc:setColor handler can't drift out of sync with each other.
const VALID_COLORS = ['green', 'red', 'black', 'yellow', 'blue'];

// Single instance: clicking the launcher while CCC is already open focuses
// the existing window instead of spawning a second copy (2026-08-06). A
// second instance also corrupts tile loads by fighting over the profile lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Touch support: Chromium X11 touch auto-detection is unreliable; force-enable
// so the wch.cn bar touchscreen scrolls instead of selecting text. (2026-07-09,
// reconciled from Thor's live copy 2026-07-11)
app.commandLine.appendSwitch('touch-events', 'enabled');

// Load-speed: keep a big HTTP disk cache so claude.ai's frequently-redeployed,
// hash-named JS bundles + fonts survive restarts instead of being evicted, and
// let Chromium download subresources in parallel to shorten cold tile boots.
// (2026-07-13)
app.commandLine.appendSwitch('disk-cache-size', String(1024 * 1024 * 1024)); // 1 GiB
app.commandLine.appendSwitch('enable-features', 'ParallelDownloading');

// --- injected assets (read once) -------------------------------------------
const INJECT_DIR = path.join(__dirname, 'inject');
const VIEW_CSS = fs.readFileSync(path.join(INJECT_DIR, 'styles.css'), 'utf8');
const AUTOMATIONS_JS = fs.readFileSync(path.join(INJECT_DIR, 'automations.js'), 'utf8');
// Skim layer (2026-08-10): core MUST load before the driver — the driver
// no-ops if window.CCCSkim is absent. Both fail soft if the files vanish.
const SKIM_CORE_JS = fs.existsSync(path.join(INJECT_DIR, 'skim-core.js'))
  ? fs.readFileSync(path.join(INJECT_DIR, 'skim-core.js'), 'utf8') : '';
const SKIM_INJECT_JS = fs.existsSync(path.join(INJECT_DIR, 'skim-inject.js'))
  ? fs.readFileSync(path.join(INJECT_DIR, 'skim-inject.js'), 'utf8') : '';

// --- runtime state ----------------------------------------------------------
let win = null;              // BaseWindow
let topbar = null;           // WebContentsView (our chrome)
let bottombar = null;        // WebContentsView (our chrome)
let claudeSession = null;    // shared persistent session (single sign-on)
let cccSync = null;          // cross-machine open-chat sync (wq#2036); null = disabled = zero behavior change
let tabs = [];               // MRU-ordered: index 0 = most recent. { id, view, url, title, lastActive, sidebarExpanded }
let activeId = null;
let pageOffset = 0;
let nextId = 1;
let restoring = false;       // suppress MRU reordering while a saved session restores

// Manual tile-width resize (2026-09-25, REDESIGNED 2026-09-26): width follows
// the TAB, not the column position. Frank: "resizes shift when i move chats"
// — correct, because colFracs used to be indexed by COLUMN, so a tab's width
// depended on which slot it happened to land in, not on which tab it was.
// Now each tab carries its own optional widthFrac (fraction of the row's
// available width); tabs without one split whatever's left equally. This
// travels with the tab through reorders, paging, and restarts.
let resizeDrag = null;       // { handleIndex, tabA, tabB, startScreenX, wA, wB, columns, gap, avail } while dragging
let handles = [];            // resize-handle WebContentsViews, one per gap: handles[i] sits between
                              // column i and column i+1. Array position IS the gap index — handles
                              // are never reordered, only appended/popped as column count changes.

// Global chat-tile zoom (2026-09-25) ------------------------------------------
let zoomFactor = CFG.ZOOM_DEFAULT;   // applies to every tile's webContents at once, never the chrome bars

// Solo a tile (2026-10-23, wq#4561): when set, only this tab is laid out, at
// full row width; the rest stay loaded but hidden. Toggle = double-click a
// chip or Ctrl+Shift+F. Clears itself if that tab closes.
let soloId = null;
// Topbar height is dynamic: the broadcast box asks for more room while it is
// open (ccc:topbarHeight) and hands it back on close.
let topbarH = CFG.TOPBAR_HEIGHT;

const DBG = (...a) => { if (process.env.CCC_DEBUG) console.log('[ccc]', ...a); };

// ---------------------------------------------------------------------------
// Session hardening: consistent Chrome/Linux identity so Cloudflare's Turnstile
// doesn't loop, plus strip the headers that trip datacenter/bot heuristics.
// ---------------------------------------------------------------------------
function hardenSession(ses) {
  ses.setUserAgent(CFG.USER_AGENT);
  const brand = `"Chromium";v="${CFG.CHROME_MAJOR}", "Google Chrome";v="${CFG.CHROME_MAJOR}", "Not?A_Brand";v="24"`;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    // keep UA and client-hints telling the SAME story
    h['User-Agent'] = CFG.USER_AGENT;
    h['sec-ch-ua'] = brand;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Linux"';
    delete h['DNT'];
    delete h['Sec-GPC'];
    cb({ requestHeaders: h });
  });
}

// ---------------------------------------------------------------------------
// Layout math. columns is driven purely by available width; the slider pages
// through the MRU array when there are more tabs than columns.
// ---------------------------------------------------------------------------
function computeColumns(width) {
  const c = Math.floor(width / CFG.MIN_TILE_WIDTH);
  return Math.max(1, Math.min(c, CFG.MAX_COLUMNS, Math.max(1, tabs.length)));
}

// Splits the row's available width among the currently VISIBLE tabs. A tab
// with an explicit widthFrac (set by dragging) gets exactly that share; tabs
// without one split whatever's left equally. If manually-set fractions ever
// sum past 92% (many tabs resized against each other), they're scaled down
// so no auto tab is squeezed to nothing — a soft clamp, not a hard reset.
function widthsForVisible(visibleTabs, avail) {
  const n = visibleTabs.length;
  if (n === 0) return [];
  const explicit = visibleTabs.map((t) => (typeof t.widthFrac === 'number' && t.widthFrac > 0) ? t.widthFrac : null);
  const explicitSum = explicit.reduce((s, f) => s + (f || 0), 0);
  const autoCount = explicit.filter((f) => f === null).length;
  let fracs;
  if (autoCount === 0) {
    fracs = explicitSum > 0 ? explicit.map((f) => f / explicitSum) : visibleTabs.map(() => 1 / n);
  } else {
    const cap = 0.92;
    const scale = explicitSum > cap ? cap / explicitSum : 1;
    const autoShare = (1 - explicitSum * scale) / autoCount;
    fracs = explicit.map((f) => (f === null ? autoShare : f * scale));
  }
  const widths = fracs.map((f) => Math.round(f * avail));
  const sum = widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += (avail - sum); // rounding remainder -> last column
  return widths;
}

// Positions every tile per current per-tab widths; returns the widths, xs,
// and the visible-tab list so callers (relayout, syncHandles, live drag)
// share one source of truth instead of recomputing the partition twice.
function layoutRow(W, top, midH, columns, gap) {
  const solo = soloTab();
  const visible = solo ? [solo] : tabs.slice(pageOffset, pageOffset + columns);
  const avail = Math.max(0, W - gap * (columns - 1));
  const widths = widthsForVisible(visible, avail);
  const xs = [];
  let x = 0;
  for (let i = 0; i < columns; i++) { xs.push(x); x += (widths[i] || 0) + gap; }

  tabs.forEach((t) => {
    const vi = visible.indexOf(t);
    if (vi === -1) {
      t._visible = false;
      t.view.setVisible(false);
    } else {
      t.view.setBounds({ x: xs[vi], y: top, width: widths[vi], height: midH });
      t._visible = true;
      t.view.setVisible(true);
    }
  });
  return { widths, xs, visible };
}

// Manual tile-width resize (2026-09-25): one thin WebContentsView per gap
// between adjacent columns, TILE_GAP wide, spanning full tile height (no
// vertical resize exists anywhere in CCC). Kept in sync with column count
// here; a currently-dragged handle is skipped — main.js expanded it to the
// full row width in ccc:resizeStart and owns its bounds until resizeEnd.
function syncHandles(columns, top, midH, gap, xs, widths) {
  const need = Math.max(0, columns - 1);
  while (handles.length < need) {
    const view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload-shell.js'), contextIsolation: true, nodeIntegration: false }
    });
    view.setBackgroundColor('#00000000');
    view.webContents.loadFile(path.join(__dirname, 'renderer', 'handle.html'));
    attachAppKeys(view.webContents);
    win.contentView.addChildView(view);
    handles.push({ view });
  }
  while (handles.length > need) {
    const h = handles.pop();
    try { win.contentView.removeChildView(h.view); h.view.webContents.close(); } catch (_e) {}
    if (resizeDrag && resizeDrag.handleIndex >= handles.length) resizeDrag = null;
  }
  // Re-raise every handle to the TOP of the z-order on every call (cheap:
  // remove+re-add). Handles are created lazily as columns appear, but tabs
  // reorder (MRU unshift on createTab), so a tile view added AFTER a handle
  // can end up spatially wherever that handle now lives and silently cover
  // it — clicks land on the tile underneath instead of the handle. This bug
  // is exactly what made the first live test miss every time. Handles must
  // always sit above every tile regardless of creation order.
  handles.forEach((h) => {
    try { win.contentView.removeChildView(h.view); win.contentView.addChildView(h.view); } catch (_e) {}
  });
  for (let i = 0; i < handles.length; i++) {
    if (resizeDrag && resizeDrag.handleIndex === i) continue; // owned mid-drag
    handles[i].view.setBounds({ x: xs[i] + widths[i], y: top, width: gap, height: midH });
  }
  if (process.env.CCC_DEBUG) {
    DBG('handle bounds', handles.map((h, i) => ({ i, x: xs[i] + widths[i], w: gap, top, midH })));
  }
}

function relayout() {
  if (!win) return;
  const [W, H] = win.getContentSize();
  const top = topbarH;
  const bot = CFG.BOTTOMBAR_HEIGHT;
  const midH = Math.max(0, H - top - bot);

  topbar.setBounds({ x: 0, y: 0, width: W, height: top });
  bottombar.setBounds({ x: 0, y: H - bot, width: W, height: bot });

  const columns = soloTab() ? 1 : computeColumns(W);
  const maxOffset = Math.max(0, tabs.length - columns);
  if (pageOffset > maxOffset) pageOffset = maxOffset;
  if (pageOffset < 0) pageOffset = 0;

  const gap = CFG.TILE_GAP || 0;
  const { widths, xs } = layoutRow(W, top, midH, columns, gap);
  syncHandles(columns, top, midH, gap, xs, widths);

  pushTabStrip(columns, maxOffset);
}

// Applies one live drag-move to the two TABS adjacent to the dragged handle
// (captured by reference at resizeStart, not by column position — that's the
// 2026-09-26 fix), converts the result back to a fraction of the row's total
// width, and repositions tiles + every OTHER handle for real-time feedback.
function applyDrag(screenX) {
  if (!resizeDrag) return;
  const { tabA, tabB, startScreenX, wA, wB, columns, gap, avail } = resizeDrag;
  const minW = CFG.MIN_COLUMN_WIDTH || 100;
  const delta = screenX - startScreenX;
  const newWA = Math.max(minW, Math.min(wA + wB - minW, wA + delta));
  const newWB = wA + wB - newWA;

  tabA.widthFrac = newWA / avail;
  tabB.widthFrac = newWB / avail;

  const [W, H] = win.getContentSize();
  const top = topbarH, bot = CFG.BOTTOMBAR_HEIGHT;
  const midH = Math.max(0, H - top - bot);
  const { widths, xs } = layoutRow(W, top, midH, columns, gap);
  for (let i = 0; i < handles.length; i++) {
    if (i === resizeDrag.handleIndex) continue;
    handles[i].view.setBounds({ x: xs[i] + widths[i], y: top, width: gap, height: midH });
  }
}

function pushTabStrip(columns, maxOffset) {
  if (!topbar) return;
  topbar.webContents.send('tabs', {
    tabs: tabs.map((t) => ({ id: t.id, title: t.title || 'New chat', color: t.color || null, status: t.status || 'idle' })),
    activeId,
    soloId,
    pageOffset,
    columns,
    maxOffset
  });
}

// Maximize / restore / fullscreen fire before the WM has settled the new content
// size, so the first relayout can run against the OLD size and Chromium leaves
// the WebContentsViews unpainted until a click forces a repaint. Run a second
// pass once geometry settles and explicitly invalidate the visible views — this
// is the "content is stuck until I click a tile" fix.
function relayoutDeferred() {
  relayout();
  setTimeout(() => {
    relayout();
    for (const t of tabs) {
      if (t._visible) { try { t.view.webContents.invalidate(); } catch (_e) {} }
    }
  }, 50);
}

// Staggered loader: restoring a saved session used to fire loadURL() for every
// tile at once, stampeding claude.ai + Cloudflare and making tiles slow to come
// up. Load them one at a time, visible (front) tiles first.
let _loadQueue = [];
let _loadTimer = null;
function enqueueLoad(tab) {
  _loadQueue.push(tab);
  if (!_loadTimer) pumpLoadQueue();
}
function pumpLoadQueue() {
  const tab = _loadQueue.shift();
  if (!tab) {
    _loadTimer = null;
    // Restore window is over once the last tile has begun loading. Give pages a
    // few seconds to settle (autofocus fires focus events) before re-enabling
    // MRU reordering, so load-time focus can't scramble the restored order.
    setTimeout(() => { restoring = false; }, 4000);
    return;
  }
  try { if (tabs.includes(tab)) tab.view.webContents.loadURL(tab.url); } catch (_e) {}
  _loadTimer = setTimeout(pumpLoadQueue, CFG.RESTORE_LOAD_STAGGER_MS);
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------
function createTab(url, restoreMeta, opts) {
  opts = opts || {};
  const id = restoreMeta && restoreMeta.id ? restoreMeta.id : nextId;
  if (id >= nextId) nextId = id + 1;

  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:claude',        // SHARED -> one login across all tiles
      preload: path.join(__dirname, 'preload-view.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      sandbox: true
    }
  });
  view.setBackgroundColor('#111318'); // 2026-09-26: matches the dark-theme pane bg (design brief)
  try { view.webContents.setZoomFactor(zoomFactor); } catch (_e) {}

  const tab = {
    id, view,
    url: url || CFG.START_URL,
    title: (restoreMeta && restoreMeta.title) || 'New chat',
    lastActive: Date.now(),
    sidebarExpanded: !!(restoreMeta && restoreMeta.sidebarExpanded),
    // Per-tile ID color tag (2026-09-25, 'white'->'blue' + 'gray' removed
    // 2026-09-26, Frank spec): null|'green'|'red'|'black'|'yellow'|'blue'.
    // New tabs default to null. Sanitized against VALID_COLORS on restore
    // so a tag retired from the palette can't silently linger forever in
    // ccc-state.json with no matching CSS to render it.
    color: VALID_COLORS.includes(restoreMeta && restoreMeta.color) ? restoreMeta.color : null,
    // Manual tile-width (2026-09-26): fraction of row width, set only by
    // dragging a handle; null = auto/equal share. Lives on the TAB so it
    // survives reorders, paging, and restarts intact.
    widthFrac: (restoreMeta && typeof restoreMeta.widthFrac === 'number') ? restoreMeta.widthFrac : null
  };

  const wc = view.webContents;

  // Cosmetic + behaviour injection once the DOM is ready.
  wc.on('dom-ready', () => {
    try { wc.setZoomFactor(zoomFactor); } catch (_e) {} // reasserted per-navigation
    wc.insertCSS(VIEW_CSS).catch(() => {});
    // main-world injection so we can hook the page's own fetch()
    wc.executeJavaScript(bootstrapFor(tab)).catch((e) => DBG('inject fail', e.message));
    if (tab.sidebarExpanded) wc.send('ccc:setSidebar', true);
    // Active-tile border: correct on every dom-ready (initial load, restore,
    // reload-after-crash) regardless of ordering against activeId elsewhere.
    try { wc.send('ccc:setActive', tab.id === activeId); } catch (_e) {}
  });

  // Self-heal blank tiles: a failed initial loadURL (transient network at
  // launch, dropped connection, renderer crash) used to leave a tile
  // permanently blank because nothing retried. Reload on failure with capped
  // backoff; reset once a load completes. ERR_ABORTED (-3) is a normal SPA
  // navigation, not a failure. (2026-09-05)
  let _reloadTimer = null;
  let _backoff = 0;
  const _RETRY_CAP = 15000;
  const _scheduleReload = (reason) => {
    if (!tabs.includes(tab) || _reloadTimer) return;
    _backoff = _backoff ? Math.min(_backoff * 2, _RETRY_CAP) : 1000;
    DBG('tile reload', tab.id, reason, _backoff + 'ms');
    _reloadTimer = setTimeout(() => {
      _reloadTimer = null;
      if (tabs.includes(tab)) { try { wc.loadURL(tab.url); } catch (_e) {} }
    }, _backoff);
  };
  wc.on('did-finish-load', () => {
    _backoff = 0;
    if (_reloadTimer) { clearTimeout(_reloadTimer); _reloadTimer = null; }
  });
  wc.on('did-fail-load', (_e, errorCode, errorDesc, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;   // subframe / ERR_ABORTED = benign
    DBG('did-fail-load', tab.id, errorCode, errorDesc);
    _scheduleReload('fail-load:' + errorCode);
  });
  wc.on('render-process-gone', (_e, details) => {
    DBG('render-gone', tab.id, details && details.reason);
    _backoff = 0;                                   // crash: retry promptly
    _scheduleReload('render-gone');
  });
  wc.on('unresponsive', () => DBG('tile unresponsive', tab.id));

  // Keep the tab title in sync with the chat.
  wc.on('page-title-updated', (_e, title) => {
    tab.title = cleanTitle(title);
    persist(); relayout();
  });
  // A tile moving to another conversation changes the shared open-chat set.
  const _syncNav = () => { if (cccSync) { try { cccSync.onLocalChange(); } catch (_e) { /* never break a tile */ } } };
  wc.on('did-navigate', _syncNav);
  wc.on('did-navigate-in-page', _syncNav);

  // Focus/click anywhere in a chat => it becomes active (MRU input).
  wc.on('focus', () => activate(tab.id, {}));   // active-only; never reorders (refresh-safe)

  // Reload this tile: Ctrl+R / F5 (Ctrl+Shift+R = hard). Scoped to the focused
  // tile via before-input-event so it never hijacks the shortcut system-wide.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (handleAppKeys(e, input)) return;   // Ctrl+T/W/arrows/1-9 etc (app-scoped)
    const k = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (k === 'f5' || (mod && k === 'r')) {
      e.preventDefault();
      if (mod && input.shift) wc.reloadIgnoringCache(); else wc.reload();
    }
  });

  // Right-click menu (the native one is otherwise swallowed by the view).
  wc.on('context-menu', (_e, params) => {
    const nav = wc.navigationHistory;
    const template = [];
    // Spelling corrections first when right-clicking a misspelled word.
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions) {
        template.push({ label: s, click: () => wc.replaceMisspelling(s) });
      }
      if (params.dictionarySuggestions.length === 0) {
        template.push({ label: 'No suggestions', enabled: false });
      }
      template.push({ type: 'separator' });
      template.push({
        label: 'Add to dictionary',
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      template.push({ type: 'separator' });
    }
    template.push(
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
      { label: 'Hard Reload', click: () => wc.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
    );
    // Explicit window: BaseWindow apps have no focused BrowserWindow, so a
    // bare popup() can silently no-op (electron#44898) — this was "right-click
    // does nothing". x/y omitted: params are view-relative; default = cursor.
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Links: claude.ai -> new tile; anything else -> the system browser
  // (xdg default, i.e. Thorium). Previously non-claude links were silently
  // denied — "links do not open" (fixed 2026-08-06).
  // openExternal can fail quietly when the app was launched without the full
  // desktop session env, so fall back to spawning xdg-open directly.
  const openInBrowser = (target) => {
    shell.openExternal(target).catch(() => {
      try {
        require('child_process').spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      } catch (_e) { /* nothing else to try */ }
    });
  };
  wc.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(CFG.ORIGIN)) { createTab(target); }
    else if (/^https?:/i.test(target)) { openInBrowser(target); }
    return { action: 'deny' };
  });
  // Same for links that navigate the tile itself away from claude.ai.
  wc.on('will-navigate', (e, target) => {
    if (target.startsWith(CFG.ORIGIN)) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) openInBrowser(target);
  });

  win.contentView.addChildView(view);
  if (!opts.deferLoad) wc.loadURL(tab.url);   // restore path loads via the staggered queue

  if (opts.background) {
    // Opened by ccc-sync because another machine has this chat open: append at
    // the END and leave the active tile and pageOffset alone, so a remote
    // change never moves what the person is looking at.
    tabs.push(tab);
    relayout(); persist();
    return tab;
  }
  const prevActiveId = activeId;
  tabs.unshift(tab);      // new tab enters at front of MRU
  pageOffset = 0;
  activeId = id;
  // Active-tile border: the new tab picks up its state in the dom-ready
  // handler above (covers restore/fresh-boot/reload uniformly); the tab
  // that WAS active is already loaded and won't get another dom-ready just
  // because a new one appeared, so clear it explicitly here.
  if (prevActiveId != null && prevActiveId !== id) pushActive(prevActiveId, false);
  relayout(); persist();
  return tab;
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  if (soloId === id) soloId = null;
  try { win.contentView.removeChildView(tab.view); } catch (_e) {}
  // BaseWindow won't destroy webContents for us -> we must, or it leaks.
  try { tab.view.webContents.close(); } catch (_e) {}
  if (activeId === id) {
    activeId = tabs[0] ? tabs[0].id : null;
    if (activeId != null) pushActive(activeId, true); // new tab takes over the border
  }
  relayout(); persist();
}

function activate(id, opts) {
  opts = opts || {};
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  const prevId = activeId;
  tab.lastActive = Date.now();
  activeId = id;
  // Active-tile border: only touch the two tiles actually changing state.
  if (prevId !== id) {
    if (prevId != null) pushActive(prevId, false);
    pushActive(id, true);
  }

  const [W] = win.getContentSize();
  const columns = computeColumns(W);
  const isVisible = idx >= pageOffset && idx < pageOffset + columns;
  const mode = CFG.REORDER_MODE || 'manual';

  // Default 'manual' NEVER reorders on activation, so a chat auto-refreshing
  // (claude.ai autofocus -> focus event) can't scramble the order. Legacy MRU
  // modes are opt-in via config. Rearrange is manual: drag a chip, or
  // Ctrl+Shift+PageUp/PageDown.
  if (mode !== 'manual' && mode !== 'off' && !restoring &&
      (mode === 'always' || (mode === 'offscreen-only' && !isVisible))) {
    tabs.splice(idx, 1);
    tabs.unshift(tab);
    pageOffset = 0;
  } else if (opts.bringIntoView && !isVisible) {
    // manual: keep order fixed; just page the chosen chat into view
    const maxOffset = Math.max(0, tabs.length - columns);
    if (idx < pageOffset) pageOffset = idx;
    else pageOffset = Math.min(maxOffset, idx - columns + 1);
  }

  if (opts.focusView) { try { tab.view.webContents.focus(); } catch (_e) {} }
  relayout(); persist();
}

// Manual reorder: move a tab to an absolute index. Order is user-owned and
// persisted, so it survives refreshes and restarts.
function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  toIndex = Math.max(0, Math.min(tabs.length - 1, toIndex | 0));
  if (toIndex === from) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(toIndex, 0, tab);
  const [W] = win.getContentSize();
  const columns = computeColumns(W);
  const maxOffset = Math.max(0, tabs.length - columns);
  if (toIndex < pageOffset) pageOffset = toIndex;
  else if (toIndex >= pageOffset + columns) pageOffset = Math.min(maxOffset, toIndex - columns + 1);
  pageOffset = Math.max(0, Math.min(maxOffset, pageOffset));
  relayout(); persist();
}

function moveActive(dir) {
  if (activeId == null) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i !== -1) moveTab(activeId, i + dir);
}

function cleanTitle(t) {
  if (!t) return 'New chat';
  return t.replace(/\s*[-|–]\s*Claude\s*$/i, '').trim().slice(0, 40) || 'New chat';
}

// Active-tile border (2026-09-26, Frank spec): each tile is its own isolated
// page with no way to know whether main.js currently considers it active, so
// this pushes an explicit ccc:setActive down whenever activeId changes.
// Safe to call with a stale/removed id (e.g. a tab that just closed) — the
// find() just misses and nothing is sent.
function soloTab() {
  if (soloId == null) return null;
  const t = tabs.find((x) => x.id === soloId);
  if (!t) soloId = null;
  return t || null;
}
function toggleSolo(id) {
  if (id == null) return;
  soloId = (soloId === id) ? null : id;
  if (soloId != null) activate(soloId, {});
  relayout();
}
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }
function pushStatusSummary() {
  if (!bottombar) return;
  const counts = {};
  for (const t of tabs) { const s = t.status || 'idle'; counts[s] = (counts[s] || 0) + 1; }
  try { bottombar.webContents.send('tileStatus', { counts, total: tabs.length }); } catch (_e) {}
}

function pushActive(id, isActive) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) { try { tab.view.webContents.send('ccc:setActive', isActive); } catch (_e) {} }
}

// ---------------------------------------------------------------------------
// Injected bootstrap: hand the automations script its per-tab config.
// ---------------------------------------------------------------------------
function bootstrapFor(tab) {
  const cfg = JSON.stringify({
    tabId: tab.id,
    autoContinue: CFG.AUTOCONTINUE_ENABLED,
    autoContinueMax: CFG.AUTOCONTINUE_MAX_CHAIN,
    resume: CFG.RESUME_ENABLED,
    resumeJitterMin: CFG.RESUME_JITTER_MIN_SEC,
    resumeJitterMax: CFG.RESUME_JITTER_MAX_SEC,
    resumePoll: CFG.RESUME_POLL_SEC,
    usageDebug: CFG.USAGE_CAPTURE_DEBUG,
    color: tab.color || null
  });
  return `(function(){ window.__CCC_CFG__ = ${cfg}; })();\n${AUTOMATIONS_JS}\n${SKIM_CORE_JS}\n${SKIM_INJECT_JS}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function snapshot() {
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: (!t.view.webContents.isDestroyed() && t.view.webContents.getURL()) || t.url,
      title: t.title,
      lastActive: t.lastActive,
      sidebarExpanded: t.sidebarExpanded,
      color: t.color || null,
      widthFrac: (typeof t.widthFrac === 'number') ? t.widthFrac : null
    })),
    pageOffset,
    zoomFactor
  };
}
function persist() {
  store.saveDebounced(snapshot, CFG.STATE_DEBOUNCE_MS);
  if (cccSync) { try { cccSync.onLocalChange(); } catch (_e) { /* sync must never break the UI */ } }
}

// wq#2036 helpers (only used when cccSync is enabled)
function tabUrl(t) { return (!t.view.webContents.isDestroyed() && t.view.webContents.getURL()) || t.url; }
function tabByConv(convId) { return tabs.find((t) => cccOps.convIdFromUrl(tabUrl(t)) === convId); }
function startCccSync() {
  try {
    cccSync = cccSyncMod.maybeStart(app.getPath('userData'), {
      getTabs: () => tabs.map((t) => ({ url: tabUrl(t), title: t.title, lastActive: t.lastActive })),
      openChat: ({ url, title }) => createTab(url, { title }, { background: true }),
      closeChat: (convId) => { const t = tabByConv(convId); if (t) closeTab(t.id); },
      isProtected: (convId) => { const t = tabByConv(convId); return !!t && t.id === activeId; },
      log: DBG,
    });
    if (cccSync) DBG('ccc-sync enabled, log', cccSync.oplogFile);
  } catch (e) {
    cccSync = null;
    console.error('[ccc] ccc-sync failed to start, continuing without it:', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// IPC from our chrome (topbar/bottombar) and from claude views (via preload)
// ---------------------------------------------------------------------------
function wireIpc() {
  ipcMain.on('ccc:newTab', () => createTab(CFG.START_URL));
  ipcMain.on('ccc:closeTab', (_e, id) => closeTab(id));
  ipcMain.on('ccc:focusTab', (_e, id) => activate(id, { bringIntoView: true, focusView: true }));
  ipcMain.on('ccc:moveTab', (_e, p) => { if (p) moveTab(p.id, p.toIndex); });
  ipcMain.on('ccc:page', (_e, dir) => {
    const [W] = win.getContentSize();
    const columns = computeColumns(W);
    const maxOffset = Math.max(0, tabs.length - columns);
    pageOffset = Math.max(0, Math.min(maxOffset, pageOffset + dir));
    relayout();
  });
  ipcMain.on('ccc:toggleSidebar', (_e, id) => {
    const tab = tabs.find((t) => t.id === (id || activeId));
    if (!tab) return;
    tab.sidebarExpanded = !tab.sidebarExpanded;
    tab.view.webContents.send('ccc:setSidebar', tab.sidebarExpanded);
    persist();
  });

  // Per-tile ID color, set from the in-header color pad (replaces the native
  // Share button — 2026-09-25, Frank spec). Sender is the tile's own
  // webContents, so we match on that rather than trusting a passed id.
  ipcMain.on('ccc:setColor', (e, payload) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (!tab) return;
    const c = payload && payload.color;
    tab.color = VALID_COLORS.includes(c) ? c : null;
    persist();
    const [W] = win.getContentSize();
    const columns = computeColumns(W);
    pushTabStrip(columns, Math.max(0, tabs.length - columns));
  });

  // Manual tile-width resize (2026-09-25, redesigned 2026-09-26): horizontal-
  // only drag of the seam between two tiles. Captures the two TABS at this
  // gap's position by reference, so the resulting width follows those tabs
  // through any later reorder/page — not the gap's position on screen.
  ipcMain.on('ccc:resizeStart', (e, payload) => {
    const idx = handles.findIndex((h) => h.view.webContents.id === e.sender.id);
    if (idx === -1) return;
    const [W, H] = win.getContentSize();
    const top = topbarH, bot = CFG.BOTTOMBAR_HEIGHT;
    const midH = Math.max(0, H - top - bot);
    const columns = computeColumns(W);
    const gap = CFG.TILE_GAP || 0;
    const avail = Math.max(0, W - gap * (columns - 1));
    const visible = tabs.slice(pageOffset, pageOffset + columns);
    const widths = widthsForVisible(visible, avail);
    const tabA = visible[idx], tabB = visible[idx + 1];
    if (!tabA || !tabB) return;
    resizeDrag = {
      handleIndex: idx, tabA, tabB,
      startScreenX: (payload && payload.screenX) || 0,
      wA: widths[idx], wB: widths[idx + 1],
      columns, gap, avail
    };
    // Expand to the full row so pointer events keep landing on it as the
    // cursor travels past its own thin resting strip (Electron routes input
    // to whatever view is under the cursor, not to whoever has "focus").
    handles[idx].view.setBounds({ x: 0, y: top, width: W, height: midH });
  });
  ipcMain.on('ccc:resizeMove', (e, payload) => {
    if (!resizeDrag) return;
    const idx = handles.findIndex((h) => h.view.webContents.id === e.sender.id);
    if (idx !== resizeDrag.handleIndex) return;
    applyDrag((payload && payload.screenX) || 0);
  });
  ipcMain.on('ccc:resizeEnd', (e, payload) => {
    if (!resizeDrag) return;
    const idx = handles.findIndex((h) => h.view.webContents.id === e.sender.id);
    if (idx !== resizeDrag.handleIndex) return;
    applyDrag((payload && payload.screenX) || 0);
    resizeDrag = null;
    persist();
    relayout(); // snaps the now-free handle back to its resting strip
  });

  // usage from a claude view -> forward to the bottom bar (active tab only)
  ipcMain.on('ccc:usage', (e, payload) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (!tab) return;
    if (payload && payload.title) { tab.title = cleanTitle(payload.title); }
    if (tab.id === activeId && bottombar) {
      bottombar.webContents.send('usage', payload);
    }
  });

  // usage-candidate: raw response that *looks* usage-related. In debug we append
  // it to a log so we can bind the bottom bar to real field names, then flip
  // USAGE_CAPTURE_DEBUG off. This is the one piece that needs live traffic.
  ipcMain.on('ccc:usageCandidate', (_e, payload) => {
    if (!CFG.USAGE_CAPTURE_DEBUG) return;
    try {
      const f = path.join(app.getPath('userData'), 'usage-candidates.log');
      fs.appendFileSync(f, JSON.stringify({ t: Date.now(), ...payload }) + '\n');
      DBG('usage candidate logged:', payload.url);
    } catch (_e) {}
  });

  const _seenUrls = new Set();
  ipcMain.on('ccc:urlSeen', (_e, payload) => {
    if (!CFG.USAGE_CAPTURE_DEBUG || !payload || !payload.url) return;
    const u = payload.url.split('?')[0];
    if (_seenUrls.has(u)) return;
    _seenUrls.add(u);
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'urls.log'), u + '\n'); } catch (_e) {}
  });

  // limit hit / resumed -> surface on the bottom bar
  ipcMain.on('ccc:limit', (e, payload) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (bottombar) bottombar.webContents.send('limit', { ...payload, tab: tab && tab.title });
  });
  ipcMain.on('ccc:resumed', () => {
    if (bottombar) bottombar.webContents.send('resumed', {});
  });

  // ---- orchestration (2026-10-23, wq#4561) -------------------------------
  // per-tile status from the page heartbeat -> chip dot + bottom-bar tally
  ipcMain.on('ccc:status', (e, p) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (!tab || !p || !p.state) return;
    tab.status = p.state; tab.statusSince = p.at || Date.now();
    const [W] = win.getContentSize();
    const columns = soloTab() ? 1 : computeColumns(W);
    pushTabStrip(columns, Math.max(0, tabs.length - columns));
    pushStatusSummary();
  });
  // last assistant reply, after every completion -> kept on the tab + jsonl
  ipcMain.on('ccc:captured', (e, p) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (!tab || !p || !p.text) return;
    tab.lastOutput = p.text; tab.lastOutputAt = p.at || Date.now();
    if (CFG.CAPTURE_ENABLED !== false) {
      try {
        const dir = path.join(app.getPath('userData'), 'captures');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `tab-${tab.id}.jsonl`),
          JSON.stringify({ t: p.at || Date.now(), title: tab.title, url: p.url || '', chars: p.chars, text: p.text }) + '\n');
      } catch (_e) {}
    }
    if (bottombar) bottombar.webContents.send('tileStatus', { note: `\u201c${tab.title}\u201d done \u00b7 ${fmtK(p.chars)} chars` });
  });
  ipcMain.on('ccc:injected', (e, p) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (!tab || !p) return;
    DBG('injected', tab.id, p);
    if (p.ok === false && bottombar) {
      bottombar.webContents.send('tileStatus', { note: `\u201c${tab.title}\u201d: not sent (${p.reason || 'composer'})` });
    }
  });
  // one prompt -> N tiles, staggered; busy (working/limited) tiles are skipped
  ipcMain.on('ccc:broadcast', (_e, p) => {
    if (!p || !p.text || !Array.isArray(p.ids)) return;
    const targets = p.ids.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
    const stagger = CFG.BROADCAST_STAGGER_MS || 2000;
    let i = 0; const sent = [], skipped = [];
    targets.forEach((tab) => {
      const st = tab.status || 'idle';
      if (st === 'working' || st === 'limited') { skipped.push(tab.title); return; }
      const delay = (i++) * stagger;
      setTimeout(() => {
        if (!tabs.includes(tab) || tab.view.webContents.isDestroyed()) return;
        try { tab.view.webContents.send('ccc:inject', { text: p.text, send: p.send !== false, force: !!p.force, reqId: 'b' + Date.now() }); } catch (_e) {}
      }, delay);
      sent.push(tab.title);
    });
    if (bottombar) bottombar.webContents.send('tileStatus', {
      note: `broadcast \u2192 ${sent.length} tile(s)` + (skipped.length ? ` \u00b7 skipped ${skipped.length} busy` : '')
    });
  });
  ipcMain.on('ccc:toggleSolo', (_e, id) => toggleSolo(id == null ? activeId : id));
  ipcMain.on('ccc:copyLast', (_e, id) => {
    const tab = tabs.find((t) => t.id === (id == null ? activeId : id));
    if (!tab) return;
    if (tab.lastOutput) { try { clipboard.writeText(tab.lastOutput); } catch (_e) {} }
    else { try { tab.view.webContents.send('ccc:capture'); } catch (_e) {} }   // ask the page, next copy will have it
    if (bottombar) bottombar.webContents.send('tileStatus', { note: tab.lastOutput ? `copied \u201c${tab.title}\u201d (${fmtK(tab.lastOutput.length)} chars)` : 'nothing captured yet for that tile' });
  });
  ipcMain.on('ccc:topbarHeight', (_e, h) => {
    const want = (typeof h === 'number' && h > CFG.TOPBAR_HEIGHT) ? Math.min(h, 400) : CFG.TOPBAR_HEIGHT;
    if (want === topbarH) return;
    topbarH = want; relayout();
  });

  // completion signal -> optional ntfy ping
  ipcMain.on('ccc:completed', (e) => {
    const tab = tabs.find((t) => t.view.webContents.id === e.sender.id);
    if (tab && tab.id !== activeId && CFG.NTFY_TOPIC_URL) {
      try {
        const { net } = require('electron');
        const req = net.request({ method: 'POST', url: CFG.NTFY_TOPIC_URL });
        req.setHeader('Title', 'Claude Command Center');
        req.end(`"${tab.title}" finished`);
      } catch (_e) {}
    }
  });
}

// ---------------------------------------------------------------------------
// DeepSeek spend telemetry — poll Lumen's messenger /spend (tailnet-direct,
// telemetry-allowlisted 2026-07-11) from the MAIN process (net = no CORS) and
// push to the bottom bar. Server refreshes its history via a 15-min systemd
// timer; we poll on a 5-min cadence so the bar is never >20 min stale.
// ---------------------------------------------------------------------------
let dsTimer = null;

function fetchSpendJSON(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const { net } = require('electron');
      const req = net.request({ url });
      let body = '';
      req.on('response', (res) => {
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { finish(res.statusCode < 400 ? JSON.parse(body) : null); }
          catch (_e) { finish(null); }
        });
      });
      req.on('error', () => finish(null));
      setTimeout(() => finish(null), 8000);
      req.end();
    } catch (_e) { finish(null); }
  });
}

async function pollDeepseek() {
  if (!CFG.SPEND_URL) return;
  const s = await fetchSpendJSON(CFG.SPEND_URL);
  if (!s || s.error) {
    if (bottombar) bottombar.webContents.send('deepseek', { ok: false });
    return;
  }
  const h = s.history || {};
  const fmt = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));
  let last = null;
  if (h.most_recent && h.most_recent.amount != null) {
    const ago = Math.max(0, Math.round((Date.now() / 1000 - h.most_recent.ts) / 60));
    last = '$' + Number(h.most_recent.amount).toFixed(4) + ' · ' + ago + 'm ago';
  }
  const bal = (h.balance != null ? h.balance : s.balance);
  if (bottombar) bottombar.webContents.send('deepseek', {
    ok: true,
    balance: bal != null ? '$' + Number(bal).toFixed(2) : '—',
    today: fmt(h.today != null ? h.today : s.spent_today),
    hour: fmt(h.last_hour),
    month: fmt(h.this_month),
    year: fmt(h.this_year),
    last
  });
}

function startDeepseekTelemetry() {
  pollDeepseek();
  dsTimer = setInterval(pollDeepseek, CFG.SPEND_POLL_MS || 300000);
}

// System telemetry (Thor host) — CPU%, package temp, mem, disk. Sampled in the
// MAIN process (runs on the box) and pushed to the bottom bar, mirroring the
// DeepSeek poller. Thor's fan is suspected-dead (light-duty only), so package
// temp is the headline number: it flags thermal-throttle risk live. Pure Node,
// no deps. (2026-07-13)
// ---------------------------------------------------------------------------
let ssTimer = null;
let ssPrevCpu = null;   // { total, idle } from previous /proc/stat sample

function ssCpuPct() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (p[3] || 0) + (p[4] || 0);
    const total = p.reduce((a, b) => a + (b || 0), 0);
    let pct = null;
    if (ssPrevCpu) {
      const dt = total - ssPrevCpu.total, di = idle - ssPrevCpu.idle;
      if (dt > 0) pct = Math.round((1 - di / dt) * 100);
    }
    ssPrevCpu = { total, idle };
    return pct;
  } catch (_e) { return null; }
}

function ssMemPct() {
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) : null; };
    const total = get('MemTotal'), avail = get('MemAvailable');
    if (!total || avail == null) return null;
    return Math.round((1 - avail / total) * 100);
  } catch (_e) { return null; }
}

function ssDiskPct() {
  try {
    const s = fs.statfsSync('/');
    const used = s.blocks - s.bfree, denom = (s.blocks - s.bfree) + s.bavail;
    if (denom <= 0) return null;
    return Math.round((used / denom) * 100);
  } catch (_e) { return null; }
}

function ssCpuTemp() {
  // Prefer Intel package thermal zone; fall back to coretemp/k10temp/acpitz hwmon.
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      try {
        if (fs.readFileSync('/sys/class/thermal/' + z + '/type', 'utf8').trim() === 'x86_pkg_temp') {
          const t = Number(fs.readFileSync('/sys/class/thermal/' + z + '/temp', 'utf8').trim());
          if (t > 0) return Math.round(t / 1000);
        }
      } catch (_e) { /* skip zone */ }
    }
  } catch (_e) { /* fall through */ }
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      try {
        const name = fs.readFileSync('/sys/class/hwmon/' + h + '/name', 'utf8').trim();
        if (name === 'coretemp' || name === 'k10temp' || name === 'acpitz') {
          const t = Number(fs.readFileSync('/sys/class/hwmon/' + h + '/temp1_input', 'utf8').trim());
          if (t > 0) return Math.round(t / 1000);
        }
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* give up */ }
  return null;
}

function pollSysStats() {
  if (!bottombar) return;
  bottombar.webContents.send('sysstats', {
    cpu: ssCpuPct(), temp: ssCpuTemp(), mem: ssMemPct(), disk: ssDiskPct()
  });
}

function startSysStatsTelemetry() {
  ssCpuPct();                       // prime CPU delta baseline
  setTimeout(pollSysStats, 1000);   // first real sample after baseline
  ssTimer = setInterval(pollSysStats, CFG.SYSSTATS_POLL_MS || 3000);
}

// Fleet telemetry (2026-10-23, wq#4561): Lumen messenger /nodes (online,
// latency, cpu, ram per fleet node) + /aq (open alert count). Same server and
// transport as the DeepSeek poller; tailnet-direct, no CORS, no auth.
let fleetTimer = null;
async function pollFleet() {
  if (!CFG.NODES_URL) return;
  const n = await fetchSpendJSON(CFG.NODES_URL);
  const a = CFG.AQ_URL ? await fetchSpendJSON(CFG.AQ_URL) : null;
  if (!bottombar) return;
  const nodes = (n && Array.isArray(n.nodes))
    ? n.nodes.map((x) => ({ id: x.id, name: x.name, online: !!x.online, latency: x.latency, cpu: x.cpu_percent, ram: x.ram_percent }))
    : null;
  bottombar.webContents.send('fleet', { ok: !!nodes, nodes: nodes || [], aqOpen: (a && typeof a.open === 'number') ? a.open : null });
}
function startFleetTelemetry() {
  pollFleet();
  fleetTimer = setInterval(pollFleet, CFG.NODES_POLL_MS || 60000);
}

// ---------------------------------------------------------------------------
// Chrome views (our own top/bottom bars)
// ---------------------------------------------------------------------------
function makeChromeView(file) {
  const v = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  v.setBackgroundColor('#090a0f'); // 2026-09-26: matches the dark-theme canvas bg (design brief)
  v.webContents.loadFile(path.join(__dirname, 'renderer', file));
  return v;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  nativeTheme.themeSource = 'dark';
  claudeSession = session.fromPartition('persist:claude');
  hardenSession(claudeSession);
  // Warm DNS/TLS to claude.ai before the first tile loads, so the initial
  // handshake isn't on the critical path of the cold boot. (2026-07-13)
  try { claudeSession.preconnect({ url: CFG.ORIGIN, numSockets: 4 }); } catch (_e) {}
  try { claudeSession.setSpellCheckerLanguages(['en-US']); } catch (_e) {}

  win = new BaseWindow({
    width: 1600, height: 900,
    backgroundColor: '#090a0f', // 2026-09-26: matches the dark-theme canvas bg (design brief); shows in the TILE_GAP between tiles
    // Per-tile "Claude is AI..." strips are hidden by inject CSS; the notice
    // lives here in the window title instead (2026-08-06).
    title: 'Claude Command Center — Claude is AI and can make mistakes. Please double-check responses.'
  });
  Menu.setApplicationMenu(null);

  topbar = makeChromeView('topbar.html');
  bottombar = makeChromeView('bottombar.html');
  win.contentView.addChildView(topbar);
  win.contentView.addChildView(bottombar);

  wireIpc();

  // restore or open one fresh tab
  const saved = store.load();
  // Zoom, set BEFORE any createTab() call below so restored tiles pick it up
  // immediately instead of flashing default, then snapping. Per-tab width
  // (widthFrac) is restored per-tab inside createTab() itself now (2026-09-26
  // redesign) — it lives on each tab, not a separate global array, so it
  // survives reorders and paging without drifting to the wrong chat.
  zoomFactor = (saved && typeof saved.zoomFactor === 'number') ? saved.zoomFactor : CFG.ZOOM_DEFAULT;
  if (saved && saved.tabs.length) {
    restoring = true;   // hold MRU reordering until tiles settle, else load-time
                        // focus events scramble the restored order on reopen
    // restore in stored order; unshift reverses, so add oldest first
    saved.tabs.slice().reverse().forEach((m) => createTab(m.url, m, { deferLoad: true }));
    pageOffset = saved.pageOffset || 0;
    activeId = tabs[0] ? tabs[0].id : null;
    relayout();
    tabs.forEach((t) => enqueueLoad(t));   // visible (front) tiles load first
  } else {
    createTab(CFG.START_URL);
  }

  startCccSync();
  win.on('focus', () => { if (cccSync) { try { cccSync.reconcile(false); } catch (_e) { /* next poll */ } } });

  win.on('resize', relayout);
  win.on('maximize', relayoutDeferred);
  win.on('unmaximize', relayoutDeferred);
  win.on('enter-full-screen', relayoutDeferred);
  win.on('leave-full-screen', relayoutDeferred);
  // Flush synchronously on close/quit: the debounced persist() never fires
  // here because app.quit() kills the process before the timer (zombie-tab
  // bug, fixed 2026-08-06). before-quit also covers SIGTERM.
  win.on('close', () => { store.saveNow(snapshot); });
  relayout();

  registerShortcuts();
  startDeepseekTelemetry();
  startSysStatsTelemetry();
  startFleetTelemetry();
}

// App shortcuts, scoped to CCC's own webContents via before-input-event.
// Previously these were globalShortcut registrations, which intercept keys
// SYSTEM-WIDE while CCC runs — Ctrl+W in the browser closed a CCC tile
// instead of the browser tab (fixed 2026-08-06). registerShortcuts() now
// only attaches to the chrome bars; tiles attach in createTab.
function handleAppKeys(e, input) {
  if (input.type !== 'keyDown') return false;
  const mod = input.control || input.meta;
  if (!mod || input.alt) return false;
  const k = (input.key || '').toLowerCase();

  // Global chat-tile zoom (2026-09-25): Ctrl+=/Ctrl+-/Ctrl+0, every tile at
  // once, never the CCC chrome. Checked before the shift branch below since
  // producing '+' needs Shift on most keyboards but the shortcut shouldn't
  // care either way (numpad +/- report the same input.key regardless).
  if (k === '=' || k === '+') { e.preventDefault(); setZoom(zoomFactor + CFG.ZOOM_STEP); return true; }
  if (k === '-' || k === '_') { e.preventDefault(); setZoom(zoomFactor - CFG.ZOOM_STEP); return true; }
  if (k === '0') { e.preventDefault(); setZoom(CFG.ZOOM_DEFAULT); return true; }

  if (!input.shift) {
    if (k === 't') { e.preventDefault(); createTab(CFG.START_URL); return true; }
    if (k === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); return true; }
    if (k === 'arrowright') { e.preventDefault(); sendPage(+1); return true; }
    if (k === 'arrowleft') { e.preventDefault(); sendPage(-1); return true; }
    if (k >= '1' && k <= '9') {
      const tab = tabs[Number(k) - 1];
      if (tab) { e.preventDefault(); activate(tab.id, { bringIntoView: true, focusView: true }); }
      return true;
    }
  } else {
    // move the active chat left / right in the manual order
    if (k === 'pageup') { e.preventDefault(); moveActive(-1); return true; }
    if (k === 'f') { e.preventDefault(); toggleSolo(activeId); return true; }   // solo the active tile (wq#4561)
    if (k === 'pagedown') { e.preventDefault(); moveActive(+1); return true; }
  }
  return false;
}
function attachAppKeys(wc) {
  wc.on('before-input-event', (e, input) => { handleAppKeys(e, input); });
}
function registerShortcuts() {
  attachAppKeys(topbar.webContents);
  attachAppKeys(bottombar.webContents);
}
function sendPage(dir) {
  const [W] = win.getContentSize();
  const columns = computeColumns(W);
  const maxOffset = Math.max(0, tabs.length - columns);
  pageOffset = Math.max(0, Math.min(maxOffset, pageOffset + dir));
  relayout();
}

// Global chat-tile zoom (2026-09-25): applies to every tile's webContents at
// once — never the topbar/bottombar chrome, never one tile independently.
// Rounded to 2dp so repeated +/- 0.1 steps don't accumulate float grime.
function setZoom(factor) {
  factor = Math.max(CFG.ZOOM_MIN, Math.min(CFG.ZOOM_MAX, factor));
  zoomFactor = Math.round(factor * 100) / 100;
  tabs.forEach((t) => { try { t.view.webContents.setZoomFactor(zoomFactor); } catch (_e) {} });
  persist();
}

app.whenReady().then(boot);
app.on('before-quit', () => { store.saveNow(snapshot); });  // covers SIGTERM / non-window quit paths
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (dsTimer) clearInterval(dsTimer); if (fleetTimer) clearInterval(fleetTimer); });
app.on('window-all-closed', () => app.quit());
