// =============================================================================
// background.js — service worker (Chrome) / event page (Firefox).
//
// Three jobs:
//
//   1. OWN THE WEEKLY REFRESH. When a refresh is due (Watch mode + enabled),
//      ensureFreshVideos() fetches youtube.com directly, parses the embedded
//      ytInitialData JSON, filters/picks the grid, and saves it to
//      chrome.storage. No tab navigation, no DOM scraping. Triggered by a
//      5-minute alarm, install/startup, local storage changes, and a
//      fire-and-forget "better-feed-ensure-fresh" nudge from content. A
//      single-flight lock (in-memory promise + persisted refresh status)
//      prevents double-fetching. The save fires storage.onChanged, which is
//      how content.js learns to render the new grid.
//
//   2. Keep the declarativeNetRequest redirect rule in sync. The rule rewrites
//      every visit to youtube.com/ to a marker URL
//      (youtube.com/feed/library#better-feed-*), which content.js dresses up as
//      the weekly home. It is installed for Watch + enabled and DECOUPLED from
//      refresh-due (the refresh happens in place, so no native-home flash).
//
//   3. Lifecycle plumbing — first-install welcome tab, startup mode reset,
//      cross-device sync hydration.
//
// All state is read from chrome.storage via the helpers in shared.js — the
// worker holds no state of its own across wake-ups except the in-flight lock.
// =============================================================================

// Chrome MV3 runs background.js as a service worker, where importScripts is
// available and we use it to load shared.js. Firefox MV3 runs background.js
// as an event-page script (see manifest.background.scripts), where shared.js
// is already loaded before this file by the manifest's script list and
// importScripts is not defined. Guard the call so the same file works in
// both contexts.
if (typeof importScripts === "function") {
  importScripts("shared.js");
}

const REDIRECT_RULE_ID = 1;

async function readRefreshState() {
  const data = await chrome.storage.local.get([
    STORAGE_REFRESH_AFTER_KEY,
    STORAGE_VIDEOS_KEY
  ]);
  return {
    refreshAfter: data[STORAGE_REFRESH_AFTER_KEY],
    hasVideos:
      Array.isArray(data[STORAGE_VIDEOS_KEY]) &&
      data[STORAGE_VIDEOS_KEY].length > 0
  };
}

function isRefreshDue(refreshState) {
  if (!refreshState.hasVideos) return true;
  if (typeof refreshState.refreshAfter !== "number") return true;
  return getNow() >= refreshState.refreshAfter;
}

// The redirect rule is installed whenever the extension is enabled. In Watch
// mode it additionally requires weekly home + home-redirect to be enabled;
// Work/Listen/no-mode redirect to their own marker URL on `enabled` alone. It
// is intentionally DECOUPLED from refresh-due state: the background refreshes
// the grid in place (no navigation), so youtube.com should always land on the
// marker URL and let content.js render the (possibly stale, soon-refreshed)
// grid — never flash the native home just because a refresh is due.
async function updateRedirectRule() {
  // Whole body guarded: getSettings()/getCurrentMode() read chrome.storage and
  // can reject transiently; this runs fire-and-forget from onChanged/alarms, so
  // an unguarded reject would surface as an unhandled rejection.
  try {
    await loadFakeNowOffset();
    const settings = await getSettings();
    const mode = await getCurrentMode();

    let shouldRedirect = settings.enabled;
    if (shouldRedirect && mode === MODE_WATCH) {
      shouldRedirect = settings.weeklyHomeEnabled && settings.redirectHomeEnabled;
    }

    const addRules = shouldRedirect
      ? [
          {
            id: REDIRECT_RULE_ID,
            priority: 1,
            action: {
              type: "redirect",
              redirect: { url: markerUrlForMode(mode) }
            },
            condition: {
              // https? so a typed/bookmarked http://youtube.com (rare; YouTube
              // is HSTS-preloaded) is still redirected, matching the manifest's
              // *://www.youtube.com/* host scope.
              regexFilter: "^https?://www\\.youtube\\.com/?(\\?.*)?$",
              resourceTypes: ["main_frame"]
            }
          }
        ]
      : [];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REDIRECT_RULE_ID],
      addRules
    });
  } catch (error) {
    console.error("Failed to update redirect rule:", error);
  }
}

chrome.runtime.onInstalled.addListener(async details => {
  // Only wipe mode on a true first install. Extension updates / chrome
  // updates / reload-from-disk should preserve the existing mode so the
  // user isn't kicked to the mode picker every time something refreshes.
  if (details.reason === "install") {
    await clearCurrentMode();
  }
  await migrateLegacyStorageKeys();
  // hydrateFromSync MUST finish before ensureFreshVideos so the due-check
  // reads the hydrated refreshAfter (and doesn't refetch a grid that synced in).
  await hydrateFromSync();
  await updateRedirectRule();
  await ensureRefreshAlarm();
  ensureFreshVideos("install").catch(() => {});
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearCurrentMode();
  await migrateLegacyStorageKeys();
  await hydrateFromSync();
  await updateRedirectRule();
  await ensureRefreshAlarm();
  ensureFreshVideos("startup").catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    queueSyncChange(changes);
    return;
  }
  if (area !== "local") return;
  applyFakeNowOffsetChange(changes);
  // Rule recompute: only mode / enabled / fake-time affect the rule now (it's
  // decoupled from refresh-due), so VIDEOS / REFRESH_AFTER no longer recompute it.
  if (
    SETTINGS_KEY in changes ||
    STORAGE_MODE_KEY in changes ||
    STORAGE_FAKE_NOW_OFFSET_KEY in changes
  ) {
    updateRedirectRule();
  }
  // Refresh check: anything that could flip "refresh due" (or re-enable Watch).
  // NEVER trigger off STORAGE_REFRESH_STATUS_KEY — that's the refresh's own
  // output and would loop.
  if (
    SETTINGS_KEY in changes ||
    STORAGE_REFRESH_AFTER_KEY in changes ||
    STORAGE_VIDEOS_KEY in changes ||
    STORAGE_MODE_KEY in changes ||
    STORAGE_FAKE_NOW_OFFSET_KEY in changes
  ) {
    ensureFreshVideos("storage").catch(() => {});
  }
});

// Idempotent alarm setup. Previously this was a top-level
// chrome.alarms.create which re-fires on every service-worker wake — each
// wake replaced the alarm and reset the 5-minute countdown, so during
// active sessions the alarm could rarely fire and the "stale refresh-due"
// safety net was effectively disabled. Now: check first, only create when
// missing. Also still guard from a top-level call so SW wakes that
// somehow lost the alarm get it back without waiting for the next
// browser restart.
async function ensureRefreshAlarm() {
  try {
    const existing = await chrome.alarms.get("better-feed-refresh-check");
    if (existing) return;
    await chrome.alarms.create("better-feed-refresh-check", {
      periodInMinutes: 5
    });
  } catch (_) {}
}
ensureRefreshAlarm();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "better-feed-refresh-check") {
    updateRedirectRule();
    ensureFreshVideos("alarm").catch(() => {});
  }
});

async function clearModeIfNoYouTubeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
    if (tabs.length !== 0) return;
    // Double-check after a short delay. Firefox can momentarily report zero
    // youtube.com tabs mid-navigation (e.g. during a close-and-reopen), and
    // clearing the mode on a transient zero wipes an active session and
    // re-shows the mode picker. Requiring two consecutive zero reads ~250ms
    // apart filters those transients out.
    await new Promise(r => setTimeout(r, 250));
    const recheck = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
    if (recheck.length === 0) {
      await clearCurrentMode();
    }
  } catch (_) {
    // Tab queries are best-effort; transient errors during navigation
    // shouldn't block the extension.
  }
}

chrome.tabs.onRemoved.addListener(() => {
  clearModeIfNoYouTubeTabs();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (!changeInfo.url) return;
  // If the tab is navigating to another YouTube URL, it's clearly not
  // leaving YouTube — skip the cleanup check. Firefox can briefly return
  // zero matches from chrome.tabs.query mid-navigation, which would
  // otherwise wipe the active mode incorrectly and bring the mode picker
  // back on the return trip.
  if (/^https?:\/\/(www\.)?youtube\.com(\/|$)/i.test(changeInfo.url)) return;
  clearModeIfNoYouTubeTabs();
});

// Promise-return listener pattern. In Firefox, returning a Promise from the
// listener is the canonical async response — more reliable than the
// `return true; sendResponse(...)` callback pattern, which loses the response
// if the event page suspends after the listener returns. Chromium supports it
// too. The content script's only message is a fire-and-forget nudge to refresh
// now (used when the event page was asleep at cold start); it is idempotent via
// the in-flight lock + due-check inside ensureFreshVideos.
chrome.runtime.onMessage.addListener((msg, _sender) => {
  if (msg && msg.type === "better-feed-ensure-fresh") {
    return ensureFreshVideos("message")
      .then(() => ({ ok: true }))
      .catch(err => ({ ok: false, error: String(err?.message || err) }));
  }
});

// ---- The refresh (background-owned, single path) ----
// fetch youtube.com -> parse ytInitialData -> filter/pick -> save.
// (No tab navigation, no DOM scrape — a pure background fetch + save.)
// Guarded by an in-memory single-flight promise AND the persisted
// STORAGE_REFRESH_STATUS_KEY (so a second wake or a second tab doesn't
// double-fetch). On failure, refreshAfter is NOT advanced, so the next alarm
// retries.
let refreshInFlight = null;

// Single source of truth for the refresh-status schema (read by content's
// renderFromStorage to choose grid / loader / retry).
function setRefreshStatus(state, extra = {}) {
  return chrome.storage.local.set({
    [STORAGE_REFRESH_STATUS_KEY]: { state, ...extra }
  });
}

async function ensureFreshVideos(reason) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = runRefresh(reason).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function runRefresh(reason) {
  // Don't refresh until the user has completed onboarding. getSettings()
  // returns full defaults (enabled=true) even when nothing is stored, so we
  // can't use it to detect a fresh/cleared profile — check the raw key. While
  // SETTINGS_KEY is absent the content script is showing (or about to show)
  // the cold-start setup prompt; saving a grid now would make detectColdStart
  // return false and skip that prompt entirely. Once the user picks defaults /
  // custom (or sync hydrates settings), SETTINGS_KEY exists and refresh runs.
  const rawSettings = await chrome.storage.local.get(SETTINGS_KEY);
  if (!rawSettings[SETTINGS_KEY]) return;

  const settings = await getSettings();
  const mode = await getCurrentMode();

  // Only Watch mode with the extension + weekly home enabled refreshes.
  if (!settings.enabled || !settings.weeklyHomeEnabled) return;
  if (mode !== MODE_WATCH && mode !== null) return;

  const refreshState = await readRefreshState();
  if (!isRefreshDue(refreshState)) return;

  // Cross-wake / cross-tab single-flight via the persisted status.
  const statusData = await chrome.storage.local.get(STORAGE_REFRESH_STATUS_KEY);
  const status = statusData[STORAGE_REFRESH_STATUS_KEY];
  if (
    status &&
    status.state === "refreshing" &&
    typeof status.startedAt === "number" &&
    getNow() - status.startedAt < REFRESH_INFLIGHT_TTL_MS
  ) {
    return;
  }

  // Error backoff: after a failed refresh, don't re-fetch on the very next
  // trigger. An all-live or unparseable home throws below and never advances
  // refreshAfter, so without this it would re-issue a credentialed GET on
  // every alarm/storage-change/reload nudge. The 5-minute alarm still retries
  // once this cooldown elapses (cooldown < alarm period).
  if (
    status &&
    status.state === "error" &&
    typeof status.failedAt === "number" &&
    getNow() - status.failedAt < REFRESH_ERROR_COOLDOWN_MS
  ) {
    return;
  }

  try {
    // Inside the try so a failing status write also lands in the catch's
    // "error" branch — otherwise it could reject to a fire-and-forget caller
    // and leave the status absent / wedged until the 60s TTL.
    await setRefreshStatus("refreshing", { startedAt: getNow(), reason });
    const html = await fetchYouTubeHomeHtml();
    const parsed = extractVideosFromYouTubeHomeHtml(html);
    const hidden = await getHiddenItems();
    let visible = filterHiddenVideos(parsed, hidden);
    if (settings.excludeLiveVideos !== false) {
      // Use the same predicate the renderer uses (content.js videoLooksLive),
      // not just the raw isLive badge flag — otherwise past-live VODs/premieres
      // the badge missed get saved, then silently dropped at render time,
      // shrinking the visible grid below videoCount.
      visible = visible.filter(v => !videoLooksLive(v));
    }
    const target = Math.min(
      settings.videoCount + REFRESH_BACKFILL_BUFFER,
      MAX_WEEKLY_VIDEOS
    );
    const chosen = chooseWeeklyVideos(visible, target, hidden);
    if (chosen.length === 0) throw new Error("0 usable videos parsed");

    // Save advances refreshAfter and ships IDs to sync. The VIDEOS write fires
    // storage.onChanged in every live tab → content re-renders the grid.
    await saveWeeklyVideosToStorage(chosen, getNextRefreshTime(settings));
    await setRefreshStatus("idle");
  } catch (err) {
    // Do NOT advance refreshAfter — the next alarm/onChanged retries.
    await setRefreshStatus("error", { failedAt: getNow(), reason: String(err?.message || err) });
  }
}

async function fetchYouTubeHomeHtml() {
  // Plain credentialed GET. The dNR redirect rule is main_frame-scoped, so it
  // does NOT match this fetch (classified as xmlhttprequest) on Chrome or
  // Firefox — no rule drop/restore needed.
  const res = await fetch("https://www.youtube.com/", {
    credentials: "include",
    redirect: "follow"
  });
  if (!res.ok) throw new Error("fetch status " + res.status);
  return res.text();
}
