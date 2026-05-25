// =============================================================================
// shared.js — storage, settings, and cross-page primitives.
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
//   - hydrateFromSync / applySyncChangeToLocal — the two halves of the
//     local <-> sync reconciler
//   - getNow() and loadFakeNowOffset() — fake-time injection for debug
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
const MODE_LOCALSTORAGE_KEY = "betterFeedMode";

// One-shot rebrand migration: the chrome.storage keys and the localStorage
// mode mirror were originally prefixed ytWeekly* (the project's old name).
// If a device still has the old keys present, copy them to the new keys and
// remove the old ones. Idempotent — once the old keys are gone this is a
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
      // Don't clobber a value that's already at the new key — the destination
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

function getNow() {
  return Date.now() + _fakeNowOffsetMs;
}

async function loadFakeNowOffset() {
  try {
    const data = await chrome.storage.local.get([STORAGE_FAKE_NOW_OFFSET_KEY]);
    const value = Number(data[STORAGE_FAKE_NOW_OFFSET_KEY]);
    _fakeNowOffsetMs = Number.isFinite(value) ? value : 0;
  } catch (_) {
    _fakeNowOffsetMs = 0;
  }
  return _fakeNowOffsetMs;
}

function applyFakeNowOffsetChange(changes) {
  if (!changes || !(STORAGE_FAKE_NOW_OFFSET_KEY in changes)) return;
  const value = Number(changes[STORAGE_FAKE_NOW_OFFSET_KEY].newValue);
  _fakeNowOffsetMs = Number.isFinite(value) ? value : 0;
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

const SYNC_KEYS = [
  SETTINGS_KEY,
  STORAGE_VIDEOS_KEY,
  STORAGE_REFRESH_AFTER_KEY,
  STORAGE_HIDDEN_VIDEOS_KEY,
  STORAGE_HIDDEN_CHANNELS_KEY,
  // STORAGE_HIDDEN_METADATA_KEY intentionally NOT synced — recovered on the
  // options/popup page via the YouTube oEmbed backfill (saves ~8 KB).
  STORAGE_WATCHED_VIDEOS_KEY,
  STORAGE_PROGRESS_KEY
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

function isQuotaError(err) {
  const msg = String(err?.message || err || "");
  return /quota|QUOTA/i.test(msg);
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
  if (await safeSyncSet(items)) return true;
  for (const key of priority.evictKeysInOrder) {
    await safeSyncRemove([key]);
    if (await safeSyncSet(items)) return true;
  }
  return false;
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

function sanitizeSettings(settings) {
  const refreshDay = Number(settings?.refreshDay);
  const refreshHour = Number(settings?.refreshHour);
  const videoCount = Number(settings?.videoCount);
  const updatedAt = Number(settings?._updatedAt);

  return {
    _updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
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
    refreshDay:
      Number.isInteger(refreshDay) && refreshDay >= 0 && refreshDay <= 6
        ? refreshDay
        : DEFAULT_SETTINGS.refreshDay,
    refreshDays: Array.isArray(settings?.refreshDays)
      ? [
          ...new Set(
            settings.refreshDays
              .map(d => Number(d))
              .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          )
        ].sort((a, b) => a - b)
      : [...DEFAULT_SETTINGS.refreshDays],
    refreshHour:
      Number.isInteger(refreshHour) && refreshHour >= 0 && refreshHour <= 23
        ? refreshHour
        : DEFAULT_SETTINGS.refreshHour,
    videoCount:
      Number.isInteger(videoCount) && videoCount >= 1 && videoCount <= MAX_WEEKLY_VIDEOS
        ? videoCount
        : Math.min(DEFAULT_SETTINGS.videoCount, MAX_WEEKLY_VIDEOS),
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
    maxVideosPerDay:
      Number.isInteger(Number(settings?.maxVideosPerDay)) && Number(settings.maxVideosPerDay) >= 1
        ? Number(settings.maxVideosPerDay)
        : DEFAULT_SETTINGS.maxVideosPerDay,
    maxSecondsPerDay:
      Number.isFinite(Number(settings?.maxSecondsPerDay)) && Number(settings.maxSecondsPerDay) >= 1
        ? Number(settings.maxSecondsPerDay)
        : DEFAULT_SETTINGS.maxSecondsPerDay,
    workCustomMinutes:
      Number.isInteger(Number(settings?.workCustomMinutes)) &&
      Number(settings.workCustomMinutes) >= 1 &&
      Number(settings.workCustomMinutes) <= 60 * 24
        ? Number(settings.workCustomMinutes)
        : DEFAULT_SETTINGS.workCustomMinutes
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

function emptyDailyState(dayKey) {
  return { dayKey, videoIds: [], secondsWatched: 0 };
}

async function getDailyState(settings) {
  const data = await chrome.storage.local.get([STORAGE_DAILY_STATE_KEY]);
  const todayKey = getDailyDayKey(settings);
  const stored = data[STORAGE_DAILY_STATE_KEY];
  if (!stored || stored.dayKey !== todayKey) {
    return emptyDailyState(todayKey);
  }
  return {
    dayKey: stored.dayKey,
    videoIds: Array.isArray(stored.videoIds) ? stored.videoIds : [],
    secondsWatched: typeof stored.secondsWatched === "number" ? stored.secondsWatched : 0
  };
}

async function saveDailyState(state) {
  await chrome.storage.local.set({ [STORAGE_DAILY_STATE_KEY]: state });
}

function isDailyLimitHit(state, settings) {
  if (!settings.dailyLimitEnabled) return false;
  const mode = settings.dailyLimitMode || "both";
  if (mode !== "time" && (state.videoIds?.length || 0) >= settings.maxVideosPerDay) return true;
  if (mode !== "videos" && (state.secondsWatched || 0) >= settings.maxSecondsPerDay) return true;
  return false;
}

function isDailyVideoQuotaReached(state, settings) {
  if (!settings.dailyLimitEnabled) return false;
  const mode = settings.dailyLimitMode || "both";
  if (mode === "time") return false;
  return (state.videoIds?.length || 0) >= settings.maxVideosPerDay;
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
    if (!locationLike || locationLike.pathname !== "/watch") return false;
    const params = new URLSearchParams(locationLike.search || "");
    return params.get("v") === grace.videoId;
  }
  return false;
}

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
//  - Timed: `{ startedAt, endsAt, durationMinutes }` — Watch is locked until
//    endsAt. Session ends automatically when endsAt is reached.
//  - No-time: `{ startedAt, noTime: true }` — session has no end. Watch lock
//    is dynamic: a 10-second grace period after startedAt where the user can
//    still bail, then a 20-minute lock window, then no lock (session itself
//    keeps running until the user manually ends it).
// Stored local-only — the session is a per-device focus state, not
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
    // No-grace sessions skip the 10-second grace window — the Watch lock
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
  clean._updatedAt = Date.now();
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

async function getHiddenItems() {
  const data = await chrome.storage.local.get([
    STORAGE_HIDDEN_VIDEOS_KEY,
    STORAGE_HIDDEN_CHANNELS_KEY
  ]);

  const videos = Array.isArray(data[STORAGE_HIDDEN_VIDEOS_KEY])
    ? data[STORAGE_HIDDEN_VIDEOS_KEY]
    : [];
  const channels = Array.isArray(data[STORAGE_HIDDEN_CHANNELS_KEY])
    ? data[STORAGE_HIDDEN_CHANNELS_KEY]
    : [];

  return {
    videos: new Set(videos.filter(Boolean)),
    channels: new Set(channels.filter(Boolean))
  };
}

async function getHiddenItemsWithMetadata() {
  const data = await chrome.storage.local.get([
    STORAGE_HIDDEN_VIDEOS_KEY,
    STORAGE_HIDDEN_CHANNELS_KEY,
    STORAGE_HIDDEN_METADATA_KEY
  ]);

  const videos = Array.isArray(data[STORAGE_HIDDEN_VIDEOS_KEY])
    ? data[STORAGE_HIDDEN_VIDEOS_KEY]
    : [];
  const channels = Array.isArray(data[STORAGE_HIDDEN_CHANNELS_KEY])
    ? data[STORAGE_HIDDEN_CHANNELS_KEY]
    : [];

  return {
    videos: new Set(videos.filter(Boolean)),
    channels: new Set(channels.filter(Boolean)),
    metadata: data[STORAGE_HIDDEN_METADATA_KEY] || {}
  };
}

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
  // Strip the YouTube origin from channel URLs for sync — expanded again on
  // hydrate. Keeps the per-item blob small.
  const syncChannels = channelIds
    .slice(-SYNC_HIDDEN_CHANNELS_CAP)
    .map(shrinkChannelKey);
  await priorityWriteSync(
    {
      [STORAGE_HIDDEN_VIDEOS_KEY]: syncVideos,
      [STORAGE_HIDDEN_CHANNELS_KEY]: syncChannels
    },
    { evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY] }
  );
  // Drop any legacy metadata blob left over in sync from older builds —
  // we now rebuild via the oEmbed backfill instead of carrying it through.
  safeSyncRemove([STORAGE_HIDDEN_METADATA_KEY]).catch(() => {});
}

let hiddenWriteChain = Promise.resolve();

function modifyHidden(modifyFn) {
  const run = async () => {
    const state = await getHiddenItemsWithMetadata();
    await modifyFn(state);
    await persistHiddenState(state);
    return state;
  };
  const next = hiddenWriteChain.then(run, run);
  hiddenWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

async function getWatchedVideos() {
  const data = await chrome.storage.local.get([STORAGE_WATCHED_VIDEOS_KEY]);
  const list = Array.isArray(data[STORAGE_WATCHED_VIDEOS_KEY])
    ? data[STORAGE_WATCHED_VIDEOS_KEY]
    : [];
  return new Set(list.filter(Boolean));
}

let watchedWriteChain = Promise.resolve();

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
  const next = watchedWriteChain.then(run, run);
  watchedWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

async function getVideoProgressMap() {
  const data = await chrome.storage.local.get([STORAGE_PROGRESS_KEY]);
  const map = data[STORAGE_PROGRESS_KEY];
  return map && typeof map === "object" ? map : {};
}

let progressWriteChain = Promise.resolve();

// Locally, progress entries are `{ position, duration }` in seconds — duration
// is convenient for fast bar rendering without re-parsing the formatted
// duration string from the weekly video meta.
// In sync we only carry the position (a bare number) since duration is
// always recoverable from the weekly grid's `duration` field. Renderers and
// the merge logic accept both shapes.
function isValidProgressEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.position === "number" &&
    isFinite(entry.position) &&
    typeof entry.duration === "number" &&
    isFinite(entry.duration) &&
    entry.duration > 0
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
      // Round to integer seconds — the bar is sub-pixel anyway.
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
  const next = progressWriteChain.then(run, run);
  progressWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

function clearVideoProgress(videoId) {
  const run = async () => {
    if (!videoId) return;
    const map = await getVideoProgressMap();
    if (!(videoId in map)) return;
    delete map[videoId];
    await chrome.storage.local.set({ [STORAGE_PROGRESS_KEY]: map });
  };
  const next = progressWriteChain.then(run, run);
  progressWriteChain = next.then(() => undefined, () => undefined);
  return next;
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
// "exit" signals (SPA-navigate away, pagehide) — not on every tick.
//
// Also prunes entries against the current week's grid before writing — both
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

    // Sync ships positions as bare numbers — duration is recoverable from the
    // weekly grid at render time.
    const slim = slimProgressForSync(pruned);
    await priorityWriteSync(
      { [STORAGE_PROGRESS_KEY]: slim },
      { evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY] }
    );
  };
  const next = progressWriteChain.then(run, run);
  progressWriteChain = next.then(() => undefined, () => undefined);
  return next;
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
  // Past live stream replays — YouTube tags them with "Streamed N units ago"
  // in place of the upload-time line. Require a digit so a stray title-bleed
  // containing the word "streamed" can't false-positive a regular video.
  if (/\bstreamed\s+\d+\b/i.test(meta)) return true;
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
// (the slim format) — title/channelName/etc. are populated later by the
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

  // New week's grid is in storage — last week's watched flags are now stale,
  // so flush them. Routed through modifyWatched so it serializes against any
  // in-flight user-driven watched write and also clears the synced copy.
  await modifyWatched(set => set.clear());
  // Same goes for per-video playback progress.
  await chrome.storage.local.remove(STORAGE_PROGRESS_KEY);
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
    STORAGE_PROGRESS_KEY
  ]);

  if (Array.isArray(sync[STORAGE_HIDDEN_VIDEOS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_HIDDEN_VIDEOS_KEY])
      ? localLists[STORAGE_HIDDEN_VIDEOS_KEY]
      : [];
    updates[STORAGE_HIDDEN_VIDEOS_KEY] = mergeHiddenIds(localList, sync[STORAGE_HIDDEN_VIDEOS_KEY]);
  }
  if (Array.isArray(sync[STORAGE_HIDDEN_CHANNELS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_HIDDEN_CHANNELS_KEY])
      ? localLists[STORAGE_HIDDEN_CHANNELS_KEY]
      : [];
    // Expand any sync-shrunk channel keys back to full URLs before merging.
    const incoming = sync[STORAGE_HIDDEN_CHANNELS_KEY].map(expandChannelKey);
    updates[STORAGE_HIDDEN_CHANNELS_KEY] = mergeHiddenIds(localList, incoming);
  }
  if (Array.isArray(sync[STORAGE_WATCHED_VIDEOS_KEY])) {
    const localList = Array.isArray(localLists[STORAGE_WATCHED_VIDEOS_KEY])
      ? localLists[STORAGE_WATCHED_VIDEOS_KEY]
      : [];
    updates[STORAGE_WATCHED_VIDEOS_KEY] = mergeHiddenIds(localList, sync[STORAGE_WATCHED_VIDEOS_KEY]);
  }
  if (sync[STORAGE_PROGRESS_KEY] && typeof sync[STORAGE_PROGRESS_KEY] === "object") {
    const localMap =
      localLists[STORAGE_PROGRESS_KEY] && typeof localLists[STORAGE_PROGRESS_KEY] === "object"
        ? localLists[STORAGE_PROGRESS_KEY]
        : {};
    updates[STORAGE_PROGRESS_KEY] = mergeProgressMaps(localMap, sync[STORAGE_PROGRESS_KEY]);
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
    STORAGE_PROGRESS_KEY
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
    toPush[STORAGE_PROGRESS_KEY] = local[STORAGE_PROGRESS_KEY];
  }

  if (Object.keys(toPush).length > 0) {
    await priorityWriteSync(toPush, {
      evictKeysInOrder: [STORAGE_HIDDEN_CHANNELS_KEY, STORAGE_HIDDEN_VIDEOS_KEY]
    });
  }
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

  const readKeys = [...candidateKeys];
  if (hiddenVideosIncoming) readKeys.push(STORAGE_HIDDEN_VIDEOS_KEY);
  if (hiddenChannelsIncoming) readKeys.push(STORAGE_HIDDEN_CHANNELS_KEY);
  if (watchedVideosIncoming) readKeys.push(STORAGE_WATCHED_VIDEOS_KEY);
  if (progressIncoming) readKeys.push(STORAGE_PROGRESS_KEY);
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
    const merged = mergeHiddenIds(localList, changes[STORAGE_HIDDEN_VIDEOS_KEY].newValue);
    if (merged.length !== localList.length) {
      updates[STORAGE_HIDDEN_VIDEOS_KEY] = merged;
    }
  }
  if (hiddenChannelsIncoming) {
    const localList = Array.isArray(local[STORAGE_HIDDEN_CHANNELS_KEY])
      ? local[STORAGE_HIDDEN_CHANNELS_KEY]
      : [];
    // Expand sync-shrunk channel keys back to full URLs before merging.
    const incoming = changes[STORAGE_HIDDEN_CHANNELS_KEY].newValue.map(expandChannelKey);
    const merged = mergeHiddenIds(localList, incoming);
    if (merged.length !== localList.length) {
      updates[STORAGE_HIDDEN_CHANNELS_KEY] = merged;
    }
  }
  if (watchedVideosIncoming) {
    const localList = Array.isArray(local[STORAGE_WATCHED_VIDEOS_KEY])
      ? local[STORAGE_WATCHED_VIDEOS_KEY]
      : [];
    const merged = mergeHiddenIds(localList, changes[STORAGE_WATCHED_VIDEOS_KEY].newValue);
    if (merged.length !== localList.length) {
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

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}
