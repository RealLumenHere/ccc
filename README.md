# Claude Command Center

A tiled, multi-session shell around claude.ai. One window, many logged-in chats,
your own chrome instead of fighting the OS window manager.

## What it does

- **One `BaseWindow`, N `WebContentsView` tiles**, all sharing a single login
  (`persist:claude` partition — sign in once, every tile is you).
- **`+` spawns a chat.** Columns are decided by width: `floor(width / 470px)`.
  Maximized on a ~1080p laptop ≈ 4 tiles. Shrink to half-width → 2 tiles.
- **Slider paging.** More chats than columns? The `‹ n–m/total ›` pager (or
  `Ctrl+←/→`) scrolls the row. 15 chats open, 4 on screen, slide to the rest.
- **MRU auto-priority.** Jump into an off-screen chat and it pulls to the front
  so it lands on screen. Visible tiles don't shuffle under you
  (`REORDER_MODE` in `config.js` — `offscreen-only` default, `always`, or `off`).
- **Resumes on restart.** Open tabs + order are saved continuously and restored.
  Close a chat only when *you* close it.
- **Margins killed, tables tamed.** Injected CSS drops claude.ai's max-width
  gutter and makes wide tables scroll in-box instead of running off-page.
- **Unified bottom bar.** Session / Weekly / Fable usage in one thin strip,
  refreshed on prompt completion — not a widget in every window.
- **Native automations** (no extensions to install):
  - Auto-Continue — clicks the *Continue* button, with a per-turn chain cap.
  - Session-resume — the Tampermonkey behaviour: on a limit banner it waits out
    the reset, then resumes after a random `45–210s` jitter so usage doesn't look
    mechanically timed.
  - Usage capture — feeds the bottom bar.
- **Shortcuts:** `Ctrl+T` new · `Ctrl+W` close active · `Ctrl+1..9` jump to tile ·
  `Ctrl+←/→` page.
- **Optional ntfy ping** when a *background* tile finishes (`NTFY_TOPIC_URL`).

## Run (on the laptop — Thor)

```bash
cd claude-command-center
npm install
npm start
# first launch, sign in once in any tile — the login is shared by all of them
```

Package a distributable later:

```bash
npm run dist        # -> AppImage + .deb in dist/
```

## Two things to finish tuning (both one-liners)

**1. Bump the Chrome UA when it drifts.** The only wrapper gotcha is Cloudflare's
Turnstile looping if the UA and client-hints disagree. `config.js` presents a
clean, *consistent* Chrome/Linux identity. If you ever see a verify-loop, bump
`CHROME_MAJOR` + `USER_AGENT` to your current Chrome and restart. That's the knob.

**2. Bind the usage numbers to real traffic (30 seconds).** I did **not**
hardcode claude.ai's private usage-response shape — guessing field names is how
you ship a bar that reads wrong. Instead:

- The bottom bar already works day-one via the native usage-panel scrape
  (Session / Weekly / Fable %).
- For the exact token/reset numbers, run once with `CCC_DEBUG=1 npm run start:verbose`,
  send a couple of prompts, then look at:
  `~/.config/Claude Command Center/usage-candidates.log`
- Paste me one matching line and I'll wire `emitUsageFromJson()` +
  `paint()` to the real fields, then flip `USAGE_CAPTURE_DEBUG` off.

## Layout / architecture

```
BaseWindow
├── topbar      WebContentsView  (our UI: + , chips, pager, sidebar toggle)
├── bottombar   WebContentsView  (our UI: usage bar)
└── tile ×N     WebContentsView  (claude.ai, shared persist:claude session)
                └── inject: styles.css  +  automations.js (main world)
                    bridged to main by preload-view.js (isolated world)
```

Selectors in `styles.css` / `automations.js` are attribute/text based and fail
soft — a claude.ai markup change no-ops a rule, it never breaks the page.

## Orchestration (2026-10-23)

- **Per-tile status dot** on each chip: green idle · amber pulsing working ·
  cyan pulsing tool-limit pause · orange rate-limited · pink error. Hover the
  chip for the word. Bottom bar tallies them (`Tiles 20 · working 3`).
- **Broadcast prompt**: `Ctrl+click` chips to select, `⇶ broadcast` opens a
  box, `send to selected` injects + sends to each selected tile with a
  `BROADCAST_STAGGER_MS` gap (busy tiles are skipped, never interrupted).
  `stage only` fills the composers without sending. A tile with a human draft
  in its composer is never overwritten. Injection targets claude.ai's
  ProseMirror composer properly (TipTap API → `execCommand('insertText')` →
  synthetic paste), not `textContent`.
- **Output capture**: after every completion the last assistant reply is kept
  on the tab and appended to `userData/captures/tab-<id>.jsonl`. Right-click a
  chip to copy that tile's last reply to the clipboard.
- **Solo a tile**: double-click a chip (or `Ctrl+Shift+F`) to give it the full
  row; again to restore. Nothing reloads.
- **Fleet dots** in the bottom bar: one dot per fleet node from Lumen's
  messenger `/nodes` (green up / pink down), plus the open `aq` count.

## Not wired yet

- Saved layout presets (wants the hibernation governor first — see
  `scratch/research/ccc-improvements.md` on Lumen).
