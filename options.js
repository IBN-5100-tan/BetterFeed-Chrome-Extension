// =============================================================================
// options.js — full-tab options page logic.
//
// The page is divided into nav pages: Refresh, Cleanup, Daily limit, Hidden
// videos, Advanced, Debug. Each page is a <section class="page"> in
// options.html and is shown/hidden via activatePage().
//
// Settings persistence is auto-save: form fields listed in AUTO_SAVE_FIELDS
// fire `change` -> autoSave() -> sanitizeSettings -> chrome.storage.local +
// .sync. There is no Save button.
//
// Notable subsystems below:
//
//   - Refresh-mode UI (weekly / multi / daily) and the day-chip picker
//     that builds the refresh days for "multi" mode.
//   - Daily-limit mode picker (videos / time / both) and the hours+minutes
//     duration input.
//   - Hidden-items list (videos + channels) with oEmbed metadata backfill.
//   - Watching lock: once the user starts watching today, the Refresh and
//     Daily-limit sections lock behind a typed numeric code — same friction
//     pattern as the Work-mode unlock challenge in content.js.
//   - Debug: daily-state readout, manual refresh, force-add video, fake-time
//     offset, storage clear buttons.
// =============================================================================

// showStatus lives in shared.js (shared with popup.js).

// DAY_NAMES_LONG lives in shared.js (also used by content.js).
const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th"];

let currentRefreshMode = "weekly";
let currentRefreshDays = [];
let pendingDayChip = false;

async function loadSettings() {
  const settings = await getSettings();

  document.getElementById("extension-enabled").checked = settings.enabled;
  document.getElementById("weekly-home-enabled").checked = settings.weeklyHomeEnabled;
  document.getElementById("redirect-home-enabled").checked = settings.redirectHomeEnabled;

  currentRefreshMode = settings.refreshMode || "weekly";
  currentRefreshDays = Array.isArray(settings.refreshDays) ? [...settings.refreshDays] : [];
  pendingDayChip = currentRefreshMode === "multi" && currentRefreshDays.length === 0;

  const modeRadio = document.querySelector(`input[name="refresh-mode"][value="${currentRefreshMode}"]`);
  if (modeRadio) modeRadio.checked = true;

  document.getElementById("refresh-day").value = settings.refreshDay;

  const time12 = convertTo12Hour(settings.refreshHour);
  document.getElementById("refresh-hour").value = time12.hour;
  document.getElementById("refresh-ampm").value = time12.ampm;

  document.getElementById("video-count").value = settings.videoCount;
  document.getElementById("exclude-live-videos").checked = settings.excludeLiveVideos;
  document.getElementById("hide-shorts").checked = settings.hideShorts;
  document.getElementById("hide-watch-recs").checked = settings.hideWatchRecs;
  document.getElementById("disable-autoplay").checked = settings.disableAutoplay;
  document.getElementById("hide-end-screen-cards").checked = settings.hideEndScreenCards;
  document.getElementById("hide-live-chat").checked = settings.hideLiveChat;
  document.getElementById("hide-watch-side-panel").checked = settings.hideWatchSidePanel;
  document.getElementById("hide-comments").checked = settings.hideComments;
  document.getElementById("hide-notification-bell").checked = settings.hideNotificationBell;
  document.getElementById("hide-explore-trending").checked = settings.hideExploreTrending;
  document.getElementById("hide-more-from-youtube").checked = settings.hideMoreFromYoutube;
  document.getElementById("hide-mix-radio-playlists").checked = settings.hideMixRadioPlaylists;
  document.getElementById("hide-voice-search").checked = settings.hideVoiceSearch;
  document.getElementById("hide-create-button").checked = settings.hideCreateButton;
  document.getElementById("daily-limit-enabled").checked = settings.dailyLimitEnabled;
  {
    const modeRadio = document.querySelector(`input[name="daily-limit-mode"][value="${settings.dailyLimitMode || "both"}"]`);
    if (modeRadio) modeRadio.checked = true;
  }
  document.getElementById("max-videos-per-day").value = settings.maxVideosPerDay;
  {
    const totalSeconds = Math.max(0, Number(settings.maxSecondsPerDay) || 0);
    const totalMinutes = Math.floor(totalSeconds / 60);
    document.getElementById("max-hours-per-day").value = Math.floor(totalMinutes / 60);
    document.getElementById("max-minutes-per-day").value = totalMinutes % 60;
  }

  applyRefreshModeUI();
  applyDailyLimitModeUI();
  updateInfoText();
  updateDailyLimitInfo();
}

function getSelectedDailyLimitMode() {
  const checked = document.querySelector('input[name="daily-limit-mode"]:checked');
  return checked ? checked.value : "both";
}

function applyDailyLimitModeUI() {
  const enabled = document.getElementById("daily-limit-enabled").checked;
  const mode = getSelectedDailyLimitMode();
  // When the limit is disabled, hide the mode picker + value controls so the UI
  // doesn't falsely imply they still apply. When enabled, hide only the control
  // the selected mode makes irrelevant. (The info text describes the time
  // setting, so it also hides in videos-only mode.)
  const hideWhen = {
    "daily-limit-mode-group": !enabled,
    "max-videos-per-day-label": !enabled || mode === "time",
    "max-time-per-day-label": !enabled || mode === "videos",
    "daily-limit-info": !enabled || mode === "videos"
  };
  for (const [id, hidden] of Object.entries(hideWhen)) {
    const el = document.getElementById(id);
    if (el) el.style.display = hidden ? "none" : "";
  }
}

// Reads the daily-limit hours+minutes inputs, floored at 0.
function readHourMinutePair() {
  let h = Math.max(0, Number(document.getElementById("max-hours-per-day").value) || 0);
  // Normalize minutes overflow into the hours field instead of clamping it
  // away: a typed "90" minutes (HTML max=59 caps the spinner, not typed or
  // pasted values) means 1h30m — silently saving 59m would shrink the limit
  // the user actually asked for.
  let m = Math.max(0, Number(document.getElementById("max-minutes-per-day").value) || 0);
  h += Math.floor(m / 60);
  m = m % 60;
  return { h, m };
}

function updateDailyLimitInfo() {
  const { h, m } = readHourMinutePair();
  const info = document.getElementById("daily-limit-info");
  if (!info) return;
  const totalMin = h * 60 + m;
  if (totalMin === 0) {
    info.textContent = "Set at least 1 minute.";
    return;
  }
  const hourLabel = h === 1 ? "hour" : "hours";
  const minLabel = m === 1 ? "minute" : "minutes";
  if (h === 0) info.textContent = `${m} ${minLabel} per day.`;
  else if (m === 0) info.textContent = `${h} ${hourLabel} per day.`;
  else info.textContent = `${h} ${hourLabel} ${m} ${minLabel} per day.`;
}

function applyRefreshModeUI() {
  document.querySelectorAll(".refresh-mode-config").forEach(el => {
    el.classList.toggle("active", el.dataset.mode === currentRefreshMode);
  });

  const hourLabel = document.getElementById("refresh-hour-label");
  const countLabel = document.getElementById("video-count-label");
  if (currentRefreshMode === "daily") {
    hourLabel.textContent = "Refresh time:";
    countLabel.textContent = "Videos per day:";
  } else if (currentRefreshMode === "multi") {
    hourLabel.textContent = "Refresh time:";
    countLabel.textContent = "Videos per refresh:";
  } else {
    hourLabel.textContent = "Refresh hour:";
    countLabel.textContent = "Videos per week:";
  }

  if (currentRefreshMode === "multi") {
    renderRefreshDayChips();
  }
}

function renderRefreshDayChips() {
  const container = document.getElementById("refresh-days-container");
  container.innerHTML = "";

  const slots = currentRefreshDays.length + (pendingDayChip ? 1 : 0);
  const totalSlots = Math.max(1, slots);

  for (let i = 0; i < totalSlots; i++) {
    const selectedDay = i < currentRefreshDays.length ? currentRefreshDays[i] : null;
    container.appendChild(buildDayChip(i, selectedDay));
  }

  if (currentRefreshDays.length + (pendingDayChip ? 1 : 0) < 7) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "refresh-day-add";
    addBtn.textContent = "+";
    addBtn.title = "Add another refresh day";
    addBtn.disabled = pendingDayChip;
    addBtn.addEventListener("click", () => {
      pendingDayChip = true;
      renderRefreshDayChips();
    });
    container.appendChild(addBtn);
  }
}

function buildDayChip(slotIndex, selectedDay) {
  const chip = document.createElement("div");
  chip.className = "refresh-day-chip";

  const select = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `Select ${ORDINALS[slotIndex] || `${slotIndex + 1}th`} refresh day`;
  placeholder.disabled = true;
  if (selectedDay === null) placeholder.selected = true;
  select.appendChild(placeholder);

  for (let d = 0; d < 7; d++) {
    if (d !== selectedDay && currentRefreshDays.includes(d)) continue;
    const opt = document.createElement("option");
    opt.value = String(d);
    opt.textContent = DAY_NAMES_LONG[d];
    if (d === selectedDay) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    const newDay = Number(select.value);
    if (!Number.isInteger(newDay) || newDay < 0 || newDay > 6) return;

    if (selectedDay === null) {
      currentRefreshDays = [...currentRefreshDays, newDay].sort((a, b) => a - b);
      pendingDayChip = false;
    } else {
      currentRefreshDays = currentRefreshDays
        .map(d => (d === selectedDay ? newDay : d))
        .sort((a, b) => a - b);
    }
    renderRefreshDayChips();
    autoSave();
  });

  chip.appendChild(select);

  if (slotIndex > 0) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "refresh-day-chip-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this refresh day";
    removeBtn.addEventListener("click", () => {
      if (selectedDay === null) {
        pendingDayChip = false;
      } else {
        currentRefreshDays = currentRefreshDays.filter(d => d !== selectedDay);
      }
      renderRefreshDayChips();
      autoSave();
    });
    chip.appendChild(removeBtn);
  }

  return chip;
}

function updateInfoText() {
  const hour = document.getElementById("refresh-hour").value;
  const ampm = document.getElementById("refresh-ampm").value.toUpperCase();
  const infoText = document.getElementById("info-text");

  if (currentRefreshMode === "daily") {
    infoText.textContent = `Refreshes every day at ${hour}:00 ${ampm}`;
  } else if (currentRefreshMode === "multi") {
    if (currentRefreshDays.length === 0) {
      infoText.textContent = `Pick at least one refresh day.`;
    } else {
      const names = currentRefreshDays.map(d => DAY_NAMES_SHORT[d]).join(", ");
      infoText.textContent = `Refreshes ${names} at ${hour}:00 ${ampm}`;
    }
  } else {
    const day = document.getElementById("refresh-day").value;
    infoText.textContent = `Refreshes every ${DAY_NAMES_SHORT[day]} at ${hour}:00 ${ampm}`;
  }
}

// Timestamp of this tab's most recent settings write, used to ignore our own
// storage.onChanged echo so a remote (synced) settings change reloads the form
// but our own edits don't fight the user mid-typing.
let lastLocalSettingsWriteTs = 0;

async function autoSave() {
  const refreshDay = Number(document.getElementById("refresh-day").value);
  const refreshHour12 = Number(document.getElementById("refresh-hour").value);
  const refreshAmpm = document.getElementById("refresh-ampm").value;
  const videoCount = Number(document.getElementById("video-count").value);

  // Stamp BEFORE the write: saveSettings awaits a sync round-trip after its
  // local set(), and that set() fires storage.onChanged during the await.
  // Stamping after (old behavior) let the onChanged echo-guard read a stale
  // timestamp, so the tab treated its own write as a remote change and reloaded
  // the form mid-edit — guaranteed on the first edit, when the ts was still 0.
  // Spread the CURRENT stored settings under the form fields: saveSettings
  // sanitizes the object it's given with no merge, so any field this form
  // doesn't own (workCustomMinutes, persisted by content.js when the user
  // starts a custom-length work session) would otherwise be reset to its
  // default on every checkbox toggle. Read before the stamp so the echo-guard
  // window isn't widened by this extra await.
  const storedSettings = await getSettings();
  lastLocalSettingsWriteTs = Date.now();
  await saveSettings({
    ...storedSettings,
    enabled: document.getElementById("extension-enabled").checked,
    weeklyHomeEnabled: document.getElementById("weekly-home-enabled").checked,
    redirectHomeEnabled: document.getElementById("redirect-home-enabled").checked,
    refreshMode: currentRefreshMode,
    refreshDay,
    refreshDays: [...currentRefreshDays],
    refreshHour: convertTo24Hour(refreshHour12, refreshAmpm),
    videoCount,
    excludeLiveVideos: document.getElementById("exclude-live-videos").checked,
    hideShorts: document.getElementById("hide-shorts").checked,
    hideWatchRecs: document.getElementById("hide-watch-recs").checked,
    disableAutoplay: document.getElementById("disable-autoplay").checked,
    hideEndScreenCards: document.getElementById("hide-end-screen-cards").checked,
    hideLiveChat: document.getElementById("hide-live-chat").checked,
    hideWatchSidePanel: document.getElementById("hide-watch-side-panel").checked,
    hideComments: document.getElementById("hide-comments").checked,
    hideNotificationBell: document.getElementById("hide-notification-bell").checked,
    hideExploreTrending: document.getElementById("hide-explore-trending").checked,
    hideMoreFromYoutube: document.getElementById("hide-more-from-youtube").checked,
    hideMixRadioPlaylists: document.getElementById("hide-mix-radio-playlists").checked,
    hideVoiceSearch: document.getElementById("hide-voice-search").checked,
    hideCreateButton: document.getElementById("hide-create-button").checked,
    dailyLimitEnabled: document.getElementById("daily-limit-enabled").checked,
    dailyLimitMode: getSelectedDailyLimitMode(),
    maxVideosPerDay: Number(document.getElementById("max-videos-per-day").value),
    maxSecondsPerDay: computeMaxSecondsPerDayFromInputs()
  });

  updateInfoText();
  updateDailyLimitInfo();
  applyDailyLimitModeUI();
  showStatus("Saved");
}

function formatHM(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function computeMaxSecondsPerDayFromInputs() {
  const { h, m } = readHourMinutePair();
  const totalSeconds = (h * 60 + m) * 60;
  // Clamp to [60, 86400]. Floor at 60 (1 min) so an empty/zero state still has a
  // sane limit; cap at 24h (86400s) because sanitizeSettings REJECTS anything
  // larger and falls back to the 1h default — so e.g. "24h 30m" would otherwise
  // silently reset to 1 hour instead of capping at 24h.
  return Math.min(86400, Math.max(60, totalSeconds));
}

const AUTO_SAVE_FIELDS = [
  "extension-enabled",
  "weekly-home-enabled",
  "redirect-home-enabled",
  "refresh-day",
  "refresh-hour",
  "refresh-ampm",
  "video-count",
  "exclude-live-videos",
  "hide-shorts",
  "hide-watch-recs",
  "disable-autoplay",
  "hide-end-screen-cards",
  "hide-live-chat",
  "hide-watch-side-panel",
  "hide-comments",
  "hide-notification-bell",
  "hide-explore-trending",
  "hide-more-from-youtube",
  "hide-mix-radio-playlists",
  "hide-voice-search",
  "hide-create-button",
  "daily-limit-enabled",
  "max-videos-per-day",
  "max-hours-per-day",
  "max-minutes-per-day"
];

for (const id of AUTO_SAVE_FIELDS) {
  document.getElementById(id).addEventListener("change", autoSave);
}

document.querySelectorAll('input[name="refresh-mode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    currentRefreshMode = radio.value;
    if (currentRefreshMode === "multi" && currentRefreshDays.length === 0) {
      pendingDayChip = true;
    }
    applyRefreshModeUI();
    autoSave();
  });
});

document.querySelectorAll('input[name="daily-limit-mode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    applyDailyLimitModeUI();
    autoSave();
  });
});

document.getElementById("show-welcome-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

function formatLocalDateTimeInput(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function formatHumanDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function refreshFakeNowUI() {
  const data = await chrome.storage.local.get([STORAGE_FAKE_NOW_OFFSET_KEY]);
  const offset = Number(data[STORAGE_FAKE_NOW_OFFSET_KEY]) || 0;
  const status = document.getElementById("fake-now-status");
  const input = document.getElementById("fake-now-input");

  if (offset === 0) {
    status.textContent = `Real time — no offset applied.\nCurrent: ${formatHumanDateTime(Date.now())}`;
    if (!input.value) input.value = formatLocalDateTimeInput(Date.now());
  } else {
    const fakeNow = Date.now() + offset;
    const sign = offset > 0 ? "+" : "-";
    const abs = Math.abs(offset);
    const days = Math.floor(abs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((abs / (60 * 60 * 1000)) % 24);
    const mins = Math.floor((abs / (60 * 1000)) % 60);
    status.textContent =
      `Fake time active.\n` +
      `Pretending now is: ${formatHumanDateTime(fakeNow)}\n` +
      `Offset: ${sign}${days}d ${hours}h ${mins}m from real time`;
    if (!input.value) input.value = formatLocalDateTimeInput(fakeNow);
  }
}

document.getElementById("fake-now-apply-btn").addEventListener("click", async () => {
  const input = document.getElementById("fake-now-input");
  if (!input.value) {
    showStatus("Pick a date and time first", false);
    return;
  }
  const target = new Date(input.value).getTime();
  if (!Number.isFinite(target)) {
    showStatus("Invalid date/time", false);
    return;
  }
  const offset = sanitizeFakeNowOffset(target - Date.now());
  await chrome.storage.local.set({ [STORAGE_FAKE_NOW_OFFSET_KEY]: offset });
  await refreshFakeNowUI();
  showStatus(`Fake time set — refresh logic will treat now as ${formatHumanDateTime(target)}`);
});

document.getElementById("fake-now-clear-btn").addEventListener("click", async () => {
  await chrome.storage.local.remove([STORAGE_FAKE_NOW_OFFSET_KEY]);
  document.getElementById("fake-now-input").value = formatLocalDateTimeInput(Date.now());
  await refreshFakeNowUI();
  showStatus("Cleared — using real time");
});

// Only poll while the Debug page is actually visible. The fake-now status only
// lives on that page, and pages are CSS-toggled (never unmounted), so an ungated
// interval would hit chrome.storage every 5s for the tab's entire lifetime.
setInterval(() => {
  const debugPage = document.querySelector('.page[data-page="debug"]');
  if (debugPage && debugPage.classList.contains("active")) refreshFakeNowUI();
}, 5000);
refreshFakeNowUI();

document.getElementById("refresh-weekly-btn").addEventListener("click", async () => {
  const btn = document.getElementById("refresh-weekly-btn");
  btn.disabled = true;
  // Force a re-fetch of the current week WITHOUT the full new-week reset.
  // saveWeeklyVideosToStorage([],0) also clears the SYNCED watched set and drops
  // local progress, which would surface this week's videos as unwatched on every
  // device. Instead just clear the grid + refresh marker so isRefreshDue() is
  // true, then nudge the background — watched flags + progress survive. (An empty
  // VIDEOS list is length-0-guarded in hydrate, so it won't clobber peers.)
  await chrome.storage.local.set({ [STORAGE_VIDEOS_KEY]: [], [STORAGE_REFRESH_AFTER_KEY]: 0 });
  // Drop the sync-side copies too: hydrateFromSync restores sync videos when
  // local is empty and a sync refreshAfter > 0 beats the local 0, so any
  // hydrate that lands before the background's fetch completes (offline,
  // error cooldown, browser restart) would silently resurrect the old grid
  // and cancel this forced refresh.
  await safeSyncRemove([STORAGE_VIDEOS_KEY, STORAGE_REFRESH_AFTER_KEY]);
  // force: a user-initiated refresh bypasses the background's transient-error
  // cooldown — the grid was just cleared, so a swallowed nudge would leave it
  // empty until the next 5-minute alarm.
  try { await chrome.runtime.sendMessage({ type: "better-feed-ensure-fresh", force: true }); } catch (_) {}
  showStatus("Refreshing — reload YouTube tab if grid doesn't update");
  setTimeout(() => { btn.disabled = false; }, 800);
});

// Pull an 11-char video ID out of a raw ID, a watch URL, a youtu.be URL, or
// a short URL with query/fragment garbage. Returns null if nothing matches.
function extractVideoIdFromInput(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (/^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname)) {
      const v = url.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/ID, /embed/ID
      const pathMatch = url.pathname.match(/\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
      if (pathMatch) return pathMatch[1];
    }
  } catch (_) {}
  // Fallback: look anywhere in the string for v=ID or /ID.
  const m = trimmed.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

document.getElementById("force-add-video-btn").addEventListener("click", async () => {
  const input = document.getElementById("force-add-video-input");
  const btn = document.getElementById("force-add-video-btn");
  const videoId = extractVideoIdFromInput(input.value);
  if (!videoId) {
    showStatus("Couldn't parse a YouTube video ID from that input", false);
    return;
  }

  btn.disabled = true;
  try {
    const data = await chrome.storage.local.get([STORAGE_VIDEOS_KEY]);
    const videos = Array.isArray(data[STORAGE_VIDEOS_KEY]) ? data[STORAGE_VIDEOS_KEY] : [];

    if (videos.some(v => v && v.videoId === videoId)) {
      showStatus("That video is already in the weekly grid", false);
      return;
    }

    // Write a pure stub (shared.js stubVideoFromId — same shape sync hydration
    // uses). The content script's rebuildVideoMetadataIfNeeded runs
    // automatically on the storage change and fetches everything from real
    // YouTube data: oEmbed for title/channel, the watch page for view count +
    // duration + publish date + members-only flag, and the channel page for
    // the avatar.
    //
    // PREPEND (not append): the grid render slices to settings.videoCount,
    // so an appended item past that index would be invisible. Prepending
    // puts the stub at the top of the array so it always shows.
    await chrome.storage.local.set({
      [STORAGE_VIDEOS_KEY]: [stubVideoFromId(videoId), ...videos]
    });

    input.value = "";
    showStatus(`Added ${videoId} at the top of the grid. Open or reload a YouTube tab on the weekly home — metadata fills in within a few seconds.`);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 600);
  }
});

async function renderDailyStateReadout() {
  const readout = document.getElementById("daily-state-readout");
  if (!readout) return;
  const settings = await getSettings();
  const state = await getDailyState(settings);
  const grace = await getDailyGrace(settings);
  const myId = await getDeviceId();

  // Annotate which cap is actually enforced: isDailyLimitHit counts the videos
  // cap only when mode !== "time" and the seconds cap only when mode !== "videos".
  const dlMode = settings.dailyLimitMode;
  const dlOff = !settings.dailyLimitEnabled;
  const videosNote = dlOff ? "  (limit disabled)" : dlMode === "time" ? "  (not enforced — time-only mode)" : "";
  const timeNote = dlOff ? "  (limit disabled)" : dlMode === "videos" ? "  (not enforced — videos-only mode)" : "";

  const lines = [];
  lines.push(`Day key:          ${state.dayKey}`);
  lines.push(`Videos watched:   ${state.videoIds.length} / ${settings.maxVideosPerDay}${videosNote}`);
  if (state.videoIds.length > 0) {
    lines.push(`  ids: ${state.videoIds.join(", ")}`);
  }
  lines.push(`Time watched:     ${formatHM(dailyTotalSeconds(state))} / ${formatHM(settings.maxSecondsPerDay)}${timeNote}`);
  const byDevice = state.secondsByDevice && typeof state.secondsByDevice === "object" ? state.secondsByDevice : {};
  for (const [dev, secs] of Object.entries(byDevice)) {
    lines.push(`  ${dev === myId ? "this device" : dev}: ${formatHM(Number(secs) || 0)}`);
  }
  if (grace) {
    if (grace.type === "minutes") {
      const remaining = Math.max(0, Math.round((grace.expiresAt - getNow()) / 1000));
      lines.push(`Grace:            minutes (${remaining}s remaining)`);
    } else if (grace.type === "finish") {
      lines.push(`Grace:            finish video (${grace.videoId})`);
    }
  } else {
    lines.push(`Grace:            none`);
  }
  lines.push(`Limit enabled:    ${settings.dailyLimitEnabled}`);
  readout.textContent = lines.join("\n");
}

document.getElementById("reset-daily-btn").addEventListener("click", async () => {
  const btn = document.getElementById("reset-daily-btn");
  btn.disabled = true;
  await chrome.storage.local.remove([STORAGE_DAILY_STATE_KEY, STORAGE_DAILY_GRACE_KEY]);
  // Daily state is synced (CRDT), so also clear the synced copy — otherwise the
  // next sync event re-merges today's progress straight back. (Grace is
  // local-only.) This empties this device's shared bucket; a still-online peer
  // holding today's buckets could re-push, but for a single user it sticks.
  await safeSyncRemove([STORAGE_DAILY_STATE_KEY]);
  await renderDailyStateReadout();
  await applyWatchingLockToAllSections();
  showStatus("Daily limit reset");
  setTimeout(() => { btn.disabled = false; }, 500);
});

document.getElementById("clear-local-data-btn").addEventListener("click", async () => {
  if (!confirm("Clear this browser's LOCAL extension data only? Sync data is untouched and will rehydrate into local. Cannot be undone.")) return;
  const btn = document.getElementById("clear-local-data-btn");
  btn.disabled = true;
  try {
    await chrome.storage.local.clear();
    showStatus("Local data cleared");
    settingsUnlocked.clear();
    await loadSettings();
    await renderDailyStateReadout();
    await applyWatchingLockToAllSections();
  } catch (err) {
    showStatus("Clear failed: " + (err?.message || err), false);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 500);
  }
});

document.getElementById("clear-sync-data-btn").addEventListener("click", async () => {
  if (!confirm("Clear the SHARED sync bucket? This will propagate to every device on your sync chain. Local data on this device is untouched. Cannot be undone.")) return;
  const btn = document.getElementById("clear-sync-data-btn");
  btn.disabled = true;
  try {
    await chrome.storage.sync.clear();
    showStatus("Sync data cleared");
    await renderDailyStateReadout();
  } catch (err) {
    showStatus("Clear failed: " + (err?.message || err), false);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 500);
  }
});

function activatePage(pageId) {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");

  let matched = false;
  for (const item of navItems) {
    const isActive = item.dataset.page === pageId;
    item.classList.toggle("active", isActive);
    if (isActive) matched = true;
  }
  for (const page of pages) {
    page.classList.toggle("active", page.dataset.page === pageId);
  }

  if (matched) {
    try {
      history.replaceState(null, "", `#${pageId}`);
    } catch {}
  }
}

for (const item of document.querySelectorAll(".nav-item")) {
  item.addEventListener("click", () => {
    activatePage(item.dataset.page);
  });
}

function initialPageFromHash() {
  const hash = (location.hash || "").replace(/^#/, "");
  const valid = ["refresh", "cleanup", "daily-limit", "hidden", "advanced", "debug"];
  return valid.includes(hash) ? hash : "refresh";
}

// backfillMissingHiddenVideoMetadata lives in shared.js (one copy shared with
// popup.js; this page passes renderHiddenItems as the onUpdated re-render).

// channelDisplayFromKey lives in shared.js (shared with popup.js).

async function renderHiddenItems() {
  const videosList = document.getElementById("hidden-videos-list");
  const channelsList = document.getElementById("hidden-channels-list");
  if (!videosList || !channelsList) return;

  const { videos, channels, metadata } = await getHiddenItemsWithMetadata();
  const meta = metadata || {};

  videosList.innerHTML = "";
  if (videos.size === 0) {
    const empty = document.createElement("div");
    empty.className = "hidden-empty";
    empty.textContent = "No hidden videos.";
    videosList.appendChild(empty);
  } else {
    const ids = [...videos].reverse();
    for (const id of ids) {
      const m = meta[id];
      videosList.appendChild(buildHiddenRow({
        id,
        kind: "video",
        title: m?.title || "Hidden video",
        sub: m?.channelName || `ID: ${id}`
      }));
    }
  }

  channelsList.innerHTML = "";
  if (channels.size === 0) {
    const empty = document.createElement("div");
    empty.className = "hidden-empty";
    empty.textContent = "No hidden channels.";
    channelsList.appendChild(empty);
  } else {
    const ids = [...channels].reverse();
    for (const id of ids) {
      const m = meta[id];
      const fallback = channelDisplayFromKey(id);
      channelsList.appendChild(buildHiddenRow({
        id,
        kind: "channel",
        title: m?.channelName || fallback || "Hidden channel",
        sub: m?.channelName ? "" : (fallback ? id : `ID: ${id}`)
      }));
    }
  }

  document.getElementById("clear-hidden-videos-btn").disabled = videos.size === 0;
  document.getElementById("clear-hidden-channels-btn").disabled = channels.size === 0;

  // Kick off oEmbed lookups for any entries that came back from sync without
  // metadata (typical after a reinstall). Fires in the background so the
  // initial render isn't blocked; renderHiddenItems is invoked again once
  // results are persisted.
  backfillMissingHiddenVideoMetadata(renderHiddenItems).catch(() => {});
}

function buildHiddenRow({ id, kind, title, sub }) {
  const row = document.createElement("div");
  row.className = "hidden-item";

  const info = document.createElement("div");
  info.className = "hidden-item-info";

  const titleEl = document.createElement("div");
  titleEl.className = "hidden-item-title";
  titleEl.textContent = title;
  info.appendChild(titleEl);

  if (sub) {
    const subEl = document.createElement("div");
    subEl.className = "hidden-item-sub";
    subEl.textContent = sub;
    info.appendChild(subEl);
  }

  row.appendChild(info);

  const btn = document.createElement("button");
  btn.className = "hidden-unhide-btn";
  btn.textContent = "Unhide";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await modifyHidden(state => {
      if (kind === "video") state.videos.delete(id);
      else state.channels.delete(id);
      if (state.metadata) delete state.metadata[id];
    });
    showStatus("Unhidden");
  });
  row.appendChild(btn);

  return row;
}

document.getElementById("clear-hidden-videos-btn").addEventListener("click", async () => {
  if (!confirm("Unhide all hidden videos? Cannot be undone.")) return;
  const btn = document.getElementById("clear-hidden-videos-btn");
  btn.disabled = true;
  await modifyHidden(state => {
    for (const id of [...state.videos]) {
      state.videos.delete(id);
      if (state.metadata) delete state.metadata[id];
    }
  });
  showStatus("All videos unhidden");
});

document.getElementById("clear-hidden-channels-btn").addEventListener("click", async () => {
  if (!confirm("Unhide all hidden channels? Cannot be undone.")) return;
  const btn = document.getElementById("clear-hidden-channels-btn");
  btn.disabled = true;
  await modifyHidden(state => {
    for (const id of [...state.channels]) {
      state.channels.delete(id);
      if (state.metadata) delete state.metadata[id];
    }
  });
  showStatus("All channels unhidden");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Track the Debug fake-clock like content.js/background.js do. Without
  // this, every time-dependent readout on this page (day key via getNow,
  // grace remaining, the watching lock) runs on the REAL clock while the
  // YouTube tabs run on the fake one — the readout shows empty state and
  // the watching-locked sections unlock during an active fake-day binge.
  applyFakeNowOffsetChange(changes);
  if (STORAGE_FAKE_NOW_OFFSET_KEY in changes) {
    renderDailyStateReadout();
    applyWatchingLockToAllSections();
  }
  if (STORAGE_DAILY_STATE_KEY in changes || STORAGE_DAILY_GRACE_KEY in changes || SETTINGS_KEY in changes) {
    renderDailyStateReadout();
  }
  // A settings change that isn't this tab's own write echo means another
  // device (via sync) or another tab updated settings — reload the form so a
  // later autoSave doesn't push stale field values back over the remote change.
  if (SETTINGS_KEY in changes && Date.now() - lastLocalSettingsWriteTs > 1500) {
    loadSettings();
  }
  if (STORAGE_DAILY_STATE_KEY in changes) {
    // Watching started/cleared in another tab — re-evaluate lock state.
    applyWatchingLockToAllSections();
  }
  if (
    STORAGE_HIDDEN_VIDEOS_KEY in changes ||
    STORAGE_HIDDEN_CHANNELS_KEY in changes ||
    STORAGE_HIDDEN_METADATA_KEY in changes
  ) {
    renderHiddenItems();
  }
});

/* ---------- RESET TO DEFAULTS ---------- */
// Per-tab reset buttons live at the bottom of each settings tab; the
// "Reset all" button lives in a section-danger on the Advanced tab. Both
// route through saveSettings() so the change persists locally, syncs
// across devices, and runs through the same sanitizer as autoSave.
//
// The watching lock guards both flavors — if any [data-lockable="watching"]
// section is currently locked, reset is refused until the user types the
// unlock code. Otherwise the reset button would be a trivial bypass for
// the lock's "no editing limits mid-binge" intent.

const RESET_GROUPS = {
  refresh: [
    "weeklyHomeEnabled",
    "excludeLiveVideos",
    "refreshMode",
    "refreshDay",
    "refreshDays",
    "refreshHour",
    "videoCount"
  ],
  cleanup: [
    "hideShorts",
    "hideWatchRecs",
    "disableAutoplay",
    "hideEndScreenCards",
    "hideLiveChat",
    "hideWatchSidePanel",
    "hideComments",
    "hideNotificationBell",
    "hideExploreTrending",
    "hideMoreFromYoutube",
    "hideMixRadioPlaylists",
    "hideVoiceSearch",
    "hideCreateButton"
  ],
  "daily-limit": [
    "dailyLimitEnabled",
    "dailyLimitMode",
    "maxVideosPerDay",
    "maxSecondsPerDay"
  ],
  advanced: [
    "redirectHomeEnabled"
  ]
};

function lockedSectionsOnTab(tabId) {
  return document.querySelectorAll(
    `section[data-page="${tabId}"] [data-lockable="watching"].locked`
  );
}

function lockedSectionsAnywhere() {
  return document.querySelectorAll('[data-lockable="watching"].locked');
}

function cloneDefault(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

async function resetTabToDefaults(tabId) {
  const keys = RESET_GROUPS[tabId];
  if (!keys) return;
  if (lockedSectionsOnTab(tabId).length > 0) {
    showStatus("Unlock locked sections before resetting", false);
    return;
  }
  if (!confirm("Reset these settings to their defaults? This cannot be undone.")) return;
  const current = await getSettings();
  const next = { ...current };
  for (const key of keys) {
    next[key] = cloneDefault(DEFAULT_SETTINGS[key]);
  }
  await saveSettings(next);
  await loadSettings();
  await applyWatchingLockToAllSections();
  showStatus("Settings reset to defaults");
}

async function resetAllSettings() {
  if (lockedSectionsAnywhere().length > 0) {
    showStatus("Unlock locked sections before resetting", false);
    return;
  }
  if (!confirm("Reset ALL settings to their defaults? This cannot be undone.")) return;
  // Deep copy so saveSettings → sanitizeSettings can stamp _updatedAt
  // without mutating the shared DEFAULT_SETTINGS object.
  const fresh = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  await saveSettings(fresh);
  await loadSettings();
  await applyWatchingLockToAllSections();
  showStatus("All settings reset to defaults");
}

document.addEventListener("click", event => {
  const tabBtn = event.target.closest?.(".reset-defaults-btn");
  if (tabBtn) {
    resetTabToDefaults(tabBtn.dataset.resetTab);
    return;
  }
  const allBtn = event.target.closest?.(".reset-all-defaults-btn");
  if (allBtn) {
    resetAllSettings();
  }
});

/* ---------- WATCHING LOCK ---------- */
// Once the user has started watching today, the refresh schedule and daily
// watch limit sections lock — preventing the impulsive "let me just bump the
// limit to keep watching" loophole. Mirrors the work-mode unlock challenge:
// type a fresh 16–20 digit code to release the lock for this options-tab
// session. The lock re-applies on next page load if watch progress remains.

const settingsUnlocked = new Set(); // section IDs that have been unlocked in-session

function hasWatchProgressToday(state) {
  if (!state) return false;
  const videos = Array.isArray(state.videoIds) ? state.videoIds.length : 0;
  const seconds = dailyTotalSeconds(state);
  return videos > 0 || seconds > 0;
}

function setSectionLocked(sectionEl, locked) {
  if (!sectionEl) return;
  sectionEl.classList.toggle("locked", locked);
  const banner = sectionEl.querySelector(".lock-banner");
  if (banner) banner.hidden = !locked;
  const controls = sectionEl.querySelector(".lock-controls");
  if (!controls) return;
  // No other code in these sections conditionally disables form controls, so
  // we can brute-force enable on unlock without worrying about clobbering
  // someone else's disabled state.
  controls.querySelectorAll("input, select, button, textarea").forEach(el => {
    el.disabled = locked;
    // Clean up legacy marker attributes from earlier iterations of this code.
    delete el.dataset.watchingLocked;
    delete el.dataset.lockOriginallyDisabled;
  });
}

async function applyWatchingLockToAllSections() {
  const settings = await getSettings();
  const state = await getDailyState(settings);
  const watching = hasWatchProgressToday(state);
  document.querySelectorAll('[data-lockable="watching"]').forEach(section => {
    const shouldLock = watching && !settingsUnlocked.has(section.id);
    setSectionLocked(section, shouldLock);
  });
}

/* ---------- UNLOCK MODAL ---------- */

// generateUnlockCode is defined in shared.js so the watching-lock and the
// work-session unlock can't drift apart.

function renderUnlockModal({ onUnlock }) {
  document.querySelectorAll(".unlock-modal").forEach(el => el.remove());

  const code = generateUnlockCode();

  const overlay = document.createElement("div");
  overlay.className = "unlock-modal";

  const card = document.createElement("div");
  card.className = "unlock-card";

  const title = document.createElement("h2");
  title.className = "unlock-title";
  title.textContent = "Unlock settings?";
  card.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "unlock-sub";
  sub.textContent =
    "Type the code below exactly to confirm. This friction is intentional — pause and decide whether you really want to change the limit mid-day.";
  card.appendChild(sub);

  const codeDisplay = document.createElement("div");
  codeDisplay.className = "unlock-code";
  codeDisplay.textContent = code;
  card.appendChild(codeDisplay);

  const input = document.createElement("input");
  input.className = "unlock-input";
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.placeholder = "Type the code";
  card.appendChild(input);

  const buttons = document.createElement("div");
  buttons.className = "unlock-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "unlock-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => overlay.remove());

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Unlock";
  confirmBtn.disabled = true;
  confirmBtn.addEventListener("click", () => {
    if (input.value !== code) return;
    overlay.remove();
    onUnlock();
  });

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  card.appendChild(buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Defeat select-all-copy on the code display so the user has to type it.
  codeDisplay.addEventListener("copy", e => e.preventDefault());
  codeDisplay.addEventListener("cut", e => e.preventDefault());

  // Block paste into the input — typing only.
  input.addEventListener("paste", e => e.preventDefault());
  input.addEventListener("drop", e => e.preventDefault());

  input.addEventListener("input", () => {
    // Strip non-digits in case of IME / paste-bypass.
    const cleaned = input.value.replace(/\D/g, "");
    if (cleaned !== input.value) input.value = cleaned;
    confirmBtn.disabled = input.value !== code;
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !confirmBtn.disabled) {
      e.preventDefault();
      confirmBtn.click();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelBtn.click();
    }
  });

  setTimeout(() => input.focus(), 0);
}

document.addEventListener("click", event => {
  const trigger = event.target.closest?.(".unlock-trigger");
  if (!trigger) return;
  const targetId = trigger.dataset.target;
  if (!targetId) return;
  renderUnlockModal({
    onUnlock: () => {
      settingsUnlocked.add(targetId);
      const section = document.getElementById(targetId);
      setSectionLocked(section, false);
    }
  });
});

// The Debug tab is a support/power-user surface, not part of the everyday
// product — its nav button ships hidden and is revealed only when the page
// is opened (or re-hashed) with #debug in the URL.
function revealDebugNavIfRequested() {
  if ((location.hash || "").replace(/^#/, "") !== "debug") return;
  const btn = document.querySelector('.nav-item[data-page="debug"]');
  if (btn) btn.style.display = "";
}

window.addEventListener("hashchange", () => {
  revealDebugNavIfRequested();
  activatePage(initialPageFromHash());
});

(async () => {
  await migrateLegacyStorageKeys();
  // Adopt any active Debug fake-clock BEFORE the time-dependent reads below
  // (day key, daily state, watching lock) — content.js and background.js load
  // it at init too; skipping it here would split this page onto the real
  // clock while the rest of the extension runs on the fake one.
  await loadFakeNowOffset();
  await hydrateFromSync();
  await loadSettings();
  await renderDailyStateReadout();
  await renderHiddenItems();
  await applyWatchingLockToAllSections();
  revealDebugNavIfRequested();
  activatePage(initialPageFromHash());
})();
