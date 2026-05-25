// =============================================================================
// background.js — service worker.
//
// Three jobs:
//
//   1. Keep the declarativeNetRequest redirect rule in sync with current
//      settings + mode + refresh state. The rule rewrites every visit to
//      youtube.com/ to a marker URL (youtube.com/feed/library#better-feed-*),
//      which is what content.js then dresses up as the weekly home grid.
//      Whenever settings, mode, video grid, or fake-time offset change, the
//      rule is re-evaluated. A 5-minute alarm also re-checks so a stale
//      "refresh due" condition flips to "refresh now" on schedule.
//
//   2. Lifecycle plumbing — first-install welcome tab, startup mode reset,
//      cross-device sync hydration.
//
//   3. Brief pauses to the redirect rule when content.js needs to land on
//      the vanilla youtube.com home to scrape recommendations (the
//      "better-feed-prepare-scrape" message).
//
// All state is read from chrome.storage via the helpers in shared.js — the
// service worker holds no state of its own across wake-ups.
// =============================================================================

importScripts("shared.js");

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

async function updateRedirectRule() {
  await loadFakeNowOffset();
  const settings = await getSettings();
  const refreshState = await readRefreshState();
  const mode = await getCurrentMode();

  let shouldRedirect = settings.enabled;
  if (shouldRedirect && mode === MODE_WATCH) {
    shouldRedirect =
      settings.weeklyHomeEnabled &&
      settings.redirectHomeEnabled &&
      !isRefreshDue(refreshState);
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
            regexFilter: "^https://www\\.youtube\\.com/(\\?.*)?$",
            resourceTypes: ["main_frame"]
          }
        }
      ]
    : [];

  try {
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
  await hydrateFromSync();
  updateRedirectRule();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearCurrentMode();
  await migrateLegacyStorageKeys();
  await hydrateFromSync();
  updateRedirectRule();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    applySyncChangeToLocal(changes);
    return;
  }
  if (area !== "local") return;
  applyFakeNowOffsetChange(changes);
  if (
    SETTINGS_KEY in changes ||
    STORAGE_REFRESH_AFTER_KEY in changes ||
    STORAGE_VIDEOS_KEY in changes ||
    STORAGE_MODE_KEY in changes ||
    STORAGE_FAKE_NOW_OFFSET_KEY in changes
  ) {
    updateRedirectRule();
  }
});

chrome.alarms.create("better-feed-refresh-check", {
  periodInMinutes: 5
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "better-feed-refresh-check") {
    updateRedirectRule();
  }
});

async function clearModeIfNoYouTubeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
    if (tabs.length === 0) {
      await clearCurrentMode();
    }
  } catch (_) {}
}

chrome.tabs.onRemoved.addListener(() => {
  clearModeIfNoYouTubeTabs();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) {
    clearModeIfNoYouTubeTabs();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "better-feed-prepare-scrape") {
    chrome.declarativeNetRequest
      .updateDynamicRules({ removeRuleIds: [REDIRECT_RULE_ID], addRules: [] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
