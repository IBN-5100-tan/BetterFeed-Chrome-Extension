// =============================================================================
// early.js — runs at document_start, before any YouTube DOM parses.
//
// Its only job is to put the right classes on <html> so that preload.css can
// hide the native home grid / sidebar / app shell before the user ever sees
// them. Anti-flash work only — no logic, no fetches.
//
// preload.css is loaded by the same manifest content_scripts entry and carries
// all the CSS rules. This file just decides which mode classes to apply by
// reading location.hash (marker pages) or localStorage (everywhere else).
// =============================================================================

// early.js runs at document_start. preload.css (loaded at the same time
// via manifest content_scripts) carries all the CSS — this file's job is
// just to set the right classes on documentElement before any DOM parses.

// Marker hash list mirrored from shared.js. Hardcoded because early.js
// runs in its own content_scripts entry and can't import shared.js.
const MARKER_HASHES_EARLY = [
  "#better-feed",
  "#better-feed-watch",
  "#better-feed-work",
  "#better-feed-listen"
];

if (MARKER_HASHES_EARLY.indexOf(location.hash) !== -1) {
  document.documentElement.classList.add("better-feed-marker-mode");
  document.documentElement.classList.add("better-feed-pre-ready");
}

// Determine the active mode synchronously. The URL hash is the primary
// signal on marker pages (set by the dNR redirect rule). For non-marker
// pages (e.g., /watch, /results) the URL has no hash, so fall back to
// localStorage to still apply mode classes before content.js loads.
// Falls back to the legacy localStorage key for one load post-rebrand —
// shared.js's migration runs in content.js after this and clears the old key.
let earlyMode = null;
if (location.hash === "#better-feed-watch") earlyMode = "watch";
else if (location.hash === "#better-feed-work") earlyMode = "work";
else if (location.hash === "#better-feed-listen") earlyMode = "listen";
else {
  try {
    earlyMode =
      localStorage.getItem("betterFeedMode") ||
      localStorage.getItem("ytWeeklyMode");
  } catch {}
}

if (earlyMode === "work") {
  document.documentElement.classList.add("better-feed-work-mode");
} else if (earlyMode === "watch") {
  document.documentElement.classList.add("better-feed-watch-mode");
}
