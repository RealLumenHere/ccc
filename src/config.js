'use strict';

// ---------------------------------------------------------------------------
// Claude Command Center — central config. Everything you'd want to tweak lives
// here so you never have to dig through main.js.
// ---------------------------------------------------------------------------

module.exports = {
  // The site we wrap. Kept as a constant so a future *.claude.ai move is one edit.
  START_URL: 'https://claude.ai/new',
  ORIGIN: 'https://claude.ai',

  // Layout ------------------------------------------------------------------
  TOPBAR_HEIGHT: 28,     // px — tab strip + "+" + slider (was 40; batch-2)
  BOTTOMBAR_HEIGHT: 30,  // px — unified usage bar
  MIN_TILE_WIDTH: 470,   // px — narrowest a chat tile is allowed to get.
                         // columns = floor(windowWidth / MIN_TILE_WIDTH).
                         // ~1920px maximized  -> 4 columns. Half-width -> 2.
                         // 2026-08-11: back to 470/4-col at Frank's call —
                         // 5 tiles fit but each one was too narrow to work in.
                         // Wide per-tile text width is preserved by the
                         // real-estate rules in styles.css sec 9.
                         // (2026-09-25 reconcile: this repo still had the
                         // old 380/5-col value — Thor's live deploy had
                         // already moved to 470 and never synced back.
                         // Manual per-tile resize below is exactly for the
                         // cases 380 used to paper over.)
  MAX_COLUMNS: 6,        // hard ceiling regardless of monitor width
  TILE_GAP: 8,           // px between tiles. Doubles as the resize-handle hit
                         // width (2026-09-25) — was 4px, which repeats the
                         // exact "1px border, impossible to grab" mistake
                         // already fixed once for the OS window border.
  MIN_COLUMN_WIDTH: 260, // px — floor for a MANUALLY resized column (drag).
                         // Independent of MIN_TILE_WIDTH, which only governs
                         // the auto column COUNT.

  // Manual tile-width resize (2026-09-25) --------------------------------
  // Horizontal-only, left-to-right, drag the seam between two tiles wider
  // or narrower. No vertical resize exists or is planned — tiles always
  // span full available height. Widths are stored as FRACTIONS of the
  // available (gap-subtracted) row width, not px, so they carry over
  // sensibly across monitors/resolutions. The fraction array resets to an
  // equal split whenever the column COUNT changes (e.g. switching to a
  // monitor where computeColumns() yields a different number) — dragging
  // again re-customizes it for that layout.

  // Global chat-tile zoom (2026-09-25) -------------------------------------
  // Ctrl+=/Ctrl+-/Ctrl+0, scoped to ALL chat tiles at once (never the CCC
  // chrome bars, never per-tile independent). Handled centrally in
  // handleAppKeys() so it fires the same from any tile's or the chrome's
  // focus. Step is additive, not Chromium's discrete zoom-level table.
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 2.0,
  ZOOM_STEP: 0.1,
  ZOOM_DEFAULT: 1.0,

  // Tab ordering ------------------------------------------------------------
  // 'manual'         : DEFAULT. Order is user-owned — rearrange by dragging a
  //                    tab chip, or Ctrl+Shift+PageUp / PageDown to move the
  //                    active chat. Chats NEVER reorder themselves, so an
  //                    auto-refresh (claude.ai autofocuses its input, firing a
  //                    focus event) can't scramble your layout. Clicking a chip
  //                    pages to it without moving it.
  // 'offscreen-only' : legacy MRU — activating a hidden chat pulls it to front.
  // 'always'         : legacy MRU — any activated chat jumps to front-left.
  // 'off'            : alias of 'manual'.
  REORDER_MODE: 'manual',

  // Cloudflare / anti-bot ---------------------------------------------------
  // The wrapper failure mode is a Turnstile loop when the UA string and the
  // JS/client-hint brand disagree. We present a clean, consistent Chrome/Linux
  // identity. BUMP THIS when Chrome moves a major version.
  CHROME_MAJOR: '140',
  USER_AGENT:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/140.0.0.0 Safari/537.36',

  // Session-resume (native port of the Tampermonkey script) -----------------
  // After a session/weekly limit banner, wait until reset, then add a random
  // human-ish delay before resuming so usage doesn't look mechanically timed.
  RESUME_ENABLED: true,
  RESUME_JITTER_MIN_SEC: 45,
  RESUME_JITTER_MAX_SEC: 210,
  RESUME_POLL_SEC: 30, // how often to re-check whether the limit has lifted

  // Auto-continue -----------------------------------------------------------
  AUTOCONTINUE_ENABLED: true,
  AUTOCONTINUE_MAX_CHAIN: 12, // safety: never auto-continue the same turn forever

  // Usage capture -----------------------------------------------------------
  // 'capture' dumps candidate usage responses to a log so we can bind exact
  // field names to real traffic. Flip to false once wired.
  USAGE_CAPTURE_DEBUG: false,  // bound to /api/organizations/<org>/usage limits[] 2026-07-08

  // Notifications (optional) — you already run ntfy fleet-wide.
  NTFY_TOPIC_URL: '', // e.g. 'https://ntfy.lumennode.uk/ccc' ; empty = disabled

  // DeepSeek spend telemetry ------------------------------------------------
  // Lumen messenger /spend, tailnet-direct (telemetry-allowlisted for tailnet
  // clients 2026-07-11). Server-side history refreshes every 15 min via
  // lumen-deepseek-spend.timer; we poll every 5 min. Empty URL = disabled.
  SPEND_URL: 'http://100.117.66.102:8765/spend',
  SPEND_POLL_MS: 300000,

  // Persistence -------------------------------------------------------------
  STATE_DEBOUNCE_MS: 400,

  // Restore -----------------------------------------------------------------
  // Gap between loading each tile when restoring a saved session, so N tiles
  // don't stampede claude.ai + Cloudflare at once. Visible tiles load first.
  RESTORE_LOAD_STAGGER_MS: 2500
};
