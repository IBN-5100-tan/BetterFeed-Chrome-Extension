// =============================================================================
// shared.js - storage, settings, and cross-page primitives.
//
// Loaded by every other script in the extension (content script, options page,
// popup, service worker via importScripts). It owns:
//
//   - Storage key constants (chrome.storage.local + chrome.storage.sync layout)
//   - The settings schema, defaults, and sanitizer
//   - Mode state (watch / work / listen) and the marker-URL helpers
//   - Hidden-items, watched-videos, and per-video playback progress writers
//   - The daily watch state (videos + seconds) used by the daily limit
//   - The work-session state machine (timed vs no-time)
//   - hydrateFromSync / applySyncChangeToLocal - the two halves of the
//     local <-> sync reconciler
//   - getNow() and loadFakeNowOffset() - fake-time injection for debug
//
// There are no side effects at module load: nothing writes to storage, attaches
// listeners, or touches the DOM. Each caller decides when to invoke things.
// =============================================================================

const SETTINGS_KEY = "betterFeedSettings";
const STORAGE_HIDDEN_VIDEOS_KEY = "betterFeedHiddenVideos";
const STORAGE_HIDDEN_CHANNELS_KEY = "betterFeedHiddenChannels";
const STORAGE_HIDDEN_METADATA_KEY = "betterFeedHiddenMetadata";
const STORAGE_WATCHED_VIDEOS_KEY = "betterFeedWatchedVideos";
const STORAGE_PROGRESS_KEY = "betterFeedVideoProgress";
const STORAGE_WORK_SESSION_KEY = "betterFeedWorkSession";
const STORAGE_VIDEOS_KEY = "betterFeedVideos";
const STORAGE_REFRESH_AFTER_KEY = "betterFeedRefreshAfter";
const STORAGE_DAILY_STATE_KEY = "betterFeedDailyState";
const STORAGE_DAILY_GRACE_KEY = "betterFeedDailyGrace";
const STORAGE_MODE_KEY = "betterFeedSessionMode";
const STORAGE_FAKE_NOW_OFFSET_KEY = "betterFeedFakeNowOffset";
// Background-owned refresh status. Value: { state: "idle"|"refreshing"|"error",
// startedAt?, failedAt?, reason? }. The content script reads it to decide
// between the grid, the "Refreshing…" loader, and a quiet retry message -
// it is NEVER synced (transient, per-device) and must stay out of SYNC_KEYS.
const STORAGE_REFRESH_STATUS_KEY = "betterFeedRefreshStatus";
const MODE_LOCALSTORAGE_KEY = "betterFeedMode";
// Stable per-device id (random, local-only, NOT synced and NOT in LEGACY_KEY_MAP).
// Used to attribute watch-seconds per device in the daily state so a cross-device
// time limit sums each device's contribution without double-counting.
const STORAGE_DEVICE_ID_KEY = "betterFeedDeviceId";

// One-shot rebrand migration: the chrome.storage keys and the localStorage
// mode mirror were originally prefixed ytWeekly* (the project's old name).
// If a device still has the old keys present, copy them to the new keys and
// remove the old ones. Idempotent - once the old keys are gone this is a
// cheap no-op. Safe to call from any entry point's init path.
const LEGACY_KEY_MAP = {
  ytWeeklySettings: SETTINGS_KEY,
  ytWeeklyHiddenVideos: STORAGE_HIDDEN_VIDEOS_KEY,
  ytWeeklyHiddenChannels: STORAGE_HIDDEN_CHANNELS_KEY,
  ytWeeklyHiddenMetadata: STORAGE_HIDDEN_METADATA_KEY,
  ytWeeklyWatchedVideos: STORAGE_WATCHED_VIDEOS_KEY,
  ytWeeklyVideoProgress: STORAGE_PROGRESS_KEY,
  ytWeeklyWorkSession: STORAGE_WORK_SESSION_KEY,
  ytWeeklyVideos: STORAGE_VIDEOS_KEY,
  ytWeeklyRefreshAfter: STORAGE_REFRESH_AFTER_KEY,
  ytWeeklyDailyState: STORAGE_DAILY_STATE_KEY,
  ytWeeklyDailyGrace: STORAGE_DAILY_GRACE_KEY,
  ytWeeklySessionMode: STORAGE_MODE_KEY,
  ytWeeklyFakeNowOffset: STORAGE_FAKE_NOW_OFFSET_KEY
};
const LEGACY_LOCALSTORAGE_KEY = "ytWeeklyMode";

async function migrateLegacyStorageKeys() {
  const legacyKeys = Object.keys(LEGACY_KEY_MAP);

  async function migrateArea(area) {
    let stored;
    try {
      stored = await chrome.storage[area].get(legacyKeys);
    } catch (_) {
      return;
    }
    const writes = {};
    const removes = [];
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
      if (!(oldKey in stored)) continue;
      removes.push(oldKey);
      // Don't clobber a value that's already at the new key - the destination
      // is authoritative if both somehow coexist.
      let alreadyAtNew;
      try {
        const existing = await chrome.storage[area].get([newKey]);
        alreadyAtNew = newKey in existing;
      } catch (_) {
        alreadyAtNew = false;
      }
      if (!alreadyAtNew) writes[newKey] = stored[oldKey];
    }
    if (Object.keys(writes).length > 0) {
      try { await chrome.storage[area].set(writes); } catch (_) {}
    }
    if (removes.length > 0) {
      try { await chrome.storage[area].remove(removes); } catch (_) {}
    }
  }

  await migrateArea("local");
  await migrateArea("sync");

  // localStorage only exists in page/content-script contexts, not the SW.
  if (typeof localStorage !== "undefined") {
    try {
      const legacyMode = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
      if (legacyMode !== null) {
        if (localStorage.getItem(MODE_LOCALSTORAGE_KEY) === null) {
          localStorage.setItem(MODE_LOCALSTORAGE_KEY, legacyMode);
        }
        localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
      }
    } catch {}
  }
}

let _fakeNowOffsetMs = 0;

// Debug fake-time can shift the clock at most ±1 year. Without a bound a
// corrupted / hostile stored offset (or a console mistake) could push
// getNow() past the valid Date range, making new Date(getNow()) "Invalid"
// and poisoning getDailyDayKey (→ "NaN-NaN-NaN") and the refresh schedule.
const MAX_FAKE_NOW_OFFSET_MS = 365 * 24 * 60 * 60 * 1000;

function sanitizeFakeNowOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > MAX_FAKE_NOW_OFFSET_MS) return MAX_FAKE_NOW_OFFSET_MS;
  if (n < -MAX_FAKE_NOW_OFFSET_MS) return -MAX_FAKE_NOW_OFFSET_MS;
  return n;
}

function getNow() {
  return Date.now() + _fakeNowOffsetMs;
}

async function loadFakeNowOffset() {
  try {
    const data = await chrome.storage.local.get([STORAGE_FAKE_NOW_OFFSET_KEY]);
    _fakeNowOffsetMs = sanitizeFakeNowOffset(data[STORAGE_FAKE_NOW_OFFSET_KEY]);
  } catch (_) {
    _fakeNowOffsetMs = 0;
  }
  return _fakeNowOffsetMs;
}

function applyFakeNowOffsetChange(changes) {
  if (!changes || !(STORAGE_FAKE_NOW_OFFSET_KEY in changes)) return;
  _fakeNowOffsetMs = sanitizeFakeNowOffset(changes[STORAGE_FAKE_NOW_OFFSET_KEY].newValue);
}

const MODE_WATCH = "watch";
const MODE_WORK = "work";
const MODE_LISTEN = "listen";
const VALID_MODES = [MODE_WATCH, MODE_WORK, MODE_LISTEN];

const MARKER_HASH_NONE = "#better-feed";
const MARKER_HASH_WATCH = "#better-feed-watch";
const MARKER_HASH_WORK = "#better-feed-work";
const MARKER_HASH_LISTEN = "#better-feed-listen";

const MARKER_HASHES = new Set([
  MARKER_HASH_NONE,
  MARKER_HASH_WATCH,
  MARKER_HASH_WORK,
  MARKER_HASH_LISTEN
]);

function markerHashForMode(mode) {
  if (mode === MODE_WATCH) return MARKER_HASH_WATCH;
  if (mode === MODE_WORK) return MARKER_HASH_WORK;
  if (mode === MODE_LISTEN) return MARKER_HASH_LISTEN;
  return MARKER_HASH_NONE;
}

function markerUrlForMode(mode) {
  return "https://www.youtube.com/feed/library" + markerHashForMode(mode);
}

function syncModeToLocalStorage(mode) {
  if (typeof localStorage === "undefined") return;
  try {
    if (mode && VALID_MODES.includes(mode)) {
      localStorage.setItem(MODE_LOCALSTORAGE_KEY, mode);
    } else {
      localStorage.removeItem(MODE_LOCALSTORAGE_KEY);
    }
  } catch {}
}

async function getCurrentMode() {
  const data = await chrome.storage.local.get([STORAGE_MODE_KEY]);
  const value = data[STORAGE_MODE_KEY];
  return VALID_MODES.includes(value) ? value : null;
}

async function setCurrentMode(mode) {
  if (!VALID_MODES.includes(mode)) return;
  syncModeToLocalStorage(mode);
  await chrome.storage.local.set({ [STORAGE_MODE_KEY]: mode });
}

async function clearCurrentMode() {
  syncModeToLocalStorage(null);
  await chrome.storage.local.remove(STORAGE_MODE_KEY);
}

const MAX_WEEKLY_VIDEOS = 25;
// Over-scrape reserve: the background saves settings.videoCount + this many
// videos, all non-live / non-hidden AT SAVE TIME. The renderer drops any
// late-detected live streams from the pool and THEN takes the first videoCount
// as the week's FIXED set - so a live stream is BACKFILLED by a reserve video
// (we always want videoCount watchable videos in place). Hiding is different: it
// removes from the fixed set WITHOUT backfilling, so once your week's videos are
// in place, hiding them must not surface new ones until the next refresh.
const REFRESH_BACKFILL_BUFFER = 5;
// How long a background refresh may hold the "refreshing" status before a new
// trigger is allowed to supersede it (guards against a wedged in-flight fetch).
const REFRESH_INFLIGHT_TTL_MS = 60_000;
// After a failed refresh, suppress re-fetch for this long so a persistently
// all-live / unparseable home (which throws and never advances refreshAfter)
// can't re-issue a credentialed GET on every trigger. Kept under the 5-minute
// alarm period so the alarm still retries once the cooldown elapses.
const REFRESH_ERROR_COOLDOWN_MS = 120_000;

const DEFAULT_SETTINGS = {
  enabled: true,
  weeklyHomeEnabled: true,
  redirectHomeEnabled: true,
  refreshMode: "weekly",
  refreshDay: 0,
  refreshDays: [],
  refreshHour: 5,
  videoCount: 15,
  excludeLiveVideos: true,
  hideShorts: true,
  hideWatchRecs: true,
  disableAutoplay: true,
  hideEndScreenCards: true,
  hideLiveChat: false,
  hideWatchSidePanel: true,
  hideComments: true,
  hideNotificationBell: true,
  hideExploreTrending: true,
  hideMoreFromYoutube: true,
  hideMixRadioPlaylists: true,
  hideVoiceSearch: true,
  hideCreateButton: true,
  dailyLimitEnabled: true,
  dailyLimitMode: "both",
  maxVideosPerDay: 3,
  maxSecondsPerDay: 3600,
  workCustomMinutes: 60
};

const MAX_HIDDEN_PER_TYPE = 5000;
const SYNC_HIDDEN_VIDEOS_CAP = 200;
const SYNC_HIDDEN_CHANNELS_CAP = 100;
const SYNC_WATCHED_VIDEOS_CAP = 200;

// Cap a merged hidden/watched id list to MAX_HIDDEN_PER_TYPE (keeping the
// newest). The sync-merge paths (hydrateLocalFromSync / applySyncChangeToLocal)
// grow the local list by union, so without this they could push it past the cap
// that the local writers (persistHiddenState / modifyWatched) enforce.
function capSyncedIdList(list) {
  return list.length > MAX_HIDDEN_PER_TYPE
    ? list.slice(list.length - MAX_HIDDEN_PER_TYPE)
    : list;
}

const SYNC_KEYS = [
  SETTINGS_KEY,
  STORAGE_VIDEOS_KEY,
  STORAGE_REFRESH_AFTER_KEY,
  STORAGE_HIDDEN_VIDEOS_KEY,
  STORAGE_HIDDEN_CHANNELS_KEY,
  // STORAGE_HIDDEN_METADATA_KEY intentionally NOT synced - recovered on the
  // options/popup page via the YouTube oEmbed backfill (saves ~8 KB).
  STORAGE_WATCHED_VIDEOS_KEY,
  STORAGE_PROGRESS_KEY,
  // Daily limit progress roams across devices (merged as a CRDT - see
  // mergeDailyState) so the limit can't be bypassed by switching devices.
  STORAGE_DAILY_STATE_KEY
];

// Channel keys are stored locally as full URLs (e.g.,
// https://www.youtube.com/@channelname) so they slot into the canonical
// matching paths. For sync we strip the redundant origin prefix to shave
// ~25 bytes per channel; expanded back on the way in.
const CHANNEL_URL_PREFIX = "https://www.youtube.com";

function shrinkChannelKey(key) {
  if (typeof key !== "string") return key;
  if (key.startsWith(CHANNEL_URL_PREFIX)) return key.slice(CHANNEL_URL_PREFIX.length);
  return key;
}

function expandChannelKey(key) {
  if (typeof key !== "string") return key;
  if (key.startsWith("/")) return CHANNEL_URL_PREFIX + key;
  return key;
}

// Write-RATE limiting (MAX_WRITE_OPERATIONS_PER_MINUTE /
// MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE). Distinct from capacity quota:
// evicting keys cannot help - the eviction is itself another rate-limited
// write. Treat as transient and never evict for it.
function isWriteRateLimitError(err) {
  const msg = String(err?.message || err || "");
  return /MAX_(WRITE|SUSTAINED)/i.test(msg);
}

// Byte/item-capacity quota (QUOTA_BYTES, QUOTA_BYTES_PER_ITEM, MAX_ITEMS) -
// the only failure class that evicting lower-priority keys can fix.
// Chrome's rate-limit messages also contain the word "quota", so they must
// be excluded explicitly.
function isCapacityQuotaError(err) {
  if (err?.name === "QuotaExceededError") return true;
  if (isWriteRateLimitError(err)) return false;
  const msg = String(err?.message || err || "");
  return /quota|MAX_ITEMS/i.test(msg);
}

function isQuotaError(err) {
  return isCapacityQuotaError(err) || isWriteRateLimitError(err);
}

async function safeSyncSet(items) {
  try {
    await chrome.storage.sync.set(items);
    return true;
  } catch (err) {
    if (!isQuotaError(err)) {
      console.warn("sync set failed", err);
      return false;
    }
    return false;
  }
}

async function safeSyncRemove(keys) {
  try {
    await chrome.storage.sync.remove(keys);
  } catch (err) {
    console.warn("sync remove failed", err);
  }
}

async function priorityWriteSync(items, priority) {
  // First attempt inline so we can inspect the error: ONLY a quota failure is
  // fixable by evicting lower-priority keys. A transient/offline/non-quota
  // failure can't be helped by deleting synced data, so bail without evicting
  // (the old code evicted on any failure, needlessly destroying synced data).
  try {
    await chrome.storage.sync.set(items);
    return true;
  } catch (err) {
    if (!isCapacityQuotaError(err)) {
      // Rate-limit and transient failures land here too: eviction can't fix
      // them, so bail without destroying synced data.
      if (!isQuotaError(err)) console.warn("sync set failed", err);
      return false;
    }
  }
  // Capacity quota exceeded - evict lower-priority keys and retry.
  // Defensive: evicting a key that the payload is about to re-write does
  // nothing for the quota - the same bytes go right back. Drop any
  // evict-list entry that overlaps the payload before we waste a round-trip.
  const payloadKeys = new Set(Object.keys(items));
  for (const key of priority.evictKeysInOrder) {
    if (payloadKeys.has(key)) continue;
    await safeSyncRemove([key]);
    if (await safeSyncSet(items)) return true;
  }
  return false;
}

// 16-20 digit numeric code used as the typed-confirmation challenge in both
// the work-session unlock (content.js) and the watching-lock unlock
// (options.js). Long enough that copy-by-memory is annoying; short enough
// that typing it is still feasible.
function generateUnlockCode() {
  const length = 16 + Math.floor(Math.random() * 5); // 16-20 inclusive
  let code = "";
  for (let i = 0; i < length; i++) {
    code += String(Math.floor(Math.random() * 10));
  }
  return code;
}

// YouTube's public oEmbed endpoint. Used to recover a video's title,
// channel name, and channel URL from just the videoId - needed in three
// places (the weekly grid in content.js after a sync hydrate, the popup's
// hidden-items list, and the options page's hidden-items list), so it
// lives in shared.js to keep them from drifting.
const OEMBED_CONCURRENCY = 4;

async function fetchVideoMetadataFromOEmbed(videoId) {
  if (!videoId) return null;
  try {
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
    // credentials:"omit" - the oEmbed endpoint is public and needs no auth, and
    // from the content script (same-origin on youtube.com) a bare fetch would
    // otherwise send the user's login cookies. Matches the watch/channel fetches.
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || typeof data !== "object") return null;
    if (!data.title && !data.author_name) return null;
    return {
      title: data.title || "",
      channelName: data.author_name || "",
      channelUrl: data.author_url || ""
    };
  } catch (_) {
    return null;
  }
}

function mergeHiddenIds(localIds, syncIds) {
  const seen = new Set(localIds);
  const result = [...localIds];
  for (const id of syncIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// Validate a bounded integer setting: returns the value if it's an integer in
// [min, max], else the fallback. Collapses the repeated bounds checks below.
function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function sanitizeSettings(settings) {
  const updatedAt = Number(settings?._updatedAt);

  // Clamp _updatedAt: a far-future value (clock-skewed device) would win every
  // last-writer-wins comparison forever and lock out legitimate sync updates.
  // Anything beyond ~1 day ahead of this device's clock is treated as "now".
  const maxUpdatedAt = getNow() + 24 * 60 * 60 * 1000;
  const safeUpdatedAt =
    Number.isFinite(updatedAt) && updatedAt > 0 ? Math.min(updatedAt, maxUpdatedAt) : 0;

  return {
    _updatedAt: safeUpdatedAt,
    enabled:
      typeof settings?.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_SETTINGS.enabled,
    weeklyHomeEnabled:
      typeof settings?.weeklyHomeEnabled === "boolean"
        ? settings.weeklyHomeEnabled
        : DEFAULT_SETTINGS.weeklyHomeEnabled,
    redirectHomeEnabled:
      typeof settings?.redirectHomeEnabled === "boolean"
        ? settings.redirectHomeEnabled
        : DEFAULT_SETTINGS.redirectHomeEnabled,
    refreshMode:
      settings?.refreshMode === "multi" ||
      settings?.refreshMode === "daily" ||
      settings?.refreshMode === "weekly"
        ? settings.refreshMode
        : DEFAULT_SETTINGS.refreshMode,
    refreshDay: clampInteger(settings?.refreshDay, 0, 6, DEFAULT_SETTINGS.refreshDay),
    refreshDays: Array.isArray(settings?.refreshDays)
      ? [
          ...new Set(
            settings.refreshDays
              .map(d => Number(d))
              .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          )
        ].sort((a, b) => a - b)
      : [...DEFAULT_SETTINGS.refreshDays],
    refreshHour: clampInteger(settings?.refreshHour, 0, 23, DEFAULT_SETTINGS.refreshHour),
    videoCount: clampInteger(
      settings?.videoCount, 1, MAX_WEEKLY_VIDEOS,
      Math.min(DEFAULT_SETTINGS.videoCount, MAX_WEEKLY_VIDEOS)
    ),
    excludeLiveVideos:
      typeof settings?.excludeLiveVideos === "boolean"
        ? settings.excludeLiveVideos
        : DEFAULT_SETTINGS.excludeLiveVideos,
    hideShorts:
      typeof settings?.hideShorts === "boolean"
        ? settings.hideShorts
        : DEFAULT_SETTINGS.hideShorts,
    hideWatchRecs:
      typeof settings?.hideWatchRecs === "boolean"
        ? settings.hideWatchRecs
        : DEFAULT_SETTINGS.hideWatchRecs,
    disableAutoplay:
      typeof settings?.disableAutoplay === "boolean"
        ? settings.disableAutoplay
        : DEFAULT_SETTINGS.disableAutoplay,
    hideEndScreenCards:
      typeof settings?.hideEndScreenCards === "boolean"
        ? settings.hideEndScreenCards
        : DEFAULT_SETTINGS.hideEndScreenCards,
    hideLiveChat:
      typeof settings?.hideLiveChat === "boolean"
        ? settings.hideLiveChat
        : DEFAULT_SETTINGS.hideLiveChat,
    hideWatchSidePanel:
      typeof settings?.hideWatchSidePanel === "boolean"
        ? settings.hideWatchSidePanel
        : DEFAULT_SETTINGS.hideWatchSidePanel,
    hideComments:
      typeof settings?.hideComments === "boolean"
        ? settings.hideComments
        : DEFAULT_SETTINGS.hideComments,
    hideNotificationBell:
      typeof settings?.hideNotificationBell === "boolean"
        ? settings.hideNotificationBell
        : DEFAULT_SETTINGS.hideNotificationBell,
    hideExploreTrending:
      typeof settings?.hideExploreTrending === "boolean"
        ? settings.hideExploreTrending
        : DEFAULT_SETTINGS.hideExploreTrending,
    hideMoreFromYoutube:
      typeof settings?.hideMoreFromYoutube === "boolean"
        ? settings.hideMoreFromYoutube
        : DEFAULT_SETTINGS.hideMoreFromYoutube,
    hideMixRadioPlaylists:
      typeof settings?.hideMixRadioPlaylists === "boolean"
        ? settings.hideMixRadioPlaylists
        : DEFAULT_SETTINGS.hideMixRadioPlaylists,
    hideVoiceSearch:
      typeof settings?.hideVoiceSearch === "boolean"
        ? settings.hideVoiceSearch
        : DEFAULT_SETTINGS.hideVoiceSearch,
    hideCreateButton:
      typeof settings?.hideCreateButton === "boolean"
        ? settings.hideCreateButton
        : DEFAULT_SETTINGS.hideCreateButton,
    dailyLimitEnabled:
      typeof settings?.dailyLimitEnabled === "boolean"
        ? settings.dailyLimitEnabled
        : DEFAULT_SETTINGS.dailyLimitEnabled,
    dailyLimitMode:
      settings?.dailyLimitMode === "videos" ||
      settings?.dailyLimitMode === "time" ||
      settings?.dailyLimitMode === "both"
        ? settings.dailyLimitMode
        : DEFAULT_SETTINGS.dailyLimitMode,
    // Upper bounds guard against corrupted sync pushes / direct storage writes.
    // 100 is well above any realistic daily-watch cap; 24h cap is the
    // tautological maximum for "seconds per day". Without these, a bad value
    // silently disables the daily-limit takeover (the comparison never trips).
    maxVideosPerDay: clampInteger(settings?.maxVideosPerDay, 1, 100, DEFAULT_SETTINGS.maxVideosPerDay),
    maxSecondsPerDay:
      Number.isFinite(Number(settings?.maxSecondsPerDay)) &&
      Number(settings.maxSecondsPerDay) >= 1 &&
      Number(settings.maxSecondsPerDay) <= 24 * 60 * 60
        ? Number(settings.maxSecondsPerDay)
        : DEFAULT_SETTINGS.maxSecondsPerDay,
    workCustomMinutes: clampInteger(settings?.workCustomMinutes, 1, 60 * 24, DEFAULT_SETTINGS.workCustomMinutes)
  };
}

function getDailyDayKey(settings, now = new Date(getNow())) {
  const d = new Date(now);
  if (d.getHours() < (settings?.refreshHour ?? 0)) {
    d.setDate(d.getDate() - 1);
  }
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

let _deviceIdCache = null;
let _ephemeralDeviceId = null;
function _randomDeviceId() {
  return "dev-" + (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${getNow()}-${Math.floor(Math.random() * 1e9)}`);
}
async function getDeviceId() {
  if (_deviceIdCache) return _deviceIdCache;
  try {
    const data = await chrome.storage.local.get([STORAGE_DEVICE_ID_KEY]);
    let id = data[STORAGE_DEVICE_ID_KEY];
    if (typeof id !== "string" || !id) {
      id = _randomDeviceId();
      await chrome.storage.local.set({ [STORAGE_DEVICE_ID_KEY]: id });
    }
    _deviceIdCache = id;
    return id;
  } catch (_) {
    // Storage hiccup - return a UNIQUE ephemeral id. Do NOT poison _deviceIdCache
    // (so the next call re-attempts storage once it recovers) and never use a
    // shared literal (so two devices can't collide on one bucket and undercount
    // via mergeDailyState's per-key max).
    if (!_ephemeralDeviceId) _ephemeralDeviceId = _randomDeviceId();
    return _ephemeralDeviceId;
  }
}

function emptyDailyState(dayKey) {
  return { dayKey, videoIds: [], secondsByDevice: {} };
}

// Sum the per-device watch-seconds. Falls back to the pre-sync single-counter
// shape (secondsWatched) so a state read mid-migration still reports correctly.
function dailyTotalSeconds(state) {
  if (!state) return 0;
  const map = state.secondsByDevice;
  if (map && typeof map === "object") {
    let total = 0;
    for (const v of Object.values(map)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total;
  }
  const legacy = Number(state.secondsWatched);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 0;
}

// Upper bound for a single device's daily seconds bucket. A device can accrue
// at most 86400 real seconds in a day (2x headroom for clock weirdness); the
// per-key-MAX merge makes any value sticky for the whole day on every device,
// so an unclamped corrupt bucket (bad sync payload, storage corruption) would
// otherwise lock the daily limit everywhere with no way to back it out.
const DAILY_SECONDS_BUCKET_CAP = 2 * 86400;

function sanitizeSecondsMap(map) {
  if (!map || typeof map !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0) out[k] = Math.min(n, DAILY_SECONDS_BUCKET_CAP);
  }
  return out;
}

async function getDailyState(settings) {
  const data = await chrome.storage.local.get([STORAGE_DAILY_STATE_KEY]);
  const todayKey = getDailyDayKey(settings);
  const stored = data[STORAGE_DAILY_STATE_KEY];
  if (!stored || stored.dayKey !== todayKey) {
    return emptyDailyState(todayKey);
  }
  const videoIds = Array.isArray(stored.videoIds) ? stored.videoIds : [];
  let secondsByDevice = sanitizeSecondsMap(stored.secondsByDevice);
  if (!secondsByDevice) {
    // Migrate the pre-sync single-counter shape into a fixed "legacy" sentinel
    // bucket (NOT this device's id). If an old non-CRDT sync cloned the same
    // secondsWatched onto several devices, they all migrate into the same
    // "legacy" key, so mergeDailyState's per-key max de-dupes it instead of
    // summing (avoids an upgrade-day cross-device over-count). New watch time
    // still accrues under the real getDeviceId() bucket in flushWatchSeconds.
    const legacy = Number(stored.secondsWatched);
    secondsByDevice = Number.isFinite(legacy) && legacy > 0 ? { legacy } : {};
  }
  return { dayKey: stored.dayKey, videoIds, secondsByDevice };
}

// Canonical form so equal daily states stringify identically (videoIds deduped
// + sorted, device keys sorted). The sync echo guards compare via
// JSON.stringify, so without this two peers that accumulated the same ids in a
// different order would never converge and would re-push forever.
function canonicalDailyState(state) {
  if (!state || typeof state !== "object") return state;
  const videoIds = Array.isArray(state.videoIds) ? [...new Set(state.videoIds)].sort() : [];
  const src = state.secondsByDevice && typeof state.secondsByDevice === "object" ? state.secondsByDevice : {};
  const secondsByDevice = {};
  for (const k of Object.keys(src).sort()) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n > 0) secondsByDevice[k] = Math.min(n, DAILY_SECONDS_BUCKET_CAP);
  }
  return { dayKey: state.dayKey, videoIds, secondsByDevice };
}

async function saveDailyState(state) {
  await chrome.storage.local.set({ [STORAGE_DAILY_STATE_KEY]: canonicalDailyState(state) });
}

function isDailyLimitHit(state, settings) {
  if (!settings.dailyLimitEnabled) return false;
  const mode = settings.dailyLimitMode || "both";
  if (mode !== "time" && (state.videoIds?.length || 0) >= settings.maxVideosPerDay) return true;
  if (mode !== "videos" && dailyTotalSeconds(state) >= settings.maxSecondsPerDay) return true;
  return false;
}

function isDailyVideoQuotaReached(state, settings) {
  if (!settings.dailyLimitEnabled) return false;
  const mode = settings.dailyLimitMode || "both";
  if (mode === "time") return false;
  return (state.videoIds?.length || 0) >= settings.maxVideosPerDay;
}

const MS_DAY = 24 * 60 * 60 * 1000;
function isValidDayKey(k) {
  if (typeof k !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  // Reject implausibly-future keys (clock skew / corruption) so a garbage key
  // like "9999-99-99" (or "undefined") can never beat a real YYYY-MM-DD.
  const t = Date.parse(k + "T00:00:00Z");
  return Number.isFinite(t) && t <= getNow() + MS_DAY;
}

// Per-device seconds buckets for a state, folding a LEGACY single-counter
// operand (old { secondsWatched } shape) into a shared "legacy" bucket so its
// time is merged (not silently dropped) and de-duped by max, not summed.
function dailySecondsBuckets(s) {
  if (s && s.secondsByDevice && typeof s.secondsByDevice === "object") return s.secondsByDevice;
  const legacy = Number(s && s.secondsWatched);
  return (Number.isFinite(legacy) && legacy > 0) ? { legacy } : null;
}

// Bring one (possibly raw-from-sync / legacy-shaped) daily-state operand into
// canonical form: legacy secondsWatched folded into its bucket, videoIds
// deduped+sorted, device keys sorted+clamped, junk fields dropped.
function normalizeDailyOperand(s) {
  if (!s || typeof s !== "object") return s;
  return canonicalDailyState({
    dayKey: s.dayKey,
    videoIds: s.videoIds,
    secondsByDevice: dailySecondsBuckets(s) || {}
  });
}

// CRDT merge for the daily state across devices. Different day-keys: prefer the
// side matching THIS device's current day (todayKey, when supplied) so a sibling
// already rolled into the next local day (timezone skew) can't wipe the day this
// device is still accumulating; otherwise the later VALID day wins (a malformed
// or implausible dayKey never beats a well-formed one, so it can't wipe local
// progress). Same day: union videoIds + per-device-bucket max - each device only
// increments its OWN bucket, so max is that device's latest and summing the
// buckets gives the true cross-device total (can't be bypassed by switching
// devices). Output is canonical (deduped/sorted) so the echo guards converge.
function mergeDailyState(a, b, todayKey) {
  // Every exit goes through normalizeDailyOperand so the promise "output is
  // canonical" holds on the single-winner paths too - a raw sync operand with
  // duplicate videoIds (inflating isDailyLimitHit's count) or a legacy
  // secondsWatched shape must not be written to local verbatim.
  if (!a || typeof a !== "object") return (b && typeof b === "object") ? normalizeDailyOperand(b) : null;
  if (!b || typeof b !== "object") return normalizeDailyOperand(a);
  if (a.dayKey !== b.dayKey) {
    const aOk = isValidDayKey(a.dayKey);
    const bOk = isValidDayKey(b.dayKey);
    let winner;
    if (typeof todayKey === "string" && a.dayKey === todayKey) {
      winner = aOk ? a : (bOk ? b : a);
    } else if (typeof todayKey === "string" && b.dayKey === todayKey) {
      winner = bOk ? b : (aOk ? a : b);
    } else if (aOk && bOk) {
      winner = b.dayKey > a.dayKey ? b : a;
    } else {
      winner = aOk ? a : (bOk ? b : a);
    }
    return normalizeDailyOperand(winner);
  }
  const videoIds = [...new Set([
    ...(Array.isArray(a.videoIds) ? a.videoIds : []),
    ...(Array.isArray(b.videoIds) ? b.videoIds : [])
  ])].sort();
  const merged = {};
  for (const src of [dailySecondsBuckets(a), dailySecondsBuckets(b)]) {
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n > 0) {
          merged[k] = Math.min(Math.max(merged[k] || 0, n), DAILY_SECONDS_BUCKET_CAP);
        }
      }
    }
  }
  const secondsByDevice = {};
  for (const k of Object.keys(merged).sort()) secondsByDevice[k] = merged[k];
  return { dayKey: a.dayKey, videoIds, secondsByDevice };
}

async function getDailyGrace(settings) {
  const data = await chrome.storage.local.get([STORAGE_DAILY_GRACE_KEY]);
  const todayKey = getDailyDayKey(settings);
  const stored = data[STORAGE_DAILY_GRACE_KEY];
  if (!stored || stored.dayKey !== todayKey) return null;
  return stored;
}

async function saveDailyGrace(grace) {
  if (!grace) {
    await chrome.storage.local.remove(STORAGE_DAILY_GRACE_KEY);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_DAILY_GRACE_KEY]: grace });
}

function isGraceActiveForLocation(grace, locationLike) {
  if (!grace) return false;
  if (grace.type === "minutes") {
    return getNow() < grace.expiresAt;
  }
  if (grace.type === "finish") {
    // A finish grace with no videoId is stale/bogus - never treat it as active
    // (otherwise params.get("v")===null would match any v-less watch URL).
    if (!grace.videoId) return false;
    if (!locationLike || locationLike.pathname !== "/watch") return false;
    const params = new URLSearchParams(locationLike.search || "");
    return params.get("v") === grace.videoId;
  }
  return false;
}

// Day names indexed by Date#getDay(). Shared by the options page (refresh-day
// pickers) and content.js (cold-start pickers, long date formatting).
const DAY_NAMES_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
];

function convertTo12Hour(hour24) {
  const hour = Number(hour24);
  if (hour === 0) return { hour: 12, ampm: "am" };
  if (hour < 12) return { hour, ampm: "am" };
  if (hour === 12) return { hour: 12, ampm: "pm" };
  return { hour: hour - 12, ampm: "pm" };
}

function convertTo24Hour(hour12, ampm) {
  let hour = Number(hour12);
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return hour;
}

async function getSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  return sanitizeSettings(data[SETTINGS_KEY]);
}

// Work session: a wall-clock commitment device. Two flavors:
//  - Timed: `{ startedAt, endsAt, durationMinutes }` - Watch is locked until
//    endsAt. Session ends automatically when endsAt is reached.
//  - No-time: `{ startedAt, noTime: true }` - session has no end. Watch lock
//    is dynamic: a 15-second grace period after startedAt where the user can
//    still bail, then a 20-minute lock window, then no lock (session itself
//    keeps running until the user manually ends it).
// Stored local-only - the session is a per-device focus state, not
// cross-device coordination.
async function getWorkSession() {
  const data = await chrome.storage.local.get([STORAGE_WORK_SESSION_KEY]);
  const session = data[STORAGE_WORK_SESSION_KEY];
  if (!session || typeof session !== "object") return null;
  if (typeof session.startedAt !== "number" || !isFinite(session.startedAt)) return null;
  if (session.noTime) return session;
  if (typeof session.endsAt !== "number" || !isFinite(session.endsAt)) return null;
  return session;
}

async function setWorkSession({ minutes, noTime, noGrace } = {}) {
  const startedAt = getNow();
  if (noTime) {
    const session = { startedAt, noTime: true };
    // No-grace sessions skip the 15-second grace window - the Watch lock
    // kicks in immediately. Used when starting a new session from the clock
    // popover or session-ended popup (i.e., the user is re-committing
    // mid-Work, no fat-finger window required).
    if (noGrace) session.noGrace = true;
    await chrome.storage.local.set({ [STORAGE_WORK_SESSION_KEY]: session });
    return session;
  }
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 1) return null;
  const session = {
    startedAt,
    endsAt: startedAt + Math.floor(m) * 60 * 1000,
    durationMinutes: Math.floor(m)
  };
  await chrome.storage.local.set({ [STORAGE_WORK_SESSION_KEY]: session });
  return session;
}

async function clearWorkSession() {
  await chrome.storage.local.remove(STORAGE_WORK_SESSION_KEY);
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  clean._updatedAt = getNow();
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  await priorityWriteSync(
    { [SETTINGS_KEY]: clean },
    {
      evictKeysInOrder: [
        STORAGE_HIDDEN_CHANNELS_KEY,
        STORAGE_HIDDEN_VIDEOS_KEY,
        STORAGE_WATCHED_VIDEOS_KEY,
        STORAGE_VIDEOS_KEY
      ]
    }
  );
}

function getArrayFromStorage(data, key) {
  return Array.isArray(data[key]) ? data[key] : [];
}

async function getHiddenItems(includeMetadata = false) {
  const keys = [STORAGE_HIDDEN_VIDEOS_KEY, STORAGE_HIDDEN_CHANNELS_KEY];
  if (includeMetadata) keys.push(STORAGE_HIDDEN_METADATA_KEY);

  const data = await chrome.storage.local.get(keys);
  const result = {
    videos: new Set(getArrayFromStorage(data, STORAGE_HIDDEN_VIDEOS_KEY).filter(Boolean)),
    channels: new Set(getArrayFromStorage(data, STORAGE_HIDDEN_CHANNELS_KEY).filter(Boolean))
  };
  if (includeMetadata) result.metadata = data[STORAGE_HIDDEN_METADATA_KEY] || {};
  return result;
}

const getHiddenItemsWithMetadata = () => getHiddenItems(true);

async function persistHiddenState(state) {
  let videoIds = [...state.videos];
  let channelIds = [...state.channels];
  const metadata = { ...(state.metadata || {}) };

  if (videoIds.length > MAX_HIDDEN_PER_TYPE) {
    const dropCount = videoIds.length - MAX_HIDDEN_PER_TYPE;
    const dropped = videoIds.slice(0, dropCount);
    videoIds = videoIds.slice(dropCount);
    for (const id of dropped) delete metadata[id];
  }

  if (channelIds.length > MAX_HIDDEN_PER_TYPE) {
    const dropCount = channelIds.length - MAX_HIDDEN_PER_TYPE;
    const dropped = channelIds.slice(0, dropCount);
    channelIds = channelIds.slice(dropCount);
    for (const id of dropped) delete metadata[id];
  }

  await chrome.storage.local.set({
    [STORAGE_HIDDEN_VIDEOS_KEY]: videoIds,
    [STORAGE_HIDDEN_CHANNELS_KEY]: channelIds,
    [STORAGE_HIDDEN_METADATA_KEY]: metadata
  });

  const syncVideos = videoIds.slice(-SYNC_HIDDEN_VIDEOS_CAP);
  // Strip the YouTube origin from channel URLs for sync - expanded again on
  // hydrate. Keeps the per-item blob small.
  const syncChannels = channelIds
    .slice(-SYNC_HIDDEN_CHANNELS_CAP)
    .map(shrinkChannelKey);
  // Hidden lists are themselves high-priority sync content, so when over
  // quota evict the lower-priority data first (positions, then watched, then
  // weekly videos) rather than the keys we're trying to write. priorityWriteSync
  // also defensively skips payload-overlapping evict keys, but the right list
  // here is "other things to drop", not "our own data".
  await priorityWriteSync(
    {
      [STORAGE_HIDDEN_VIDEOS_KEY]: syncVideos,
      [STORAGE_HIDDEN_CHANNELS_KEY]: syncChannels
    },
    {
      evictKeysInOrder: [
        STORAGE_PROGRESS_KEY,
        STORAGE_WATCHED_VIDEOS_KEY,
        STORAGE_VIDEOS_KEY
      ]
    }
  );
  // Drop any legacy metadata blob left over in sync from older builds -
  // we now rebuild via the oEmbed backfill instead of carrying it through.
  // (safeSyncRemove catches internally and never rejects.)
  safeSyncRemove([STORAGE_HIDDEN_METADATA_KEY]);
}

// Builds a serial queue: each enqueued fn runs only after the previous one
// settles (resolve OR reject), so read-modify-write sequences against the same
// storage key can't interleave. Returns the fn's own result/rejection to the
// caller while keeping the internal chain alive. Used for the hidden / watched
// / progress write paths below.
function makeSerialQueue() {
  let chain = Promise.resolve();
  return fn => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

const enqueueHiddenWrite = makeSerialQueue();

function modifyHidden(modifyFn) {
  const run = async () => {
    const state = await getHiddenItemsWithMetadata();
    await modifyFn(state);
    await persistHiddenState(state);
    return state;
  };
  return enqueueHiddenWrite(run);
}

async function getWatchedVideos() {
  const data = await chrome.storage.local.get([STORAGE_WATCHED_VIDEOS_KEY]);
  return new Set(getArrayFromStorage(data, STORAGE_WATCHED_VIDEOS_KEY).filter(Boolean));
}

const enqueueWatchedWrite = makeSerialQueue();

function modifyWatched(modifyFn) {
  const run = async () => {
    const set = await getWatchedVideos();
    await modifyFn(set);
    let list = [...set];
    if (list.length > MAX_HIDDEN_PER_TYPE) {
      list = list.slice(list.length - MAX_HIDDEN_PER_TYPE);
    }
    await chrome.storage.local.set({ [STORAGE_WATCHED_VIDEOS_KEY]: list });
    const syncList = list.slice(-SYNC_WATCHED_VIDEOS_CAP);
    await priorityWriteSync(
      { [STORAGE_WATCHED_VIDEOS_KEY]: syncList },
      { evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY] }
    );
    return set;
  };
  return enqueueWatchedWrite(run);
}

async function getVideoProgressMap() {
  const data = await chrome.storage.local.get([STORAGE_PROGRESS_KEY]);
  const map = data[STORAGE_PROGRESS_KEY];
  return map && typeof map === "object" ? map : {};
}

const enqueueProgressWrite = makeSerialQueue();

// Locally, progress entries are `{ position, duration }` in seconds - duration
// is convenient for fast bar rendering without re-parsing the formatted
// duration string from the weekly video meta.
// In sync we only carry the position (a bare number) since duration is
// always recoverable from the weekly grid's `duration` field. Renderers and
// the merge logic accept both shapes.
//
// duration >= 0 (not > 0): entries hydrated FROM sync are stored locally as
// { position, duration: 0 } (sync doesn't carry duration). Requiring a
// positive duration here would make flushProgressToSync's prune delete a
// peer device's positions from local AND from the next sync write.
function isValidProgressEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.position === "number" &&
    isFinite(entry.position) &&
    entry.position > 0 &&
    typeof entry.duration === "number" &&
    isFinite(entry.duration) &&
    entry.duration >= 0
  );
}

function normalizeIncomingProgressEntry(entry) {
  // Accept both new (number) and legacy ({position, duration}) shapes.
  if (typeof entry === "number" && isFinite(entry) && entry > 0) {
    return { position: entry, duration: 0 };
  }
  if (entry && typeof entry === "object") {
    const pos = typeof entry.position === "number" && isFinite(entry.position) ? entry.position : 0;
    const dur =
      typeof entry.duration === "number" && isFinite(entry.duration) && entry.duration > 0
        ? entry.duration
        : 0;
    if (pos > 0) return { position: pos, duration: dur };
  }
  return null;
}

function slimProgressForSync(map) {
  const out = {};
  for (const [videoId, entry] of Object.entries(map || {})) {
    if (!videoId) continue;
    if (isValidProgressEntry(entry)) {
      // Round to integer seconds - the bar is sub-pixel anyway.
      out[videoId] = Math.round(entry.position);
    }
  }
  return out;
}

function setVideoProgress(videoId, position, duration) {
  const run = async () => {
    if (!videoId) return;
    if (typeof position !== "number" || !isFinite(position)) return;
    if (typeof duration !== "number" || !isFinite(duration) || duration <= 0) return;
    const map = await getVideoProgressMap();
    map[videoId] = {
      position: Math.max(0, Math.min(duration, position)),
      duration
    };
    await chrome.storage.local.set({ [STORAGE_PROGRESS_KEY]: map });
  };
  return enqueueProgressWrite(run);
}

function clearVideoProgress(videoId) {
  const run = async () => {
    if (!videoId) return;
    const map = await getVideoProgressMap();
    if (!(videoId in map)) return;
    delete map[videoId];
    await chrome.storage.local.set({ [STORAGE_PROGRESS_KEY]: map });
  };
  return enqueueProgressWrite(run);
}

function mergeProgressMaps(localMap, incomingMap) {
  const merged = {};
  // Carry over existing local entries that are still valid.
  for (const [videoId, entry] of Object.entries(localMap || {})) {
    if (isValidProgressEntry(entry)) merged[videoId] = entry;
  }
  for (const [videoId, entry] of Object.entries(incomingMap || {})) {
    if (!videoId) continue;
    const incoming = normalizeIncomingProgressEntry(entry);
    if (!incoming) continue;
    const existing = merged[videoId];
    const existingPos = existing && existing.position > 0 ? existing.position : 0;
    if (incoming.position > existingPos) {
      // Prefer local duration if it's known; sync-side only carries position.
      const duration =
        existing && existing.duration > 0
          ? existing.duration
          : incoming.duration > 0
            ? incoming.duration
            : 0;
      const clampedPos = duration > 0 ? Math.min(duration, incoming.position) : incoming.position;
      merged[videoId] = { position: Math.max(0, clampedPos), duration };
    }
  }
  return merged;
}

// Push the current local progress map up to sync. Chained behind any in-flight
// local writes so the snapshot we ship is the latest. Only meant to run on
// "exit" signals (SPA-navigate away, pagehide) - not on every tick.
//
// Also prunes entries against the current week's grid before writing - both
// to local and sync. Sync hydration uses max-style merge, which can't represent
// deletion, so stale entries from past weeks would otherwise creep back in and
// re-ship to sync. This pruning is the single chokepoint that keeps both
// stores bounded to the current week.
function flushProgressToSync() {
  const run = async () => {
    const data = await chrome.storage.local.get([STORAGE_PROGRESS_KEY, STORAGE_VIDEOS_KEY]);
    const map =
      data[STORAGE_PROGRESS_KEY] && typeof data[STORAGE_PROGRESS_KEY] === "object"
        ? data[STORAGE_PROGRESS_KEY]
        : {};
    const videos = Array.isArray(data[STORAGE_VIDEOS_KEY]) ? data[STORAGE_VIDEOS_KEY] : [];
    const validIds = new Set(videos.map(v => v?.videoId).filter(Boolean));

    const pruned = {};
    for (const [videoId, entry] of Object.entries(map)) {
      if (validIds.has(videoId) && isValidProgressEntry(entry)) {
        pruned[videoId] = entry;
      }
    }

    if (Object.keys(pruned).length !== Object.keys(map).length) {
      await chrome.storage.local.set({ [STORAGE_PROGRESS_KEY]: pruned });
    }
    if (Object.keys(pruned).length === 0) return;

    // Sync ships positions as bare numbers - duration is recoverable from the
    // weekly grid at render time.
    const slim = slimProgressForSync(pruned);
    await priorityWriteSync(
      { [STORAGE_PROGRESS_KEY]: slim },
      { evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY] }
    );
  };
  return enqueueProgressWrite(run);
}

function slimVideoForStorage(video) {
  if (!video) return video;
  const slim = {
    videoId: video.videoId,
    title: video.title,
    channelName: video.channelName,
    channelUrl: video.channelUrl,
    avatar: video.avatar,
    duration: video.duration,
    metadata: video.metadata,
    membersOnly: !!video.membersOnly,
    isLive: !!video.isLive
  };
  if (typeof video.membersOnlyCheckedAt === "number") {
    slim.membersOnlyCheckedAt = video.membersOnlyCheckedAt;
  }
  return slim;
}

function videoLooksLive(video) {
  if (!video) return false;
  if (video.isLive === true) return true;
  const meta = video.metadata || "";
  // Currently-live: "X watching now" (no "ago" qualifier).
  if (/\bwatching\b/i.test(meta) && !/\bago\b/i.test(meta)) return true;
  // Upcoming / premieres / scheduled streams.
  if (/\bpremieres?\s+(in|at|on)\b/i.test(meta)) return true;
  if (/\bscheduled\s+for\b/i.test(meta)) return true;
  if (/\bstarted\s+streaming\b/i.test(meta)) return true;
  // Past live stream replays - YouTube tags them with "Streamed N units ago"
  // OR "Streamed live N units ago" (the latter form appears for some replays
  // and locales). Still require a digit before "ago" so a stray title-bleed
  // containing the word "streamed" can't false-positive a regular video.
  if (/\bstreamed\b.*?\d+.*?\bago\b/i.test(meta)) return true;
  // Fallback: no fixed duration and metadata lacks both "views" and "ago"
  // → strongly indicates a current live broadcast. Stubs from sync have
  // empty metadata and are skipped so we don't false-positive there.
  const duration = (video.duration || "").trim();
  if (!duration && meta && !/\bviews?\b/i.test(meta) && !/\bago\b/i.test(meta)) {
    return true;
  }
  return false;
}

// Build a stub video object from just an ID. Used when sync only carries IDs
// (the slim format) - title/channelName/etc. are populated later by the
// oEmbed rebuild on the content script side. Thumbnails work without
// metadata because their URLs are derived from the videoId directly.
function stubVideoFromId(videoId) {
  return {
    videoId,
    title: "",
    channelName: "",
    channelUrl: "",
    avatar: "",
    duration: "",
    metadata: "",
    membersOnly: false
  };
}

// Normalize a sync `STORAGE_VIDEOS_KEY` payload into local-format video
// objects. Accepts the new slim format (array of IDs) or the legacy full
// format (array of objects).
function videosFromSyncPayload(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .slice(0, MAX_WEEKLY_VIDEOS)
    .map(item => {
      if (typeof item === "string") return stubVideoFromId(item);
      if (item && typeof item === "object" && item.videoId) return slimVideoForStorage(item);
      return null;
    })
    .filter(Boolean);
}

async function saveWeeklyVideosToStorage(videos, refreshAfter) {
  const capped = Array.isArray(videos)
    ? videos.slice(0, MAX_WEEKLY_VIDEOS).map(slimVideoForStorage)
    : [];
  await chrome.storage.local.set({
    [STORAGE_VIDEOS_KEY]: capped,
    [STORAGE_REFRESH_AFTER_KEY]: refreshAfter
  });

  // Sync ships only the IDs. Other devices rebuild title/channel/etc. via
  // YouTube's oEmbed endpoint on the content script side. Thumbnails are
  // derived from the videoId so they render without metadata.
  const slimIds = capped.map(v => v?.videoId).filter(Boolean);
  await priorityWriteSync(
    {
      [STORAGE_VIDEOS_KEY]: slimIds,
      [STORAGE_REFRESH_AFTER_KEY]: refreshAfter
    },
    {
      evictKeysInOrder: [
        STORAGE_HIDDEN_CHANNELS_KEY,
        STORAGE_HIDDEN_VIDEOS_KEY,
        SETTINGS_KEY
      ]
    }
  );

  // New week's grid is in storage - last week's watched flags are now stale,
  // so flush them. Routed through modifyWatched so it serializes against any
  // in-flight user-driven watched write and also clears the synced copy.
  await modifyWatched(set => set.clear());
  // Same goes for per-video playback progress - including the synced copy.
  // Hydration merges sync progress back into local (max-position, no delete
  // signal), so a stale prior-week map left in sync would creep back into
  // local until a watch-tab flush happened to prune it.
  await chrome.storage.local.remove(STORAGE_PROGRESS_KEY);
  await safeSyncRemove([STORAGE_PROGRESS_KEY]);
}

async function hydrateFromSync() {
  let sync;
  try {
    sync = await chrome.storage.sync.get(SYNC_KEYS);
  } catch (err) {
    console.warn("sync read failed", err);
    return;
  }

  const updates = {};

  const localState = await chrome.storage.local.get([
    STORAGE_VIDEOS_KEY,
    STORAGE_REFRESH_AFTER_KEY,
    SETTINGS_KEY
  ]);
  const localRefresh = localState[STORAGE_REFRESH_AFTER_KEY];
  const syncRefresh = sync[STORAGE_REFRESH_AFTER_KEY];
  const localHasVideos = Array.isArray(localState[STORAGE_VIDEOS_KEY]) && localState[STORAGE_VIDEOS_KEY].length > 0;
  const syncIsNewer =
    typeof syncRefresh === "number" &&
    (typeof localRefresh !== "number" || syncRefresh > localRefresh);

  if (sync[SETTINGS_KEY]) {
    const localSettingsAt = Number(localState[SETTINGS_KEY]?._updatedAt) || 0;
    const syncSettingsAt = Number(sync[SETTINGS_KEY]?._updatedAt) || 0;
    if (!localState[SETTINGS_KEY] || syncSettingsAt > localSettingsAt) {
      updates[SETTINGS_KEY] = sanitizeSettings(sync[SETTINGS_KEY]);
    }
  }
  if (Array.isArray(sync[STORAGE_VIDEOS_KEY]) && sync[STORAGE_VIDEOS_KEY].length > 0 && (!localHasVideos || syncIsNewer)) {
    // Accepts either the slim ID-only format (new) or full objects (legacy).
    updates[STORAGE_VIDEOS_KEY] = videosFromSyncPayload(sync[STORAGE_VIDEOS_KEY]);
  }
  if (typeof syncRefresh === "number" && (typeof localRefresh !== "number" || syncRefresh > localRefresh)) {
    updates[STORAGE_REFRESH_AFTER_KEY] = syncRefresh;
  }

  const localLists = await chrome.storage.local.get([
    STORAGE_HIDDEN_VIDEOS_KEY,
    STORAGE_HIDDEN_CHANNELS_KEY,
    STORAGE_WATCHED_VIDEOS_KEY,
    STORAGE_PROGRESS_KEY,
    STORAGE_DAILY_STATE_KEY
  ]);

  if (Array.isArray(sync[STORAGE_HIDDEN_VIDEOS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_HIDDEN_VIDEOS_KEY])
      ? localLists[STORAGE_HIDDEN_VIDEOS_KEY]
      : [];
    updates[STORAGE_HIDDEN_VIDEOS_KEY] = capSyncedIdList(mergeHiddenIds(localList, sync[STORAGE_HIDDEN_VIDEOS_KEY]));
  }
  if (Array.isArray(sync[STORAGE_HIDDEN_CHANNELS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_HIDDEN_CHANNELS_KEY])
      ? localLists[STORAGE_HIDDEN_CHANNELS_KEY]
      : [];
    // Expand any sync-shrunk channel keys back to full URLs before merging.
    const incoming = sync[STORAGE_HIDDEN_CHANNELS_KEY].map(expandChannelKey);
    updates[STORAGE_HIDDEN_CHANNELS_KEY] = capSyncedIdList(mergeHiddenIds(localList, incoming));
  }
  if (Array.isArray(sync[STORAGE_WATCHED_VIDEOS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_WATCHED_VIDEOS_KEY])
      ? localLists[STORAGE_WATCHED_VIDEOS_KEY]
      : [];
    updates[STORAGE_WATCHED_VIDEOS_KEY] = capSyncedIdList(mergeHiddenIds(localList, sync[STORAGE_WATCHED_VIDEOS_KEY]));
  }
  if (sync[STORAGE_PROGRESS_KEY] && typeof sync[STORAGE_PROGRESS_KEY] === "object") {
    const localMap =
      localLists[STORAGE_PROGRESS_KEY] && typeof localLists[STORAGE_PROGRESS_KEY] === "object"
        ? localLists[STORAGE_PROGRESS_KEY]
        : {};
    updates[STORAGE_PROGRESS_KEY] = mergeProgressMaps(localMap, sync[STORAGE_PROGRESS_KEY]);
  }
  if (sync[STORAGE_DAILY_STATE_KEY] && typeof sync[STORAGE_DAILY_STATE_KEY] === "object") {
    const localDaily =
      localLists[STORAGE_DAILY_STATE_KEY] && typeof localLists[STORAGE_DAILY_STATE_KEY] === "object"
        ? localLists[STORAGE_DAILY_STATE_KEY]
        : null;
    const merged = mergeDailyState(localDaily, sync[STORAGE_DAILY_STATE_KEY], await currentDayKey());
    if (merged && JSON.stringify(merged) !== JSON.stringify(localDaily)) {
      updates[STORAGE_DAILY_STATE_KEY] = merged;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await pushLocalToSyncIfMissing(sync);
}

async function pushLocalToSyncIfMissing(sync) {
  const local = await chrome.storage.local.get([
    SETTINGS_KEY,
    STORAGE_VIDEOS_KEY,
    STORAGE_REFRESH_AFTER_KEY,
    STORAGE_HIDDEN_VIDEOS_KEY,
    STORAGE_HIDDEN_CHANNELS_KEY,
    STORAGE_WATCHED_VIDEOS_KEY,
    STORAGE_PROGRESS_KEY,
    STORAGE_DAILY_STATE_KEY
  ]);

  const toPush = {};

  const syncSettingsAt = Number(sync[SETTINGS_KEY]?._updatedAt) || 0;
  const localSettingsAt = Number(local[SETTINGS_KEY]?._updatedAt) || 0;
  if (local[SETTINGS_KEY] && (!sync[SETTINGS_KEY] || localSettingsAt > syncSettingsAt)) {
    toPush[SETTINGS_KEY] = sanitizeSettings(local[SETTINGS_KEY]);
  }

  const localVideosArr = Array.isArray(local[STORAGE_VIDEOS_KEY]) ? local[STORAGE_VIDEOS_KEY] : null;
  const syncVideosArr = Array.isArray(sync[STORAGE_VIDEOS_KEY]) ? sync[STORAGE_VIDEOS_KEY] : null;
  const syncRefreshNum = typeof sync[STORAGE_REFRESH_AFTER_KEY] === "number" ? sync[STORAGE_REFRESH_AFTER_KEY] : null;
  const localRefreshNum = typeof local[STORAGE_REFRESH_AFTER_KEY] === "number" ? local[STORAGE_REFRESH_AFTER_KEY] : null;
  const localVideosNewer =
    localRefreshNum !== null &&
    (syncRefreshNum === null || localRefreshNum > syncRefreshNum);
  if (localVideosArr && localVideosArr.length > 0 && (!syncVideosArr || syncVideosArr.length === 0 || localVideosNewer)) {
    // Push the slim ID-only form (sync ships IDs only).
    toPush[STORAGE_VIDEOS_KEY] = localVideosArr
      .slice(0, MAX_WEEKLY_VIDEOS)
      .map(v => v?.videoId)
      .filter(Boolean);
  }
  if (localRefreshNum !== null && (syncRefreshNum === null || localRefreshNum > syncRefreshNum)) {
    toPush[STORAGE_REFRESH_AFTER_KEY] = localRefreshNum;
  }
  if (!Array.isArray(sync[STORAGE_HIDDEN_VIDEOS_KEY]) && Array.isArray(local[STORAGE_HIDDEN_VIDEOS_KEY]) && local[STORAGE_HIDDEN_VIDEOS_KEY].length > 0) {
    toPush[STORAGE_HIDDEN_VIDEOS_KEY] = local[STORAGE_HIDDEN_VIDEOS_KEY].slice(-SYNC_HIDDEN_VIDEOS_CAP);
  }
  if (!Array.isArray(sync[STORAGE_HIDDEN_CHANNELS_KEY]) && Array.isArray(local[STORAGE_HIDDEN_CHANNELS_KEY]) && local[STORAGE_HIDDEN_CHANNELS_KEY].length > 0) {
    toPush[STORAGE_HIDDEN_CHANNELS_KEY] = local[STORAGE_HIDDEN_CHANNELS_KEY]
      .slice(-SYNC_HIDDEN_CHANNELS_CAP)
      .map(shrinkChannelKey);
  }
  if (!Array.isArray(sync[STORAGE_WATCHED_VIDEOS_KEY]) && Array.isArray(local[STORAGE_WATCHED_VIDEOS_KEY]) && local[STORAGE_WATCHED_VIDEOS_KEY].length > 0) {
    toPush[STORAGE_WATCHED_VIDEOS_KEY] = local[STORAGE_WATCHED_VIDEOS_KEY].slice(-SYNC_WATCHED_VIDEOS_CAP);
  }
  if (
    (!sync[STORAGE_PROGRESS_KEY] || typeof sync[STORAGE_PROGRESS_KEY] !== "object") &&
    local[STORAGE_PROGRESS_KEY] &&
    typeof local[STORAGE_PROGRESS_KEY] === "object" &&
    Object.keys(local[STORAGE_PROGRESS_KEY]).length > 0
  ) {
    // Same wire shape as flushProgressToSync: prune to the current weekly grid
    // and ship bare-number positions - never the raw local {position, duration}
    // map (fatter payload, and stale prior-week entries would re-enter sync).
    const weeklyIds = new Set(
      (Array.isArray(local[STORAGE_VIDEOS_KEY]) ? local[STORAGE_VIDEOS_KEY] : [])
        .map(v => v?.videoId)
        .filter(Boolean)
    );
    const prunedProgress = {};
    for (const [videoId, entry] of Object.entries(local[STORAGE_PROGRESS_KEY])) {
      if (weeklyIds.has(videoId)) prunedProgress[videoId] = entry;
    }
    const slim = slimProgressForSync(prunedProgress);
    if (Object.keys(slim).length > 0) {
      toPush[STORAGE_PROGRESS_KEY] = slim;
    }
  }
  // Daily state: push the merge of local ∪ sync whenever it differs from sync,
  // so this device's progress reaches sync (covers both "sync missing it" and
  // "local has watch-seconds/videos sync doesn't").
  {
    const localDaily = local[STORAGE_DAILY_STATE_KEY];
    const syncDaily = sync[STORAGE_DAILY_STATE_KEY];
    if (localDaily && typeof localDaily === "object" && localDaily.dayKey) {
      const merged = mergeDailyState(typeof syncDaily === "object" ? syncDaily : null, localDaily, await currentDayKey());
      if (merged && JSON.stringify(merged) !== JSON.stringify(syncDaily)) {
        toPush[STORAGE_DAILY_STATE_KEY] = merged;
      }
    }
  }

  if (Object.keys(toPush).length > 0) {
    await priorityWriteSync(toPush, {
      evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY]
    });
  }
}

// This device's current day key (local time + refreshHour). Passed to the
// daily-state merges so a sibling already in the next local day can't wipe the
// day this device is still accumulating.
async function currentDayKey() {
  return getDailyDayKey(await getSettings());
}

// Push the local daily state to sync - called debounced/immediately from the
// watch tab (see content.js scheduleDailyStateSync). Reads sync FIRST and pushes
// the MERGE so a concurrent peer's bucket is never clobbered (matches the other
// three daily-state sync paths). allowEvict only on the enforcement-critical
// immediate push - a routine seconds bump must not evict the durable weekly
// grid / watched / progress keys (they'd just re-push on the next hydrate = pure
// thrash for a 1-second counter delta).
async function pushDailyStateToSync({ allowEvict = false } = {}) {
  try {
    const local = await chrome.storage.local.get([STORAGE_DAILY_STATE_KEY]);
    const state = local[STORAGE_DAILY_STATE_KEY];
    if (!state || typeof state !== "object" || !state.dayKey) return;
    const cur = await chrome.storage.sync.get([STORAGE_DAILY_STATE_KEY]);
    const syncDaily = cur[STORAGE_DAILY_STATE_KEY];
    const merged = mergeDailyState(typeof syncDaily === "object" ? syncDaily : null, state, await currentDayKey());
    if (!merged) return;
    if (typeof syncDaily === "object" && JSON.stringify(merged) === JSON.stringify(syncDaily)) return;
    await priorityWriteSync(
      { [STORAGE_DAILY_STATE_KEY]: merged },
      { evictKeysInOrder: allowEvict ? [STORAGE_VIDEOS_KEY, STORAGE_WATCHED_VIDEOS_KEY, STORAGE_PROGRESS_KEY] : [] }
    );
  } catch (_) {}
}

// Serialize sync->local reconciliation. applySyncChangeToLocal does a
// read-modify-write across several keys; two sync events (or a concurrent
// local write) interleaving between its reads and its final write would let
// the later write clobber the earlier merge, losing hidden/watched IDs or
// settings. Route every invocation through this chain so they run one at a
// time - same pattern as modifyHidden/modifyWatched.
let _syncChangeChain = Promise.resolve();
function queueSyncChange(changes) {
  _syncChangeChain = _syncChangeChain.then(
    () => applySyncChangeToLocal(changes),
    () => applySyncChangeToLocal(changes)
  );
  return _syncChangeChain.catch(() => {});
}

async function applySyncChangeToLocal(changes) {
  const candidates = {};
  if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
    const incoming = sanitizeSettings(changes[SETTINGS_KEY].newValue);
    const localData = await chrome.storage.local.get([SETTINGS_KEY]);
    const localSettings = localData[SETTINGS_KEY];
    const incomingAt = Number(incoming._updatedAt) || 0;
    const localAt = Number(localSettings?._updatedAt) || 0;
    if (!localSettings || incomingAt > localAt) {
      candidates[SETTINGS_KEY] = incoming;
    }
  }

  // Sync newValue is either an array of IDs (slim) or full objects (legacy);
  // videosFromSyncPayload normalizes both into local stub/full objects.
  const incomingVideos =
    changes[STORAGE_VIDEOS_KEY] && Array.isArray(changes[STORAGE_VIDEOS_KEY].newValue)
      ? videosFromSyncPayload(changes[STORAGE_VIDEOS_KEY].newValue)
      : null;
  const incomingRefresh =
    changes[STORAGE_REFRESH_AFTER_KEY] && typeof changes[STORAGE_REFRESH_AFTER_KEY].newValue === "number"
      ? changes[STORAGE_REFRESH_AFTER_KEY].newValue
      : null;

  if (incomingVideos || incomingRefresh !== null) {
    const localVideoState = await chrome.storage.local.get([
      STORAGE_VIDEOS_KEY,
      STORAGE_REFRESH_AFTER_KEY
    ]);
    const localRefresh = localVideoState[STORAGE_REFRESH_AFTER_KEY];
    const incomingIsNewer =
      typeof incomingRefresh === "number" &&
      (typeof localRefresh !== "number" || incomingRefresh > localRefresh);
    const localHasVideos =
      Array.isArray(localVideoState[STORAGE_VIDEOS_KEY]) &&
      localVideoState[STORAGE_VIDEOS_KEY].length > 0;

    if (incomingVideos && incomingVideos.length > 0 && (!localHasVideos || incomingIsNewer)) {
      candidates[STORAGE_VIDEOS_KEY] = incomingVideos;
    }
    if (incomingRefresh !== null && (typeof localRefresh !== "number" || incomingRefresh > localRefresh)) {
      candidates[STORAGE_REFRESH_AFTER_KEY] = incomingRefresh;
    }
  }

  const candidateKeys = Object.keys(candidates);
  const hiddenVideosIncoming =
    changes[STORAGE_HIDDEN_VIDEOS_KEY] && Array.isArray(changes[STORAGE_HIDDEN_VIDEOS_KEY].newValue);
  const hiddenChannelsIncoming =
    changes[STORAGE_HIDDEN_CHANNELS_KEY] && Array.isArray(changes[STORAGE_HIDDEN_CHANNELS_KEY].newValue);
  const watchedVideosIncoming =
    changes[STORAGE_WATCHED_VIDEOS_KEY] && Array.isArray(changes[STORAGE_WATCHED_VIDEOS_KEY].newValue);
  const progressIncoming =
    changes[STORAGE_PROGRESS_KEY] &&
    changes[STORAGE_PROGRESS_KEY].newValue &&
    typeof changes[STORAGE_PROGRESS_KEY].newValue === "object";
  const dailyStateIncoming =
    changes[STORAGE_DAILY_STATE_KEY] &&
    changes[STORAGE_DAILY_STATE_KEY].newValue &&
    typeof changes[STORAGE_DAILY_STATE_KEY].newValue === "object";

  const readKeys = [...candidateKeys];
  if (hiddenVideosIncoming) readKeys.push(STORAGE_HIDDEN_VIDEOS_KEY);
  if (hiddenChannelsIncoming) readKeys.push(STORAGE_HIDDEN_CHANNELS_KEY);
  if (watchedVideosIncoming) readKeys.push(STORAGE_WATCHED_VIDEOS_KEY);
  if (progressIncoming) readKeys.push(STORAGE_PROGRESS_KEY);
  if (dailyStateIncoming) readKeys.push(STORAGE_DAILY_STATE_KEY);
  if (readKeys.length === 0) return;

  const local = await chrome.storage.local.get(readKeys);
  const updates = {};

  for (const key of candidateKeys) {
    if (JSON.stringify(local[key]) !== JSON.stringify(candidates[key])) {
      updates[key] = candidates[key];
    }
  }

  if (hiddenVideosIncoming) {
    const localList = Array.isArray(local[STORAGE_HIDDEN_VIDEOS_KEY])
      ? local[STORAGE_HIDDEN_VIDEOS_KEY]
      : [];
    const merged = capSyncedIdList(mergeHiddenIds(localList, changes[STORAGE_HIDDEN_VIDEOS_KEY].newValue));
    // Compare content, not length: at MAX_HIDDEN_PER_TYPE the union + cap-trim
    // can change WHICH ids are present while the count stays identical.
    if (JSON.stringify(merged) !== JSON.stringify(localList)) {
      updates[STORAGE_HIDDEN_VIDEOS_KEY] = merged;
    }
  }
  if (hiddenChannelsIncoming) {
    const localList = Array.isArray(local[STORAGE_HIDDEN_CHANNELS_KEY])
      ? local[STORAGE_HIDDEN_CHANNELS_KEY]
      : [];
    // Expand sync-shrunk channel keys back to full URLs before merging.
    const incoming = changes[STORAGE_HIDDEN_CHANNELS_KEY].newValue.map(expandChannelKey);
    const merged = capSyncedIdList(mergeHiddenIds(localList, incoming));
    if (JSON.stringify(merged) !== JSON.stringify(localList)) {
      updates[STORAGE_HIDDEN_CHANNELS_KEY] = merged;
    }
  }
  if (watchedVideosIncoming) {
    const localList = Array.isArray(local[STORAGE_WATCHED_VIDEOS_KEY])
      ? local[STORAGE_WATCHED_VIDEOS_KEY]
      : [];
    const merged = capSyncedIdList(mergeHiddenIds(localList, changes[STORAGE_WATCHED_VIDEOS_KEY].newValue));
    if (JSON.stringify(merged) !== JSON.stringify(localList)) {
      updates[STORAGE_WATCHED_VIDEOS_KEY] = merged;
    }
  }
  if (progressIncoming) {
    const localMap =
      local[STORAGE_PROGRESS_KEY] && typeof local[STORAGE_PROGRESS_KEY] === "object"
        ? local[STORAGE_PROGRESS_KEY]
        : {};
    const merged = mergeProgressMaps(localMap, changes[STORAGE_PROGRESS_KEY].newValue);
    if (JSON.stringify(merged) !== JSON.stringify(localMap)) {
      updates[STORAGE_PROGRESS_KEY] = merged;
    }
  }
  if (dailyStateIncoming) {
    const localDaily =
      local[STORAGE_DAILY_STATE_KEY] && typeof local[STORAGE_DAILY_STATE_KEY] === "object"
        ? local[STORAGE_DAILY_STATE_KEY]
        : null;
    const merged = mergeDailyState(localDaily, changes[STORAGE_DAILY_STATE_KEY].newValue, await currentDayKey());
    if (merged && JSON.stringify(merged) !== JSON.stringify(localDaily)) {
      updates[STORAGE_DAILY_STATE_KEY] = merged;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

/* ---------- HTTP-FETCH HOME PARSER ---------- */
// Used by the primary refresh path (HTTP fetch of youtube.com instead of
// the visible bounce + DOM scrape). The fetch itself runs in the background
// script - content-script fetch is unreliable in Firefox (privacy/tracking
// protection treats the extension-origin fetch as cross-origin and
// intermittently aborts it). Background returns the raw HTML; parsing lives
// here so the same code is reachable from background, content, and tests.

const YT_INITIAL_DATA_RE = /var ytInitialData\s*=\s*({.+?});\s*<\/script>/s;

function normalizeRelativeYouTubeUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return "https://www.youtube.com" + href;
}

// Parses one lockupViewModel node from ytInitialData into the same shape
// the DOM scraper produces. Returns null when the lockup is an ad, a
// non-video (playlist / channel mix / shelf), or is missing the fields
// we need.
function parseLockupViewModel(lockup) {
  if (!lockup) return null;
  if (lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  if (!lockup.contentId) return null;
  // feedAdMetadataViewModel is the giveaway for the (rare) ad lockups
  // that share the LOCKUP_CONTENT_TYPE_VIDEO type.
  if (lockup.metadata?.feedAdMetadataViewModel) return null;

  const meta = lockup.metadata?.lockupMetadataViewModel;
  if (!meta) return null;

  const videoId = lockup.contentId;
  const title = meta.title?.content;
  if (!title) return null;

  // metadataRows[0] is the channel row; metadataRows[1] is "views • date".
  // YouTube very occasionally inserts an extra row (chapters, "Recommended
  // for you" reason) - identify content by regex on the text, not by index.
  const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || [];
  let channelName = "";
  let channelUrl = "";
  let views = "";
  let date = "";
  for (const row of rows) {
    const parts = row?.metadataParts || [];
    for (const part of parts) {
      const text = part?.text?.content || "";
      if (!text) continue;
      const handleUrl =
        part?.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.commandMetadata
          ?.webCommandMetadata?.url;
      // Only accept handle / channel / legacy-c URLs as the channel link.
      // YouTube occasionally inserts other tap-target rows (hashtags, topics,
      // playlists) before the channel byline, and those have webCommandMetadata.url
      // too. Gating on the path prefix prevents storing one as the channel.
      if (handleUrl && !channelName && /^\/(@|channel\/|c\/)/.test(handleUrl)) {
        channelName = text;
        // Make the URL absolute so hidden-channel matching (which keys on
        // channelUrl) compares equal regardless of which refresh path produced it.
        channelUrl = normalizeRelativeYouTubeUrl(handleUrl);
        continue;
      }
      // Require a digit so a channel byline that fell through the URL-gated
      // branch above (a channel row YouTube shipped without a tap URL) can't be
      // misread as a stat - e.g. a channel named "Chicago" matching /ago/ or
      // "Tech Reviews" matching /views/. Real view/date strings always carry a
      // number ("1.2M views", "3 days ago", "Premiered Jan 5, 2024").
      if (!views && /\d/.test(text) && /views|watching/i.test(text)) { views = text; continue; }
      if (!date && /\d/.test(text) && /ago|streamed|premiered|premieres/i.test(text)) {
        date = text;
        continue;
      }
    }
  }
  const metadata = views && date ? `${views} • ${date}` : (views || date || "");

  // Duration / live badge sits in the thumbnail bottom overlay. "LIVE",
  // "PREMIERE", or "UPCOMING" text here means the video itself is live -
  // distinct from the channel's live ring on the avatar (decoratedAvatarViewModel
  // .liveData.liveBadgeText) which only signals the channel is live, possibly
  // on a different video.
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
  let durationText = "";
  for (const overlay of overlays) {
    const badges = overlay.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const text = badge.thumbnailBadgeViewModel?.text;
      if (text) { durationText = text; break; }
    }
    if (durationText) break;
  }
  const isLive = /^(LIVE|PREMIERE|UPCOMING)$/i.test(durationText);
  const duration = isLive ? "" : durationText;

  const avatarSources =
    meta.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources || [];
  const avatar = avatarSources[0]?.url || "";

  return {
    videoId,
    title,
    duration,
    channelName,
    channelUrl,
    metadata,
    avatar,
    membersOnly: false,
    membersOnlyCheckedAt: Date.now(),
    isLive
  };
}

// Full pipeline: HTML response from youtube.com → ytInitialData JSON →
// walk for lockupViewModel nodes → per-lockup parse → deduped video array.
// Throws if ytInitialData isn't present in the response (no match for the
// regex - typical with a consent wall, 429, or a fundamentally different
// page).
function extractVideosFromYouTubeHomeHtml(html) {
  const m = html.match(YT_INITIAL_DATA_RE);
  if (!m) throw new Error("no ytInitialData in response");
  const data = JSON.parse(m[1]);

  // Track whether we're inside a richSectionRenderer subtree: those are
  // YouTube's injected shelf sections ("Breaking news", Trending, Shorts
  // shelves, …) - editorial/topical content, NOT the user's recommendation
  // feed (feed videos are richItemRenderers sitting directly in the grid).
  // Shelf videos are collected separately and only used as a defensive
  // fallback: if YouTube restructures the page so nothing parses outside a
  // section, a full grid with shelves beats a failed refresh.
  const feedLockups = [];
  const shelfLockups = [];
  (function walk(node, inShelf) {
    if (!node || typeof node !== "object") return;
    if (node.lockupViewModel) {
      (inShelf ? shelfLockups : feedLockups).push(node.lockupViewModel);
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inShelf);
      return;
    }
    for (const k of Object.keys(node)) {
      walk(node[k], inShelf || k === "richSectionRenderer");
    }
  })(data, false);
  const lockups = feedLockups.length > 0 ? feedLockups : shelfLockups;

  const videos = [];
  const seen = new Set();
  for (const lockup of lockups) {
    const video = parseLockupViewModel(lockup);
    if (!video) continue;
    if (seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    videos.push(video);
  }
  return videos;
}

/* ---------- WEEKLY GRID - PURE HELPERS (shared by background + content) ---------- */
// These live here (not content.js) because the background owns the refresh:
// it filters/picks videos before saving. They are pure (no DOM, no chrome.*
// beyond getStoredWeeklyVideos) so both contexts can call them.

// Non-DOM HTML-entity decoder. content.js has a textarea-based decodeHtml for
// rich render-time decoding, but that needs the DOM; the background can't use
// it. This covers the entities that actually appear in channel names/URLs for
// hidden-item matching: named basics + numeric (decimal and hex) refs.
function decodeHtmlEntities(value) {
  if (!value) return "";
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

async function getStoredWeeklyVideos() {
  const data = await chrome.storage.local.get([
    STORAGE_VIDEOS_KEY,
    STORAGE_REFRESH_AFTER_KEY
  ]);
  return {
    videos: data[STORAGE_VIDEOS_KEY],
    refreshAfter: data[STORAGE_REFRESH_AFTER_KEY]
  };
}

function getNextRefreshTime(settings, fromDate = new Date(getNow())) {
  const mode = settings.refreshMode || "weekly";
  const refreshHour = settings.refreshHour;

  if (mode === "daily") {
    const next = new Date(fromDate);
    next.setHours(refreshHour, 0, 0, 0);
    if (next <= fromDate) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  const days =
    mode === "multi" &&
    Array.isArray(settings.refreshDays) &&
    settings.refreshDays.length > 0
      ? settings.refreshDays
      : [settings.refreshDay];

  let best = Infinity;
  for (const day of days) {
    const candidate = new Date(fromDate);
    const daysUntil = (day - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + daysUntil);
    candidate.setHours(refreshHour, 0, 0, 0);
    if (candidate <= fromDate) {
      candidate.setDate(candidate.getDate() + 7);
    }
    if (candidate.getTime() < best) best = candidate.getTime();
  }
  return best;
}

function isVideoHidden(video, hidden) {
  if (!video) return true;

  if (video.videoId && hidden.videos.has(video.videoId)) {
    return true;
  }

  const channelUrl = decodeHtmlEntities(video.channelUrl || "").trim().toLowerCase();
  if (channelUrl && hidden.channels.has(channelUrl)) {
    return true;
  }

  const channelName = decodeHtmlEntities(video.channelName || "").trim().toLowerCase();
  if (channelName && hidden.channels.has(`name:${channelName}`)) {
    return true;
  }

  return false;
}

function filterHiddenVideos(videos, hidden) {
  return (Array.isArray(videos) ? videos : []).filter(video => {
    return !isVideoHidden(video, hidden);
  });
}

// Pick the weekly grid: dedupe, prefer fully-populated entries (have
// view-count metadata + avatar + duration) then backfill to videoCount.
// Hidden filtering is the CALLER's job (background.js pre-filters the pool
// with filterHiddenVideos before choosing) - no hidden param here, so the
// filter can't silently run twice.
function chooseWeeklyVideos(videos, videoCount) {
  const seen = new Set();

  const valid = videos.filter(video => {
    if (!video.title || !video.videoId) return false;
    if (seen.has(video.videoId)) return false;

    seen.add(video.videoId);
    return true;
  });

  const complete = valid.filter(video =>
    video.metadata &&
    /views/i.test(video.metadata) &&
    video.avatar &&
    video.duration
  );

  const chosen = [...complete];

  for (const video of valid) {
    if (chosen.length >= videoCount) break;
    if (!chosen.some(existing => existing.videoId === video.videoId)) {
      chosen.push(video);
    }
  }

  return chosen.slice(0, videoCount);
}

/* ---------- SHARED UI HELPERS (options + popup) ---------- */
// Both the options page and the popup show a transient "#status" toast and
// render hidden-channel labels; these were duplicated in options.js + popup.js.
// They live here so there's one copy. (Harmless in content/background contexts,
// which simply never call them.)

function showStatus(message, isSuccess = true) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = message;
  status.className = `status show ${isSuccess ? "success" : "info"}`;
  setTimeout(() => {
    status.classList.remove("show");
  }, 2000);
}

// Hidden channels are stored by their channelUrl. There's no oEmbed endpoint
// for channels, but the URL itself almost always carries a @handle or UC id
// that's a usable display label.
function channelDisplayFromKey(key) {
  if (!key) return null;
  const handle = key.match(/@([^/?#&]+)/);
  if (handle) return `@${handle[1]}`;
  const ucId = key.match(/\/channel\/(UC[^/?#&]+)/i);
  if (ucId) return ucId[1];
  // name:-fallback keys (channels hidden before a URL was known) carry the
  // display name directly. Previously only popup.js applied this tier, so the
  // same hidden channel labelled "foo" there but "Hidden channel" in options.
  if (key.startsWith("name:")) return key.slice(5);
  // Last resort for URL-form keys with no handle/UC id (e.g. legacy
  // /c/<name>): the final path segment beats showing the whole raw URL.
  if (key.includes("/")) return key.split("/").filter(Boolean).pop() || null;
  return null;
}

// Backfill titles for hidden videos whose metadata didn't survive (typical
// after a reinstall - the hidden ID lists sync, their metadata blob doesn't).
// ONE copy shared by options.js and popup.js (they were verbatim duplicates,
// differing only in which list re-render they triggered - hence onUpdated).
// Results persist via modifyHidden so the next render reads them from storage
// and the recovered metadata syncs back across devices. Ids with no oEmbed
// data (deleted/private/age-gated) are negative-cached via _oembedFailed so
// they aren't re-fetched on every render; the marker clears automatically
// when the item is unhidden (its metadata entry is deleted).
async function backfillMissingHiddenVideoMetadata(onUpdated) {
  const { videos, metadata } = await getHiddenItemsWithMetadata();
  const existing = metadata || {};
  const missing = [...videos].filter(id => id && !existing[id]?.title && !existing[id]?._oembedFailed);
  if (missing.length === 0) return;

  const fetched = {};
  const failed = [];
  for (let i = 0; i < missing.length; i += OEMBED_CONCURRENCY) {
    const batch = missing.slice(i, i + OEMBED_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchVideoMetadataFromOEmbed));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) fetched[batch[j]] = results[j];
      else failed.push(batch[j]);
    }
  }
  if (Object.keys(fetched).length === 0 && failed.length === 0) return;

  await modifyHidden(state => {
    if (!state.metadata) state.metadata = {};
    for (const [id, m] of Object.entries(fetched)) {
      if (!state.metadata[id]?.title) state.metadata[id] = { type: "video", ...m };
    }
    for (const id of failed) {
      if (!state.metadata[id]?.title) {
        state.metadata[id] = { ...(state.metadata[id] || {}), type: "video", title: "", _oembedFailed: true };
      }
    }
  });
  if (Object.keys(fetched).length > 0 && typeof onUpdated === "function") {
    await onUpdated();
  }
}
