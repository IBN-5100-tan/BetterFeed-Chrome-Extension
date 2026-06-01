// =============================================================================
// content.js — the user-visible behavior of BetterFeed.
//
// Runs on every youtube.com page. Loaded by shared.js (constants + storage
// helpers) and then takes over once the page is parsed.
//
// Major responsibilities, in roughly the order they appear below:
//
//   - SELECTORS / REGEX  : YouTube DOM and metadata pattern catalogs. Bundled at
//                          the top so a YT redesign only needs one place edited.
//   - THEME              : Detect YouTube's light/dark theme and mirror it onto
//                          the extension's own surfaces.
//   - STYLE              : Inject the giant CSS blob that re-skins the marker
//                          page into the weekly home grid (+ feature toggles).
//   - RENDER             : Build the weekly grid DOM from a stored video list.
//   - REFRESH SCHEDULE   : Translate weekly/multi/daily refresh settings into
//                          a concrete next-refresh timestamp + grid header.
//   - STORAGE            : Read/write the weekly video list via shared.js.
//   - METADATA REBUILD   : Re-populate stub entries (title/channel/duration)
//                          via YouTube's oEmbed endpoint + the watch page. Runs
//                          after a sync hydrate, since sync only ships video IDs.
//   - FILTERS / EXTRACTORS: Pull a clean video record out of the raw home-grid
//                          DOM, rejecting Shorts/mixes/ads/live broadcasts.
//   - WEEKLY GRID RENDER : renderFromStorage — pure read of the stored grid +
//                          background-owned refresh status; paints the grid,
//                          the "Refreshing…" loader, or a quiet retry message.
//                          content.js no longer fetches/scrapes/saves — the
//                          background owns the entire refresh (see background.js
//                          ensureFreshVideos).
//   - MAIN / update()    : Single dispatcher. Decides on every navigation /
//                          state change what to render: cold-start, mode
//                          picker, weekly home, Work placeholder, See-you-
//                          tomorrow, or just plain YouTube.
//   - MODE PICKER        : Watch / Work / Listen chooser. Owns the picker UI
//                          and the post-pick navigation.
//   - WORK SESSION       : Timed + no-time variants, the lock window, and the
//                          unlock challenge that protects mid-session bailout.
//   - WORK CLOCK / SWITCHER / SESSION-ENDED POPUP : header chrome that sits in
//                          the YouTube masthead during a Work session.
//   - DAILY LIMIT        : Per-day video count + seconds-watched accounting,
//                          plus the See-you-tomorrow takeover screen and the
//                          "5 more minutes" / "finish this video" grace flows.
//   - AUTO-MARK WATCHED  : Stream-based progress tracker that writes the
//                          progress bar position and flips videos to "watched"
//                          when within ~20 sec of the end.
//   - CHANNEL CONFIRM    : Work-mode friction prompt before clicking through
//                          to a channel page (no muscle-memory subscriptions).
//
// `update()` is the single entry point that the SPA-navigate listener,
// the storage-change listener, and the init IIFE all funnel through. It
// inspects current state and routes to one render branch — there is no
// state machine class, just a tower of `if`s in update().
// =============================================================================

// REFRESH_BACKFILL_BUFFER and MAX_WEEKLY_VIDEOS live in shared.js (the
// background needs them too); referenced here via the shared global scope.

const CUSTOM_HOME_ID = "better-feed-home";

const BODY_CLASS_HIDE_SHORTS = "better-feed-hide-shorts";
const BODY_CLASS_HIDE_WATCH_RECS = "better-feed-hide-watch-recs";
const BODY_CLASS_DISABLE_AUTOPLAY = "better-feed-disable-autoplay";
const BODY_CLASS_HIDE_END_SCREEN_CARDS = "better-feed-hide-end-screen-cards";
const BODY_CLASS_HIDE_LIVE_CHAT = "better-feed-hide-live-chat";
const BODY_CLASS_HIDE_WATCH_SIDE_PANEL = "better-feed-hide-watch-side-panel";
const BODY_CLASS_HIDE_COMMENTS = "better-feed-hide-comments";
const BODY_CLASS_HIDE_NOTIFICATION_BELL = "better-feed-hide-notification-bell";
const BODY_CLASS_HIDE_EXPLORE_TRENDING = "better-feed-hide-explore-trending";
const BODY_CLASS_HIDE_MORE_FROM_YOUTUBE = "better-feed-hide-more-from-youtube";
const BODY_CLASS_HIDE_MIX_RADIO_PLAYLISTS = "better-feed-hide-mix-radio-playlists";
const BODY_CLASS_HIDE_VOICE_SEARCH = "better-feed-hide-voice-search";
const BODY_CLASS_HIDE_CREATE_BUTTON = "better-feed-hide-create-button";

let updateInProgress = false;
// When an update() arrives while another is still running, mark it pending and
// run it after. Multiple storage.onChanged listeners fire concurrently — e.g.
// STORAGE_VIDEOS_KEY and STORAGE_REFRESH_STATUS_KEY both call update() while
// renderFromStorage is mid-await — and dropping the second would leave the grid
// stale.
let updatePendingAfterCurrent = false;
let renderToken = 0;

/* ---------- THEME ---------- */

let _lastDetectedBg = null;
function detectAndApplyTheme() {
  const bg = getComputedStyle(document.documentElement).backgroundColor;
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return;
  // Bail if nothing changed. Otherwise the setProperty below rewrites the
  // inline style attribute, which the MutationObserver (attributes:true) sees
  // as a change and re-invokes us — needless churn on every unrelated
  // attribute mutation.
  if (bg === _lastDetectedBg) return;
  _lastDetectedBg = bg;

  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const isLight = luminance > 0.5;

  document.documentElement.classList.toggle("better-feed-light-mode", isLight);
  document.documentElement.style.setProperty("--better-feed-base-bg", bg);
}

let themeObserverAttached = false;
function ensureThemeObserver() {
  if (themeObserverAttached) return;
  themeObserverAttached = true;

  const observer = new MutationObserver(detectAndApplyTheme);
  observer.observe(document.documentElement, { attributes: true });
  if (document.body) {
    observer.observe(document.body, { attributes: true });
  }
}


/* ---------- STYLE ---------- */
// All home-grid styles and feature-toggle / overlay styles now live in
// home.css and features.css respectively, loaded by the manifest. Toggle
// classes are still set on <html> by applyFeatureSettings(); the rules
// over there activate when the matching class is present and the matching
// DOM element exists.

// [body class, settings flag] for each cleanup toggle. Driven as a table so
// applyFeatureSettings stays a single loop instead of 13 repeated lines.
const FEATURE_CLASS_SETTINGS = [
  [BODY_CLASS_HIDE_SHORTS, "hideShorts"],
  [BODY_CLASS_HIDE_WATCH_RECS, "hideWatchRecs"],
  [BODY_CLASS_DISABLE_AUTOPLAY, "disableAutoplay"],
  [BODY_CLASS_HIDE_END_SCREEN_CARDS, "hideEndScreenCards"],
  [BODY_CLASS_HIDE_LIVE_CHAT, "hideLiveChat"],
  [BODY_CLASS_HIDE_WATCH_SIDE_PANEL, "hideWatchSidePanel"],
  [BODY_CLASS_HIDE_COMMENTS, "hideComments"],
  [BODY_CLASS_HIDE_NOTIFICATION_BELL, "hideNotificationBell"],
  [BODY_CLASS_HIDE_EXPLORE_TRENDING, "hideExploreTrending"],
  [BODY_CLASS_HIDE_MORE_FROM_YOUTUBE, "hideMoreFromYoutube"],
  [BODY_CLASS_HIDE_MIX_RADIO_PLAYLISTS, "hideMixRadioPlaylists"],
  [BODY_CLASS_HIDE_VOICE_SEARCH, "hideVoiceSearch"],
  [BODY_CLASS_HIDE_CREATE_BUTTON, "hideCreateButton"]
];

async function applyFeatureSettings() {
  const settings = await getSettings();
  const mode = await getCurrentMode();
  const watchActive = mode === MODE_WATCH;
  const root = document.documentElement;

  // Show YouTube's native home (don't inject our grid) when the user isn't in
  // Watch mode or has the extension / weekly home turned off.
  const showNativeHome =
    !watchActive || !settings.enabled || !settings.weeklyHomeEnabled;
  root.classList.toggle("better-feed-show-native-home", showNativeHome);

  // Each cleanup toggle maps a body class to its settings flag. When the
  // extension is disabled, every class is forced off (toggle(_, false) removes
  // it) and we return before any feature work.
  for (const [cls, key] of FEATURE_CLASS_SETTINGS) {
    root.classList.toggle(cls, settings.enabled && settings[key]);
  }
  if (!settings.enabled) return;

  if (settings.disableAutoplay) {
    persistAutoplayDisabledFlag();
    enforceAutoplayDisabled();
  }
}

function persistAutoplayDisabledFlag() {
  try {
    localStorage.setItem(
      "yt-player-autonavstate",
      JSON.stringify({
        data: "STATE_OFF",
        creation: Date.now(),
        expiration: -1
      })
    );
  } catch {}
}

function findAutoplayToggle() {
  return (
    document.querySelector(".ytp-autonav-toggle-button") ||
    document.querySelector('button[data-tooltip-target-id="ytp-autonav-toggle-button"]') ||
    document.querySelector('[aria-label*="Autoplay" i][role="switch"]') ||
    document.querySelector('[aria-label*="Autoplay" i].ytp-button')
  );
}

function waitForAutoplayToggle(timeoutMs = 5000) {
  return new Promise(resolve => {
    const existing = findAutoplayToggle();
    if (existing) return resolve(existing);

    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };

    const observer = new MutationObserver(() => {
      const el = findAutoplayToggle();
      if (el) finish(el);
    });

    const timer = setTimeout(() => finish(null), timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function enforceAutoplayDisabled() {
  if (!location.pathname.startsWith("/watch")) return;

  const toggle = await waitForAutoplayToggle();
  if (!toggle) return;

  if (toggle.getAttribute("aria-checked") === "true") {
    toggle.click();
  }
}

/* ---------- RENDER ---------- */

function removeCustomHome() {
  document
    .querySelectorAll(`#${CUSTOM_HOME_ID}`)
    .forEach(el => el.remove());
  document.documentElement.classList.remove("better-feed-see-you-tomorrow");
}

function alignWeekHeader() {
  const container = document.getElementById(CUSTOM_HOME_ID);
  const header = container?.querySelector(".better-feed-week-header");
  if (!container || !header) return;

  // Anchor to the grid rather than the full-width container — the grid is
  // capped at max-width and centered, so using the container's rect would
  // pin the title to the left edge of the parent rather than the cards.
  const grid = container.querySelector(".better-feed-grid");
  const target = grid || container;
  const rect = target.getBoundingClientRect();
  header.style.left = `${rect.left}px`;
  header.style.width = `${rect.width}px`;
}

let weekHeaderResizeObserver = null;
function ensureWeekHeaderListeners() {
  const container = document.getElementById(CUSTOM_HOME_ID);
  if (!container) return;
  if (weekHeaderResizeObserver) {
    weekHeaderResizeObserver.disconnect();
  } else {
    window.addEventListener("resize", alignWeekHeader);
  }
  weekHeaderResizeObserver = new ResizeObserver(() => alignWeekHeader());
  weekHeaderResizeObserver.observe(container);
}

async function renderCustomHome(videos, options = {}) {
  const myToken = ++renderToken;

  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  const [hidden, settings, watched, progressMap] = await Promise.all([
    getHiddenItems(),
    getSettings(),
    getWatchedVideos(),
    getVideoProgressMap()
  ]);
  if (myToken !== renderToken) return;

  const visibleVideos = filterHiddenVideos(videos, hidden);
  const unwatched = visibleVideos.filter(v => !watched.has(v?.videoId));
  const watchedVideos = visibleVideos.filter(v => watched.has(v?.videoId));
  const orderedVideos = [...unwatched, ...watchedVideos];

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const weekHeader = document.createElement("h1");
  weekHeader.className = "better-feed-week-header";
  weekHeader.textContent = formatWeekRange(settings);
  container.appendChild(weekHeader);

  const grid = document.createElement("div");
  grid.className = "better-feed-grid";

  for (const video of orderedVideos) {
    const isWatched = watched.has(video?.videoId);
    const card = document.createElement("a");
    card.className = "better-feed-card" + (isWatched ? " better-feed-watched" : "");

    // Progress entries can be in three shapes depending on origin:
    //   - { position, duration }  (local; full data)
    //   - { position, duration: 0 } (hydrated from sync; duration unknown)
    //   - number  (raw legacy/sync form — defensive)
    // Position drives the seek, duration drives the bar fraction. When the
    // stored duration is missing we fall back to parsing video.duration.
    const rawProgress = progressMap?.[video?.videoId];
    const progressPosition =
      typeof rawProgress === "number"
        ? rawProgress
        : typeof rawProgress?.position === "number"
          ? rawProgress.position
          : 0;
    const progressStoredDuration =
      rawProgress && typeof rawProgress === "object" && typeof rawProgress.duration === "number"
        ? rawProgress.duration
        : 0;
    const progressDuration =
      progressStoredDuration > 0
        ? progressStoredDuration
        : parseDurationString(video?.duration);
    const hasProgress = !isWatched && progressPosition > 0 && progressDuration > 0;

    let href = video.url || (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : "#");
    // YouTube's own resume can be flaky on the marker pages, so we pin the
    // seek via the canonical ?t= query param rather than relying on its memory.
    if (hasProgress && href !== "#") {
      const seekTo = Math.max(0, Math.floor(progressPosition));
      if (seekTo > 0) {
        try {
          const url = new URL(href);
          url.searchParams.set("t", String(seekTo));
          href = url.toString();
        } catch (_) {}
      }
    }
    card.href = href;

    const thumbnailWrap = document.createElement("div");
    thumbnailWrap.className = "better-feed-thumbnail-wrap";

    const img = document.createElement("img");
    img.className = "better-feed-thumbnail";
    img.alt = decodeHtml(video.title);
    img.loading = "eager";
    img.referrerPolicy = "no-referrer";
    applyThumbnailFallbacks(img, video);

    thumbnailWrap.appendChild(img);

    if (isWatched) {
      const watchedBadge = document.createElement("div");
      watchedBadge.className = "better-feed-watched-badge";
      watchedBadge.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="white" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>Watched</span>';
      thumbnailWrap.appendChild(watchedBadge);
    } else if (hasProgress) {
      const fraction = progressPosition / progressDuration;
      const bar = document.createElement("div");
      bar.className = "better-feed-progress-bar";
      const fill = document.createElement("div");
      fill.className = "better-feed-progress-bar-fill";
      fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
      bar.appendChild(fill);
      thumbnailWrap.appendChild(bar);
    }

    if (video.duration) {
      const duration = document.createElement("div");
      duration.className = "better-feed-duration";
      duration.textContent = video.duration;
      thumbnailWrap.appendChild(duration);
    }

    const meta = document.createElement("div");
    meta.className = "better-feed-meta";

    const avatar = document.createElement("div");
    avatar.className = "better-feed-avatar";

    if (video.avatar) {
      const avatarImg = document.createElement("img");
      avatarImg.src = decodeHtml(video.avatar);
      avatarImg.alt = "";
      avatarImg.loading = "eager";
      avatarImg.referrerPolicy = "no-referrer";
      avatar.appendChild(avatarImg);
    }

    const text = document.createElement("div");
    text.className = "better-feed-text";

    const title = document.createElement("div");
    title.className = "better-feed-title";
    title.textContent = decodeHtml(video.title);

    const channel = document.createElement("div");
    channel.className = "better-feed-channel";
    channel.textContent = decodeHtml(video.channelName || "");

    const stats = document.createElement("div");
    stats.className = "better-feed-stats";
    if (video.membersOnly) {
      const membersBadge = document.createElement("span");
      membersBadge.className = "better-feed-members-badge";
      membersBadge.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2l2.39 4.84 5.34.78-3.86 3.77.91 5.31L12 14.5l-4.78 2.51.91-5.31L4.27 7.62l5.34-.78z"/>' +
        "</svg><span>Members first</span>";
      stats.appendChild(membersBadge);
    }
    if (video.metadata) {
      const statsText = document.createElement("span");
      statsText.textContent = decodeHtml(video.metadata);
      stats.appendChild(statsText);
    }

    text.appendChild(title);
    if (video.channelName) text.appendChild(channel);
    if (video.metadata || video.membersOnly) text.appendChild(stats);

    const menuWrap = document.createElement("div");
    menuWrap.className = "better-feed-menu-wrap";

    const menu = document.createElement("button");
    menu.className = "better-feed-menu";
    menu.type = "button";
    menu.textContent = "⋮";
    menu.setAttribute("aria-label", "Video options");

    const popover = document.createElement("div");
    popover.className = "better-feed-menu-popover";

    const watchedButton = document.createElement("button");
    watchedButton.className = "better-feed-menu-item";
    watchedButton.type = "button";
    watchedButton.textContent = isWatched ? "Mark as unwatched" : "Mark as watched";

    const hideVideoButton = document.createElement("button");
    hideVideoButton.className = "better-feed-menu-item";
    hideVideoButton.type = "button";
    hideVideoButton.textContent = "Hide video";

    const hideChannelButton = document.createElement("button");
    hideChannelButton.className = "better-feed-menu-item";
    hideChannelButton.type = "button";
    hideChannelButton.textContent = "Hide channel";

    menu.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      closeAllVideoMenus(menuWrap);
      menuWrap.classList.toggle("open");
    });

    watchedButton.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();

      menuWrap.classList.remove("open");
      await toggleWatchedAndRefresh(video, !isWatched);
    });

    hideVideoButton.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();

      menuWrap.classList.remove("open");
      await hideVideoAndRefresh(video);
    });

    hideChannelButton.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();

      menuWrap.classList.remove("open");
      await hideChannelAndRefresh(video);
    });

    popover.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
    });

    popover.appendChild(watchedButton);
    popover.appendChild(hideVideoButton);
    popover.appendChild(hideChannelButton);

    menuWrap.appendChild(menu);
    menuWrap.appendChild(popover);

    meta.appendChild(avatar);
    meta.appendChild(text);
    meta.appendChild(menuWrap);

    card.appendChild(thumbnailWrap);
    card.appendChild(meta);

    grid.appendChild(card);
  }

  container.appendChild(grid);

  if (myToken !== renderToken) return;

  removeCustomHome();
  browse.prepend(container);

  requestAnimationFrame(() => {
    alignWeekHeader();
    ensureWeekHeaderListeners();
  });

  if (!options.preserveScroll) {
    window.scrollTo(0, 0);
  }

  markModeReady();
}

function closeAllVideoMenus(except = null) {
  document
    .querySelectorAll(`#${CUSTOM_HOME_ID} .better-feed-menu-wrap.open`)
    .forEach(menuWrap => {
      if (menuWrap !== except) {
        menuWrap.classList.remove("open");
      }
    });
}

document.addEventListener("click", event => {
  const target = event.target;

  if (
    target instanceof Element &&
    target.closest(`#${CUSTOM_HOME_ID} .better-feed-menu-wrap`)
  ) {
    return;
  }

  closeAllVideoMenus();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeAllVideoMenus();
  }
});

/* ---------- THUMBNAILS ---------- */

function applyThumbnailFallbacks(img, video) {
  const candidates = getThumbnailCandidates(video);

  img.dataset.fallbackIndex = "0";
  img.dataset.thumbnailCandidates = JSON.stringify(candidates);

  const advance = () => {
    const list = JSON.parse(img.dataset.thumbnailCandidates || "[]");
    let index = Number(img.dataset.fallbackIndex || "0");

    index += 1;
    img.dataset.fallbackIndex = String(index);

    if (list[index]) {
      img.src = list[index];
    }
  };

  img.onerror = advance;

  img.onload = () => {
    if (img.naturalWidth <= 120 && img.naturalHeight <= 90) {
      advance();
    }
  };

  img.src = candidates[0] || "";
}

function getThumbnailCandidates(video) {
  const videoId = video.videoId || getVideoIdFromUrl(video.url);
  const candidates = [];

  if (video.pageThumbnail && isThumbnailForVideo(video.pageThumbnail, videoId)) {
    candidates.push(decodeHtml(video.pageThumbnail));
  }

  if (video.thumbnail && isThumbnailForVideo(video.thumbnail, videoId)) {
    candidates.push(decodeHtml(video.thumbnail));
  }

  if (videoId) {
    candidates.push(`https://i.ytimg.com/vi/${videoId}/hq720.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/sddefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/default.jpg`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function isThumbnailForVideo(url, videoId) {
  if (!url || !videoId) return false;

  const decoded = decodeHtml(url);

  return decoded.includes("i.ytimg.com") && decoded.includes(`/vi/${videoId}/`);
}

/* ---------- BASIC HELPERS ---------- */

function decodeHtml(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value || "";
  return textarea.value;
}

// "10:32" → 632, "1:02:30" → 3750, "" → 0. Used to recover video duration
// for the progress bar when only the bare position is in sync (no duration).
function parseDurationString(value) {
  if (!value || typeof value !== "string") return 0;
  const parts = value.split(":").map(p => parseInt(p, 10));
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// MARKER_HASHES / markerHashForMode / markerUrlForMode live in shared.js.

function isMarkerPage() {
  return MARKER_HASHES.has(location.hash);
}

// Keep the URL hash in sync with the active mode whenever we're on a
// marker page. Used after mode picks, cross-tab mode changes, and on
// initial load (in case the dNR rule landed us on a stale hash).
function syncUrlToMode() {
  if (!isMarkerPage()) return;
  const targetHash = markerHashForMode(currentMode);
  if (location.hash === targetHash) return;
  try {
    history.replaceState(
      null,
      "",
      location.pathname + location.search + targetHash
    );
  } catch {}
}

function getHomeBrowse() {
  if (location.pathname === "/") {
    return document.querySelector('ytd-browse[page-subtype="home"]');
  }
  if (isMarkerPage()) {
    return document.querySelector("ytd-browse");
  }
  return null;
}

// Render prologue shared by every function that injects into the home browse
// container: returns the container, or null after lifting the pre-ready
// dark-fade. If the container isn't mounted yet, calling markModeReady() here
// ensures the page can never get stuck dark/unclickable; a later update()
// re-renders once the DOM is ready.
function ensureBrowseOrReturn() {
  const browse = getHomeBrowse();
  if (!browse) { markModeReady(); return null; }
  return browse;
}

// Pin a fixed-position popover just below and right-aligned to a button.
function positionPopoverBelowButton(popover, refElement) {
  const rect = refElement.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 8}px`;
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
}

function isHomePage() {
  if (location.pathname === "/") {
    return !!document.querySelector('ytd-browse[page-subtype="home"]');
  }
  if (isMarkerPage()) {
    return !!document.querySelector("ytd-browse");
  }
  return false;
}

function applyMarkerModeClass() {
  const onMarker = isMarkerPage();
  const wantsMarkerStyling =
    onMarker &&
    (currentMode === MODE_WATCH ||
      isWorkLikeMode(currentMode) ||
      currentMode === null);
  document.documentElement.classList.toggle("better-feed-marker-mode", wantsMarkerStyling);
  document.documentElement.classList.toggle(
    "better-feed-work-mode",
    isWorkLikeMode(currentMode)
  );
  // Watch mode keeps the expanded sidebar usable but suppresses the
  // collapsed mini-guide (Home/Shorts/Subscriptions icons). The expanded
  // ytd-guide-renderer is unaffected — only the mini-guide is hidden, so
  // collapsing the drawer leaves a clean empty rail.
  document.documentElement.classList.toggle(
    "better-feed-watch-mode",
    currentMode === MODE_WATCH
  );
}

// Returns a Promise that resolves once the sidebar is in its target
// state (or we've given up trying). markModeReady awaits this before
// lifting pre-ready, so the drawer animation plays invisibly and the
// user only ever sees the final state.
function applyDefaultSidebarForMode(mode) {
  return new Promise(resolve => {
    if (!mode || !isMarkerPage()) {
      resolve();
      return;
    }
    const wantOpen = mode === MODE_WATCH;
    const DRAWER_ANIM_MS = 280;
    let retries = 30;

    function attempt() {
      const drawer = document.querySelector("tp-yt-app-drawer");
      if (!drawer) {
        if (retries-- > 0) {
          setTimeout(attempt, 50);
        } else {
          resolve();
        }
        return;
      }
      const isOpen = drawer.hasAttribute("opened");
      if (isOpen === wantOpen) {
        resolve();
        return;
      }
      const btn =
        document.querySelector("ytd-masthead #guide-button button") ||
        document.querySelector("ytd-masthead button#guide-button") ||
        document.querySelector('ytd-masthead button[aria-label="Guide"]');
      if (!btn) {
        if (retries-- > 0) {
          setTimeout(attempt, 50);
        } else {
          resolve();
        }
        return;
      }
      // Temporarily lift pre-ready so YT's click handler runs against
      // an interactive ytd-app. The class is restored synchronously
      // before the browser paints, so this is invisible.
      const html = document.documentElement;
      const wasPreReady = html.classList.contains("better-feed-pre-ready");
      if (wasPreReady) html.classList.remove("better-feed-pre-ready");
      btn.click();
      if (wasPreReady) html.classList.add("better-feed-pre-ready");
      // Wait for Polymer's drawer animation to finish, then resolve.
      setTimeout(resolve, DRAWER_ANIM_MS);
    }
    attempt();
  });
}

let pendingSidebarMode = null;
let markModeReadyInFlight = false;

async function markModeReady() {
  // Apply the queued sidebar default BEFORE lifting pre-ready so the
  // drawer animation plays out invisibly. Idempotent — multiple render
  // functions call this and only the first run does the apply.
  if (pendingSidebarMode && !markModeReadyInFlight) {
    markModeReadyInFlight = true;
    const mode = pendingSidebarMode;
    pendingSidebarMode = null;
    try {
      await applyDefaultSidebarForMode(mode);
    } catch {}
  }
  document.documentElement.classList.remove("better-feed-pre-ready");
}

function pauseAllVideos() {
  document.querySelectorAll("video").forEach(v => {
    try { v.pause(); } catch {}
  });
}

/* ---------- REFRESH SCHEDULE ---------- */

function getWeekStartDate(settings, now = new Date(getNow())) {
  const today = now.getDay();
  const refreshDay = settings.refreshDay;
  const refreshHour = settings.refreshHour;

  let daysBack = (today - refreshDay + 7) % 7;
  if (today === refreshDay && now.getHours() < refreshHour) {
    daysBack = 7;
  }

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysBack);
  return start;
}

const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const MONTH_NAMES_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const DAY_NAMES_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
];

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function formatLongDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  const day = DAY_NAMES_LONG[date.getDay()];
  const month = MONTH_NAMES_LONG[date.getMonth()];
  const d = date.getDate();
  return `${day}, ${month} ${d}${ordinalSuffix(d)}`;
}

function getLastRefreshDate(settings, fromDate = new Date(getNow())) {
  const mode = settings.refreshMode || "weekly";
  const refreshHour = settings.refreshHour;

  if (mode === "daily") {
    const d = new Date(fromDate);
    d.setHours(refreshHour, 0, 0, 0);
    if (d > fromDate) d.setDate(d.getDate() - 1);
    return d;
  }

  const days =
    mode === "multi" &&
    Array.isArray(settings.refreshDays) &&
    settings.refreshDays.length > 0
      ? settings.refreshDays
      : [settings.refreshDay];

  let bestMs = -Infinity;
  let bestDate = null;
  for (const day of days) {
    const candidate = new Date(fromDate);
    const daysBack = (candidate.getDay() - day + 7) % 7;
    candidate.setDate(candidate.getDate() - daysBack);
    candidate.setHours(refreshHour, 0, 0, 0);
    if (candidate > fromDate) candidate.setDate(candidate.getDate() - 7);
    if (candidate.getTime() > bestMs) {
      bestMs = candidate.getTime();
      bestDate = candidate;
    }
  }
  return bestDate;
}

function formatWeekRange(settings, now = new Date(getNow())) {
  const mode = settings.refreshMode || "weekly";

  if (mode === "daily") {
    return formatLongDate(now);
  }

  if (mode === "multi") {
    const last = getLastRefreshDate(settings, now);
    const nextMs = getNextRefreshTime(settings, now);
    const endDay = new Date(nextMs);
    endDay.setDate(endDay.getDate() - 1);
    if (!last) return "";
    return `Feed for ${formatLongDate(last)} to ${formatLongDate(endDay)}`;
  }

  // Weekly: existing "Week of MMM D-D" / cross-month layout.
  const start = getWeekStartDate(settings, now);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  if (start.getMonth() === end.getMonth()) {
    return `Week of ${MONTH_NAMES_SHORT[start.getMonth()]} ${start.getDate()}-${end.getDate()}`;
  }
  return `Week of ${MONTH_NAMES_SHORT[start.getMonth()]} ${start.getDate()} - ${MONTH_NAMES_SHORT[end.getMonth()]} ${end.getDate()}`;
}

// getNextRefreshTime and getStoredWeeklyVideos moved to shared.js (the
// background owns the refresh and needs them); referenced via shared global scope.

/* ---------- WEEKLY VIDEO METADATA REBUILD (post-sync hydration) ---------- */
// Sync ships the weekly grid as IDs only — title/channel are recovered via
// YouTube's oEmbed endpoint after the IDs land locally. Stubs (entries with
// empty title) get filled in here. Thumbnails work without metadata because
// applyThumbnailFallbacks derives URLs from the videoId.

const VIDEO_METADATA_REBUILD_CONCURRENCY = 4;
let videoMetadataRebuildInFlight = false;

// fetchVideoMetadataFromOEmbed lives in shared.js (the popup and options
// page use the same fetcher).

// Single helper used by both the channel-avatar and watch-metrics paths.
// Streams the response, runs the extractor on the growing buffer, and
// cancels the moment the extractor returns a hit — typical read is 8–32 KB
// vs the 1–2 MB the full page would be. If streaming finishes without a
// match (rare; happens when the target data is past the scan cap), falls
// back to a full-body fetch so the call is guaranteed to land any data
// that exists in the page at all.
async function fetchAndExtractFromPage(url, maxBytes, extractor) {
  // Streaming pass.
  try {
    const resp = await fetch(url, { credentials: "omit" });
    if (resp.ok && resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buf = "";
      let result = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          result = extractor(buf);
          if (result) break;
          if (buf.length >= maxBytes) break;
        }
      } finally {
        try { reader.cancel(); } catch (_) {}
      }
      if (result) return result;
    }
  } catch (_) { /* fall through to full body */ }
  // Full-body fallback. Slower but bounded — guarantees we don't miss
  // anything the page actually contained.
  try {
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) return null;
    const html = await resp.text();
    return extractor(html);
  } catch (_) {
    return null;
  }
}

const CHANNEL_HTML_SCAN_LIMIT = 256 * 1024;
const VIDEO_WATCH_SCAN_LIMIT = 256 * 1024;

async function fetchChannelAvatarFromUrl(channelUrl) {
  if (!channelUrl) return null;
  return fetchAndExtractFromPage(
    channelUrl,
    CHANNEL_HTML_SCAN_LIMIT,
    extractChannelAvatarFromHtml
  );
}

async function fetchVideoMetricsFromWatchPage(videoId) {
  if (!videoId) return null;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return fetchAndExtractFromPage(url, VIDEO_WATCH_SCAN_LIMIT, extractVideoMetricsFromHtml);
}

function extractVideoMetricsFromHtml(html) {
  if (!html) return null;
  const detailsIdx = html.indexOf('"videoDetails":');
  if (detailsIdx === -1 && !html.includes('"publishDate":')) return null;

  // videoDetails has nested objects (e.g., thumbnail), so we can't scope by
  // the next "}". Just grab a generous window after the marker — the simple
  // string fields we want are all within the first ~6 KB.
  const block = detailsIdx >= 0
    ? html.substring(detailsIdx, Math.min(detailsIdx + 8192, html.length))
    : "";

  const viewCountStr = extractJsonStringField(block, "viewCount");
  const lengthSecondsStr = extractJsonStringField(block, "lengthSeconds");
  const viewCount = viewCountStr ? parseInt(viewCountStr, 10) || 0 : 0;
  const lengthSeconds = lengthSecondsStr ? parseInt(lengthSecondsStr, 10) || 0 : 0;

  // publishDate lives in `microformat.playerMicroformatRenderer`, separate
  // from videoDetails. Format is "YYYY-MM-DD".
  const publishDateMatch = html.match(/"publishDate":"([^"]+)"/);
  const publishDate = publishDateMatch ? publishDateMatch[1] : "";

  // Members-only / members-first detection. YouTube exposes this through
  // several markers in the SSR'd JSON; checking each independently catches
  // the cases the home-grid scrape can't pick up (some grids strip the
  // visible badge but the watch page always has the underlying signal).
  const membersOnly =
    /"BADGE_STYLE_TYPE_MEMBERS_ONLY"/.test(html) ||
    /"BADGE_STYLE_TYPE_MEMBERS_FIRST/.test(html) ||
    /badge-style-type-members-only/i.test(html) ||
    /"label":"Members (?:only|first)"/i.test(html) ||
    /"isMembersOnly":\s*true/i.test(html);

  // Live detection — videoDetails carries a few authoritative flags.
  // `isLiveContent` catches past-live-stream VODs too; `isLive` is the
  // current-live signal; `isUpcoming` covers scheduled premieres/streams.
  const isLive =
    /"isLive":\s*true/i.test(block) ||
    /"isLiveNow":\s*true/i.test(block) ||
    /"isUpcoming":\s*true/i.test(block) ||
    /"isLiveContent":\s*true/i.test(block) ||
    /"isLiveBroadcast":\s*true/i.test(block) ||
    /"BADGE_STYLE_TYPE_LIVE_NOW"/.test(html);

  if (viewCount === 0 && lengthSeconds === 0 && !publishDate && !membersOnly && !isLive) return null;
  return { viewCount, lengthSeconds, publishDate, membersOnly, isLive };
}

// Match a JSON string field (handles backslash-escapes inside the value).
function extractJsonStringField(json, field) {
  if (!json) return "";
  // "field":"value-with-maybe-escaped-quotes"
  const re = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*?)"`);
  const m = json.match(re);
  if (!m) return "";
  return m[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

// Apply watch-page-derived metrics to the stored grid: builds the
// "X views • Y ago" string and the "MM:SS" duration. Only fills in
// fields that are currently empty so we never clobber the rich data
// that the original scrape produced.
async function applyVideoMetricsToStorage(metricsByVideoId) {
  if (!metricsByVideoId || Object.keys(metricsByVideoId).length === 0) return;
  const current = await getStoredWeeklyVideos();
  if (!Array.isArray(current.videos) || current.videos.length === 0) return;

  let changed = false;
  const updated = current.videos.map(v => {
    if (!v || !v.videoId) return v;
    const m = metricsByVideoId[v.videoId];
    if (!m) return v;

    let nextDuration = v.duration;
    if (!nextDuration && m.lengthSeconds > 0) {
      nextDuration = formatDurationFromSeconds(m.lengthSeconds) || v.duration;
    }

    let nextMetadata = v.metadata;
    if (!nextMetadata) {
      const parts = [];
      if (m.viewCount > 0) parts.push(`${formatViewCount(m.viewCount)} views`);
      const dateStr = formatPublishDate(m.publishDate);
      if (dateStr) parts.push(dateStr);
      if (parts.length > 0) nextMetadata = parts.join(" • ");
    }

    // Members-only: promote to true if the watch page revealed it, but never
    // demote (we trust a positive detection over a missing one). Stamp the
    // check time so we don't re-scan on every load.
    const nextMembersOnly = v.membersOnly || !!m.membersOnly;
    // Live: same promote-only logic. Watch page's videoDetails flag is the
    // most authoritative signal we have.
    const nextIsLive = v.isLive || !!m.isLive;
    const nextChecked = Date.now();

    if (
      nextDuration === v.duration &&
      nextMetadata === v.metadata &&
      nextMembersOnly === !!v.membersOnly &&
      nextIsLive === !!v.isLive &&
      v.membersOnlyCheckedAt
    ) {
      return v;
    }
    changed = true;
    return {
      ...v,
      duration: nextDuration || "",
      metadata: nextMetadata || "",
      membersOnly: nextMembersOnly,
      isLive: nextIsLive,
      membersOnlyCheckedAt: nextChecked
    };
  });

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_VIDEOS_KEY]: updated });
  }
}

// Iterate all <meta> tags looking for one with property="og:image", then
// pull its content attribute. Doing it this way means attribute order
// (property-first or content-first) doesn't matter. Falls back to
// <link rel="image_src"> and the avatar field inside ytInitialData.
function extractChannelAvatarFromHtml(html) {
  if (!html) return null;
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/property\s*=\s*["']og:image["']/i.test(tag)) continue;
    const cm = tag.match(/content\s*=\s*["']([^"']+)["']/i);
    if (cm && cm[1]) return cm[1];
  }
  m = html.match(
    /<link\s+[^>]*rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i
  );
  if (m && m[1]) return m[1];
  m = html.match(/"avatar":\s*\{[^}]*"thumbnails":\s*\[\s*\{\s*"url":\s*"([^"]+)"/);
  if (m && m[1]) return m[1].replace(/\\u0026/g, "&");
  return null;
}

// Apply oEmbed results to the stored grid in a single write. Re-reads first
// to avoid clobbering a fresh weekly refresh that might have landed mid-fetch.
// Fills in any missing field individually (title, channelName, channelUrl) so
// a card with a title but no channel info — typical of the multi-channel
// byline scrape miss — still gets repaired.
async function applyOEmbedResultsToStorage(oEmbedByVideoId) {
  if (Object.keys(oEmbedByVideoId).length === 0) return;
  const current = await getStoredWeeklyVideos();
  if (!Array.isArray(current.videos) || current.videos.length === 0) return;
  let changed = false;
  const updated = current.videos.map(v => {
    if (!v || !v.videoId) return v;
    const meta = oEmbedByVideoId[v.videoId];
    if (!meta) return v;
    const nextTitle = v.title || meta.title || "";
    const nextChannelName = v.channelName || meta.channelName || "";
    const nextChannelUrl = v.channelUrl || meta.channelUrl || "";
    if (
      nextTitle === v.title &&
      nextChannelName === v.channelName &&
      nextChannelUrl === v.channelUrl
    ) {
      return v;
    }
    changed = true;
    return {
      ...v,
      title: nextTitle,
      channelName: nextChannelName,
      channelUrl: nextChannelUrl
    };
  });
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_VIDEOS_KEY]: updated });
  }
}

async function applyAvatarsToStorage(avatarsByChannelUrl) {
  if (Object.keys(avatarsByChannelUrl).length === 0) return;
  const current = await getStoredWeeklyVideos();
  if (!Array.isArray(current.videos) || current.videos.length === 0) return;
  let changed = false;
  const updated = current.videos.map(v => {
    if (!v || !v.videoId || v.avatar) return v;
    const url = v.channelUrl;
    if (!url) return v;
    const avatar = avatarsByChannelUrl[url];
    if (!avatar) return v;
    changed = true;
    return { ...v, avatar };
  });
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_VIDEOS_KEY]: updated });
  }
}

// Bounded pool — runs jobs with at most N in flight at once. Lets us share a
// concurrency budget across the two phases instead of waiting for one to
// finish before the next starts.
async function runWithConcurrency(jobs, limit) {
  const results = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      try { results[i] = await jobs[i](); } catch (_) { results[i] = null; }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, jobs.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function rebuildVideoMetadataIfNeeded() {
  if (videoMetadataRebuildInFlight) return;
  const stored = await getStoredWeeklyVideos();
  if (!Array.isArray(stored.videos) || stored.videos.length === 0) return;
  // A video needs work if it's missing any display field OR if it's never
  // had its members-only / live status verified against the watch page
  // (covers the case where the home-grid scrape didn't see the badge).
  const stubs = stored.videos.filter(
    v => v && v.videoId && (
      !v.title || !v.channelName || !v.channelUrl ||
      !v.avatar || !v.metadata || !v.duration ||
      !v.membersOnlyCheckedAt || v.isLive === undefined
    )
  );
  if (stubs.length === 0) return;

  videoMetadataRebuildInFlight = true;
  try {
    // Three parallel phases. Each applies its own results to storage as it
    // completes, so the grid populates progressively: titles in ~1 s,
    // then view/date/duration and avatars over the next few seconds.

    // PHASE 1 — oEmbed for titles + channel info. Fast (~1 KB per video).
    // Also runs for entries that have a title but are missing channelName or
    // channelUrl — multi-channel bylines (collabs, fundraisers) can confuse
    // the home-grid scrape, and oEmbed's author_name/author_url always points
    // at the primary channel, so this is the cleanest backfill.
    const titlePhase = (async () => {
      const results = {};
      const jobs = stubs
        .filter(v => !v.title || !v.channelName || !v.channelUrl)
        .map(stub => async () => {
          const meta = await fetchVideoMetadataFromOEmbed(stub.videoId);
          if (meta) results[stub.videoId] = meta;
        });
      await runWithConcurrency(jobs, VIDEO_METADATA_REBUILD_CONCURRENCY);
      await applyOEmbedResultsToStorage(results);
      return results;
    })();

    // PHASE 2 — watch page for view count / publish date / duration /
    // members-only flag. One fetch per video; videoDetails sits near the top
    // of body and member-badge JSON sits in the same fetch.
    const metricsPhase = (async () => {
      const results = {};
      const jobs = stubs
        .filter(v => !v.metadata || !v.duration || !v.membersOnlyCheckedAt || v.isLive === undefined)
        .map(stub => async () => {
          const m = await fetchVideoMetricsFromWatchPage(stub.videoId);
          if (m) results[stub.videoId] = m;
        });
      await runWithConcurrency(jobs, VIDEO_METADATA_REBUILD_CONCURRENCY);
      await applyVideoMetricsToStorage(results);
    })();

    // PHASE 3 — channel pages for avatars, deduped by channel URL.
    // We need channelUrl before we can fetch, which for stubs comes from
    // phase 1. Wait for phase 1 to finish before kicking off phase 3.
    const avatarPhase = (async () => {
      const titleResults = await titlePhase;
      const channelUrls = new Set();
      for (const v of stubs) {
        if (v.avatar) continue;
        const url = v.channelUrl || titleResults[v.videoId]?.channelUrl;
        if (url) channelUrls.add(url);
      }
      const results = {};
      const jobs = [...channelUrls].map(url => async () => {
        const avatar = await fetchChannelAvatarFromUrl(url);
        if (avatar) results[url] = avatar;
      });
      await runWithConcurrency(jobs, VIDEO_METADATA_REBUILD_CONCURRENCY);
      await applyAvatarsToStorage(results);
    })();

    await Promise.all([titlePhase, metricsPhase, avatarPhase]);
  } catch (_) {
    // Swallow; we'll try again on the next trigger.
  } finally {
    videoMetadataRebuildInFlight = false;
  }
}

/* ---------- HIDDEN VIDEO / CHANNEL HELPERS ---------- */

function getChannelHideKey(video) {
  const channelUrl = decodeHtml(video?.channelUrl || "").trim().toLowerCase();

  if (channelUrl) {
    return channelUrl;
  }

  const channelName = decodeHtml(video?.channelName || "").trim().toLowerCase();

  if (channelName) {
    return `name:${channelName}`;
  }

  return "";
}

// isVideoHidden and filterHiddenVideos moved to shared.js (background filters
// before saving); they use shared's non-DOM decodeHtmlEntities.

async function hideVideoAndRefresh(video) {
  if (!video?.videoId) return;
  await modifyHidden(state => {
    state.videos.add(video.videoId);
    state.metadata[video.videoId] = {
      type: "video",
      title: video.title,
      channelName: video.channelName
    };
  });
}

async function toggleWatchedAndRefresh(video, watched) {
  if (!video?.videoId) return;
  // Mark-as-unwatched clears any stored playback position first so the
  // progress bar (rendered from STORAGE_PROGRESS_KEY) disappears in the
  // same render pass triggered by the watched-state change below.
  if (!watched) {
    await clearVideoProgress(video.videoId).catch(() => {});
  }
  await modifyWatched(set => {
    if (watched) set.add(video.videoId);
    else set.delete(video.videoId);
  });
}

async function hideChannelAndRefresh(video) {
  const channelKey = getChannelHideKey(video);

  await modifyHidden(state => {
    if (channelKey) {
      state.channels.add(channelKey);
      state.metadata[channelKey] = {
        type: "channel",
        channelName: video.channelName
      };
    } else if (video?.videoId) {
      state.videos.add(video.videoId);
      state.metadata[video.videoId] = {
        type: "video",
        title: video.title,
        channelName: video.channelName
      };
    }
  });
}

async function refreshVisibleVideosAfterHide() {
  if (!isHomePage()) return;

  const [stored, settings] = await Promise.all([
    getStoredWeeklyVideos(),
    getSettings()
  ]);

  if (!settings.enabled || !settings.weeklyHomeEnabled) {
    removeCustomHome();
    return;
  }

  let storedVideos = Array.isArray(stored.videos) ? stored.videos : [];
  if (settings.excludeLiveVideos !== false) {
    storedVideos = storedVideos.filter(v => !videoLooksLive(v));
  }

  // If filtering emptied the grid (e.g. every remaining video is live with
  // excludeLiveVideos on), don't paint an empty grid — hand off to update()
  // so renderFromStorage shows the loader / retry / nudge as appropriate.
  if (storedVideos.length === 0) {
    update();
    return;
  }

  await renderCustomHome(
    storedVideos.slice(0, settings.videoCount),
    { preserveScroll: true }
  );
}

/* ---------- URL HELPERS ---------- */

function getVideoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

/* ---------- METADATA FORMATTING ---------- */

function formatDurationFromSeconds(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatIsoDuration(value) {
  const hoursMatch = value.match(/(\d+)H/);
  const minutesMatch = value.match(/(\d+)M/);
  const secondsMatch = value.match(/(\d+)S/);

  const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  const minutes = minutesMatch ? Number(minutesMatch[1]) : 0;
  const seconds = secondsMatch ? Number(secondsMatch[1]) : 0;

  return formatDurationFromSeconds(hours * 3600 + minutes * 60 + seconds);
}

function formatPublishDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 0) {
    return "today";
  }

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years >= 1) return `${years} ${years === 1 ? "year" : "years"} ago`;
  if (months >= 1) return `${months} ${months === 1 ? "month" : "months"} ago`;
  if (weeks >= 1) return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"} ago`;
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  if (minutes >= 1) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

  return "just now";
}

function formatViewCount(value) {
  if (!Number.isFinite(value)) return "";

  if (value >= 1_000_000_000) return `${trimNumber(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}K`;

  return String(value);
}

function trimNumber(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

/* ---------- WEEKLY GRID RENDER (pure; background owns the refresh) ---------- */
// content.js no longer fetches, scrapes, bounces, or saves the weekly grid.
// The background owns the entire refresh (fetch youtube.com -> parse
// ytInitialData -> filter/pick -> save) and writes STORAGE_REFRESH_STATUS_KEY.
// This function only READS storage and paints: the grid, the "Refreshing…"
// loader, or a quiet retry message. It re-runs reactively via the
// storage.onChanged listener whenever the background saves videos or flips
// the status. It never returns null, never navigates, never writes the grid.

// One refresh nudge per page load (see below). Reset implicitly each load
// because content scripts re-evaluate this module on every navigation.
let requestedEnsureFreshThisLoad = false;

async function renderFromStorage() {
  const [settings, stored, hidden, statusData] = await Promise.all([
    getSettings(),
    getStoredWeeklyVideos(),
    getHiddenItems(),
    chrome.storage.local.get(STORAGE_REFRESH_STATUS_KEY)
  ]);

  const storedVideos = Array.isArray(stored.videos) ? stored.videos : [];
  const hasUsableVideos =
    storedVideos.length > 0 &&
    storedVideos.every(v => v?.title && v?.videoId);

  if (hasUsableVideos) {
    let visible = filterHiddenVideos(storedVideos, hidden);
    if (settings.excludeLiveVideos !== false) {
      visible = visible.filter(v => !videoLooksLive(v));
    }
    if (visible.length > 0) {
      await renderCustomHome(visible.slice(0, settings.videoCount));
      return;
    }
    // Stored videos exist but hidden/live filters emptied them — fall through
    // to the loader/retry + nudge below rather than painting an empty grid.
  }

  // No usable grid yet. Pick the loader vs. a quiet retry message from the
  // background-owned refresh status. We never show a terminal "reload to try
  // again" error — the background retries on its alarm and the storage
  // onChanged re-renders us when videos land.
  const status = statusData[STORAGE_REFRESH_STATUS_KEY];
  const state = status && status.state;
  if (state === "error") {
    renderLoadingMessage("Couldn't load this week's videos — retrying shortly.");
  } else {
    renderRefreshingLoading();
  }

  // Fire-and-forget nudge so the background fetches now even if its event
  // page was asleep (cold start / first run / SW evicted). Idempotent: the
  // background's in-flight lock + refresh-due check make a duplicate or
  // already-fresh call a no-op. One send per load; skip while a refresh is
  // already in flight. onHomePage's gates guarantee we're in Watch mode with
  // the extension + weekly home enabled before we get here.
  if (!requestedEnsureFreshThisLoad && state !== "refreshing") {
    requestedEnsureFreshThisLoad = true;
    chrome.runtime.sendMessage({ type: "better-feed-ensure-fresh" }).catch(() => {});
  }
}

/* ---------- MAIN ---------- */

async function onHomePage() {
  if (updateInProgress) {
    updatePendingAfterCurrent = true;
    return;
  }
  updateInProgress = true;

  try {
    if (coldStartActive) {
      if (coldStartAwaitingChoice) {
        if (coldStartView === "refresh-schedule") {
          renderColdStartRefreshSchedule();
        } else if (coldStartView === "refresh-custom") {
          renderColdStartRefreshCustom();
        } else if (coldStartView === "sync-failed") {
          renderColdStartSyncFailed();
        } else {
          renderColdStartSetup();
        }
      } else {
        renderColdStartLoading();
      }
      return;
    }

    if (!modeLoaded) {
      // Mode has not yet been read from chrome.storage. Never run a
      // mode-specific render against a stale or null currentMode — this is
      // the exact window where a Work pick could transiently fall through to
      // a Watch-only weekly refresh. loadCurrentMode (init) and the mode
      // onChanged branch both set modeLoaded; a deferred/subsequent update()
      // re-runs this path once the mode is definitively known.
      applyMarkerModeClass();
      return;
    }

    if (isWorkLikeMode(currentMode)) {
      renderWorkPlaceholder();
      return;
    }

    if (!isWatchModeActive()) {
      removeCustomHome();
      if (currentMode) markModeReady();
      return;
    }
    const settings = await getSettings();
    if (!settings.enabled || !settings.weeklyHomeEnabled) {
      removeCustomHome();
      markModeReady();
      return;
    }

    const dailyState = await getDailyState(settings);
    const grace = await getDailyGrace(settings);
    const graceActive = isGraceActiveForLocation(grace, location);
    if (isDailyLimitHit(dailyState, settings) && !graceActive) {
      renderSeeYouTomorrow(settings);
      return;
    }

    // Pure render from storage. The background owns the refresh and writes
    // videos + STORAGE_REFRESH_STATUS_KEY; this paints whatever's there (grid /
    // loader / quiet retry) and nudges the background once if a refresh is due.
    await renderFromStorage();
  } finally {
    updateInProgress = false;
    // If anything tried to run an update while this one was in-flight, honor
    // it now — concurrent storage.onChanged events queue up while
    // renderFromStorage awaits its reads + DOM work, and dropping the pending
    // request would leave the UI stale.
    if (updatePendingAfterCurrent) {
      updatePendingAfterCurrent = false;
      // Defer to the next microtask so the finally fully unwinds first.
      Promise.resolve().then(() => onHomePage());
    }
  }
}

function onNonHomePage() {
  removeCustomHome();
  markModeReady();
}

const COLD_START_TIMEOUT_MS = 5000;
const COLD_START_POLL_MS = 1000;
let coldStartActive = false;
let coldStartAwaitingChoice = false;
let coldStartView = "sync-prompt"; // "sync-prompt" | "refresh-schedule" | "refresh-custom" | "sync-failed"
let coldStartTimer = null;
let coldStartPollTimer = null;
let coldStartReceived = { videos: false, settings: false };
let coldStartDraftSettings = null;

function startColdStartPolling() {
  if (coldStartPollTimer) return;
  coldStartPollTimer = setInterval(async () => {
    if (!coldStartActive) {
      stopColdStartPolling();
      return;
    }
    try { await hydrateFromSync(); } catch (_) {}
  }, COLD_START_POLL_MS);
}

function stopColdStartPolling() {
  if (coldStartPollTimer) {
    clearInterval(coldStartPollTimer);
    coldStartPollTimer = null;
  }
}

async function detectColdStart() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, STORAGE_VIDEOS_KEY]);
  const noSettings = !data[SETTINGS_KEY];
  const noVideos = !Array.isArray(data[STORAGE_VIDEOS_KEY]) || data[STORAGE_VIDEOS_KEY].length === 0;
  return noSettings && noVideos;
}

function endColdStart() {
  if (!coldStartActive) return;
  coldStartActive = false;
  coldStartAwaitingChoice = false;
  coldStartView = "sync-prompt";
  coldStartDraftSettings = null;
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
  stopColdStartPolling();
  update();
  maybeShowModePicker();
}

async function maybeReEnterColdStart() {
  if (coldStartActive) return;
  if (!(await detectColdStart())) return;
  coldStartActive = true;
  coldStartAwaitingChoice = true;
  coldStartView = "sync-prompt";
  coldStartDraftSettings = null;
  coldStartReceived = { videos: false, settings: false };
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
  // Also stop any poll timer left over from a prior cold-start session — the
  // `if (coldStartPollTimer) return` guard in startColdStartPolling prevents
  // a duplicate but not an orphan still calling hydrateFromSync on a loop.
  stopColdStartPolling();
  update();
}

function checkColdStartDataReady() {
  if (!coldStartActive) return;
  if (coldStartAwaitingChoice) return;
  // Either videos OR settings arriving is enough to end cold start. Without
  // this, a sender device that hasn't yet pushed its weekly grid (only the
  // settings landed) would leave the receiver stuck on the "No sync data
  // found" view and risk a fresh-install that overwrites the synced settings.
  if (coldStartReceived.videos || coldStartReceived.settings) {
    endColdStart();
  }
}

function renderLoadingMessage(text) {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const message = document.createElement("div");
  message.className = "better-feed-cold-start";
  message.textContent = text;
  container.appendChild(message);

  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

function renderColdStartLoading() {
  renderLoadingMessage("Loading from synced data…");
}

function renderRefreshingLoading() {
  renderLoadingMessage("Refreshing weekly videos…");
}

function renderColdStartSetup() {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const wrap = document.createElement("div");
  wrap.className = "better-feed-setup";

  const title = document.createElement("div");
  title.className = "better-feed-setup-title";
  title.textContent = "Welcome to BetterFeed";

  const sub = document.createElement("div");
  sub.className = "better-feed-setup-sub";
  sub.textContent = "Are you syncing from another browser that already has this week's videos loaded?";

  const buttons = document.createElement("div");
  buttons.className = "better-feed-setup-buttons";

  const yesBtn = document.createElement("button");
  yesBtn.className = "better-feed-setup-button better-feed-setup-primary";
  yesBtn.textContent = "Yes, wait for sync";
  yesBtn.addEventListener("click", onColdStartChoiceYes);

  const noBtn = document.createElement("button");
  noBtn.className = "better-feed-setup-button";
  noBtn.textContent = "No, fresh install (first time user)";
  noBtn.addEventListener("click", onColdStartChoiceNo);

  buttons.appendChild(yesBtn);
  buttons.appendChild(noBtn);

  wrap.appendChild(title);
  wrap.appendChild(sub);
  wrap.appendChild(buttons);
  container.appendChild(wrap);

  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

async function onColdStartChoiceYes() {
  if (!coldStartActive) return;
  coldStartAwaitingChoice = false;

  try {
    const data = await chrome.storage.local.get([SETTINGS_KEY, STORAGE_VIDEOS_KEY]);
    if (data[SETTINGS_KEY]) coldStartReceived.settings = true;
    if (Array.isArray(data[STORAGE_VIDEOS_KEY]) && data[STORAGE_VIDEOS_KEY].length > 0) {
      coldStartReceived.videos = true;
    }
  } catch (_) {}
  checkColdStartDataReady();
  if (!coldStartActive) return;

  if (!coldStartTimer) {
    coldStartTimer = setTimeout(onSyncWaitTimedOut, COLD_START_TIMEOUT_MS);
  }
  startColdStartPolling();
  hydrateFromSync().catch(() => {});
  update();
}

function onSyncWaitTimedOut() {
  if (!coldStartActive) return;
  // If sync data did arrive while we were waiting, let the normal end path
  // take over so the user goes straight to their hydrated grid.
  if (coldStartReceived.videos) {
    endColdStart();
    return;
  }
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
  stopColdStartPolling();
  coldStartAwaitingChoice = true;
  coldStartView = "sync-failed";
  update();
}

async function retryColdStartSync() {
  if (!coldStartActive) return;
  coldStartView = "sync-prompt";
  coldStartAwaitingChoice = false;
  coldStartReceived = { videos: false, settings: false };

  // Data may have landed in local storage after the previous timeout fired.
  // Catch that here so the retry can short-circuit instead of waiting again.
  try {
    const data = await chrome.storage.local.get([SETTINGS_KEY, STORAGE_VIDEOS_KEY]);
    if (data[SETTINGS_KEY]) coldStartReceived.settings = true;
    if (Array.isArray(data[STORAGE_VIDEOS_KEY]) && data[STORAGE_VIDEOS_KEY].length > 0) {
      coldStartReceived.videos = true;
    }
  } catch (_) {}
  checkColdStartDataReady();
  if (!coldStartActive) return;

  if (coldStartTimer) clearTimeout(coldStartTimer);
  coldStartTimer = setTimeout(onSyncWaitTimedOut, COLD_START_TIMEOUT_MS);
  startColdStartPolling();
  hydrateFromSync().catch(() => {});
  update();
}

function onColdStartChoiceNo() {
  coldStartView = "refresh-schedule";
  update();
}

async function applyColdStartSettingsAndContinue(settings) {
  // Tear down cold-start state BEFORE the save await so the storage onChanged
  // listener (which fires synchronously from saveSettings) doesn't re-render
  // the cold-start UI and cause a momentary flash before endColdStart fires.
  coldStartActive = false;
  coldStartAwaitingChoice = false;
  coldStartView = "sync-prompt";
  coldStartDraftSettings = null;
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
  stopColdStartPolling();
  try {
    await saveSettings(settings);
  } catch (_) {}
  update();
  maybeShowModePicker();
}

function renderColdStartRefreshSchedule() {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const wrap = document.createElement("div");
  wrap.className = "better-feed-setup";

  const title = document.createElement("div");
  title.className = "better-feed-setup-title";
  title.textContent = "Select refresh schedule";

  const sub = document.createElement("div");
  sub.className = "better-feed-setup-sub";
  sub.textContent =
    "By default, the home page is set to refresh weekly with 15 new videos on Sunday at 5 AM, your local time.";

  const buttons = document.createElement("div");
  buttons.className = "better-feed-setup-buttons";

  const defaultBtn = document.createElement("button");
  defaultBtn.className = "better-feed-setup-button better-feed-setup-primary";
  defaultBtn.textContent = "Use default refresh schedule";
  defaultBtn.addEventListener("click", () => {
    applyColdStartSettingsAndContinue({ ...DEFAULT_SETTINGS });
  });

  const customBtn = document.createElement("button");
  customBtn.className = "better-feed-setup-button";
  customBtn.textContent = "Set custom refresh schedule";
  customBtn.addEventListener("click", () => {
    if (!coldStartDraftSettings) {
      coldStartDraftSettings = sanitizeSettings({ ...DEFAULT_SETTINGS });
    }
    coldStartView = "refresh-custom";
    update();
  });

  buttons.appendChild(defaultBtn);
  buttons.appendChild(customBtn);

  wrap.appendChild(title);
  wrap.appendChild(sub);
  wrap.appendChild(buttons);
  container.appendChild(wrap);

  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

function renderColdStartSyncFailed() {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const wrap = document.createElement("div");
  wrap.className = "better-feed-setup";

  const title = document.createElement("div");
  title.className = "better-feed-setup-title";
  title.textContent = "No sync data found";

  const sub = document.createElement("div");
  sub.className = "better-feed-setup-sub";
  sub.textContent =
    "Make sure your other browser's sync settings have the option for syncing extension data enabled.";

  const buttons = document.createElement("div");
  buttons.className = "better-feed-setup-buttons";

  const retryBtn = document.createElement("button");
  retryBtn.className = "better-feed-setup-button better-feed-setup-primary";
  retryBtn.textContent = "Try syncing again";
  retryBtn.addEventListener("click", retryColdStartSync);

  const freshBtn = document.createElement("button");
  freshBtn.className = "better-feed-setup-button";
  freshBtn.textContent = "Fresh install (first time user)";
  freshBtn.addEventListener("click", () => {
    coldStartView = "refresh-schedule";
    update();
  });

  buttons.appendChild(retryBtn);
  buttons.appendChild(freshBtn);

  wrap.appendChild(title);
  wrap.appendChild(sub);
  wrap.appendChild(buttons);
  container.appendChild(wrap);

  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

function renderColdStartRefreshCustom() {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  if (!coldStartDraftSettings) {
    coldStartDraftSettings = sanitizeSettings({ ...DEFAULT_SETTINGS });
  }
  const draft = coldStartDraftSettings;

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const form = document.createElement("div");
  form.className = "better-feed-setup better-feed-setup-form";

  const backBtn = document.createElement("button");
  backBtn.className = "better-feed-setup-back";
  backBtn.type = "button";
  backBtn.innerHTML = '<span aria-hidden="true">←</span><span>Back</span>';
  backBtn.addEventListener("click", () => {
    coldStartView = "refresh-schedule";
    update();
  });

  const title = document.createElement("div");
  title.className = "better-feed-setup-title";
  title.textContent = "Refresh schedule";

  // Mode radios
  const modeField = document.createElement("div");
  modeField.className = "better-feed-setup-field";
  const modeLabel = document.createElement("span");
  modeLabel.className = "better-feed-setup-field-label";
  modeLabel.textContent = "Refresh frequency";
  modeField.appendChild(modeLabel);

  const modeGroup = document.createElement("div");
  modeGroup.className = "better-feed-setup-radio-group";

  const modeOptions = [
    { value: "weekly", label: "Refresh weekly" },
    { value: "multi", label: "Refresh multiple times per week" },
    { value: "daily", label: "Daily refresh" }
  ];

  for (const opt of modeOptions) {
    const radioLabel = document.createElement("label");
    radioLabel.className = "better-feed-setup-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "cold-start-refresh-mode";
    radio.value = opt.value;
    if (draft.refreshMode === opt.value) radio.checked = true;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      draft.refreshMode = opt.value;
      update();
    });
    const span = document.createElement("span");
    span.textContent = opt.label;
    radioLabel.appendChild(radio);
    radioLabel.appendChild(span);
    modeGroup.appendChild(radioLabel);
  }

  modeField.appendChild(modeGroup);
  form.appendChild(backBtn);
  form.appendChild(title);
  form.appendChild(modeField);

  // Day picker (weekly mode)
  if (draft.refreshMode === "weekly") {
    const dayField = document.createElement("div");
    dayField.className = "better-feed-setup-field";
    const dayLabel = document.createElement("span");
    dayLabel.className = "better-feed-setup-field-label";
    dayLabel.textContent = "Refresh day";
    dayField.appendChild(dayLabel);

    const daySelect = document.createElement("select");
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (let i = 0; i < 7; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = days[i];
      if (i === draft.refreshDay) opt.selected = true;
      daySelect.appendChild(opt);
    }
    daySelect.addEventListener("change", () => {
      draft.refreshDay = Number(daySelect.value);
    });
    dayField.appendChild(daySelect);
    form.appendChild(dayField);
  }

  // Multi-day checkboxes
  if (draft.refreshMode === "multi") {
    const daysField = document.createElement("div");
    daysField.className = "better-feed-setup-field";
    const daysLabel = document.createElement("span");
    daysLabel.className = "better-feed-setup-field-label";
    daysLabel.textContent = "Refresh days (pick at least one)";
    daysField.appendChild(daysLabel);

    const grid = document.createElement("div");
    grid.className = "better-feed-setup-days-grid";
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const selectedSet = new Set(draft.refreshDays || []);
    for (let i = 0; i < 7; i++) {
      const dayCheck = document.createElement("label");
      dayCheck.className = "better-feed-setup-day-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(i);
      cb.checked = selectedSet.has(i);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedSet.add(i);
        else selectedSet.delete(i);
        draft.refreshDays = [...selectedSet].sort((a, b) => a - b);
      });
      const span = document.createElement("span");
      span.textContent = dayNames[i];
      dayCheck.appendChild(cb);
      dayCheck.appendChild(span);
      grid.appendChild(dayCheck);
    }
    daysField.appendChild(grid);
    form.appendChild(daysField);
  }

  // Time picker
  const timeField = document.createElement("div");
  timeField.className = "better-feed-setup-field";
  const timeLabel = document.createElement("span");
  timeLabel.className = "better-feed-setup-field-label";
  timeLabel.textContent = draft.refreshMode === "daily" ? "Refresh time" : "Refresh hour";
  timeField.appendChild(timeLabel);

  const timeRow = document.createElement("div");
  timeRow.className = "better-feed-setup-time-row";

  const hourSelect = document.createElement("select");
  const startHour = draft.refreshHour % 12 === 0 ? 12 : draft.refreshHour % 12;
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = String(h);
    if (h === startHour) opt.selected = true;
    hourSelect.appendChild(opt);
  }

  const ampmSelect = document.createElement("select");
  for (const v of ["am", "pm"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v.toUpperCase();
    if ((draft.refreshHour < 12 ? "am" : "pm") === v) opt.selected = true;
    ampmSelect.appendChild(opt);
  }

  const updateHour = () => {
    const h12 = Number(hourSelect.value);
    const ampm = ampmSelect.value;
    let h24 = h12 % 12;
    if (ampm === "pm") h24 += 12;
    draft.refreshHour = h24;
  };
  hourSelect.addEventListener("change", updateHour);
  ampmSelect.addEventListener("change", updateHour);

  timeRow.appendChild(hourSelect);
  timeRow.appendChild(ampmSelect);
  timeField.appendChild(timeRow);
  form.appendChild(timeField);

  // Video count
  const countField = document.createElement("div");
  countField.className = "better-feed-setup-field";
  const countLabel = document.createElement("span");
  countLabel.className = "better-feed-setup-field-label";
  countLabel.textContent =
    draft.refreshMode === "daily" ? "Videos per day" :
    draft.refreshMode === "multi" ? "Videos per refresh" :
    "Videos per week";
  countField.appendChild(countLabel);

  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.min = "1";
  countInput.max = String(MAX_WEEKLY_VIDEOS);
  countInput.value = String(draft.videoCount);
  countInput.addEventListener("change", () => {
    const n = Number(countInput.value);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_WEEKLY_VIDEOS) {
      draft.videoCount = n;
    } else {
      countInput.value = String(draft.videoCount);
    }
  });
  countField.appendChild(countInput);
  form.appendChild(countField);

  // Error / status line
  const errorLine = document.createElement("div");
  errorLine.className = "better-feed-setup-error";
  form.appendChild(errorLine);

  // Save button
  const buttons = document.createElement("div");
  buttons.className = "better-feed-setup-buttons";
  const saveBtn = document.createElement("button");
  saveBtn.className = "better-feed-setup-button better-feed-setup-primary";
  saveBtn.textContent = "Save and continue";
  saveBtn.addEventListener("click", async () => {
    if (draft.refreshMode === "multi" && (!draft.refreshDays || draft.refreshDays.length === 0)) {
      errorLine.textContent = "Pick at least one refresh day.";
      return;
    }
    errorLine.textContent = "";
    saveBtn.disabled = true;
    await applyColdStartSettingsAndContinue(draft);
  });
  buttons.appendChild(saveBtn);
  form.appendChild(buttons);

  container.appendChild(form);
  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

/* ---------- MODE PICKER ---------- */

const MODE_PICKER_ID = "better-feed-mode-picker";
const MODE_SWITCHER_ID = "better-feed-mode-switcher";

let currentMode = null;
let modeLoaded = false;
// Set in the init IIFE when this tab looks like a freshly-opened YouTube tab
// (not an internal Cmd-click, not a reload, not a back/forward navigation).
// Forces the mode picker even when a global mode is already stored, so each
// new tab restates intent. Cleared in onModePicked once the user picks.
let freshTabAwaitingMode = false;

function isFreshTabNavigation() {
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && (nav.type === "reload" || nav.type === "back_forward")) return false;
  } catch (_) {}
  const ref = document.referrer || "";
  if (ref.startsWith("https://www.youtube.com/")) return false;
  return true;
}

const MODE_LABELS = {
  [MODE_WATCH]: "Watch",
  [MODE_WORK]: "Work",
  [MODE_LISTEN]: "Listen"
};

const MODE_CARDS = [
  {
    id: MODE_WATCH,
    name: "Watch",
    desc: "Distraction-free YouTube — curated weekly grid, cleanup, and daily limits."
  },
  {
    id: MODE_WORK,
    name: "Work",
    desc: "Search-only. Hides every video grid so you can look up tutorials or research without distraction."
  },
  {
    id: MODE_LISTEN,
    name: "Listen",
    desc: "Coming soon - for listening to music."
  }
];

async function loadCurrentMode() {
  currentMode = await getCurrentMode();
  modeLoaded = true;
  syncModeToLocalStorage(currentMode);
}

// Listen mode is currently a placeholder that behaves identically to Work.
// Every code path that gates on "is this work" should use this helper so
// the two stay in lockstep.
function isWorkLikeMode(mode) {
  return mode === MODE_WORK || mode === MODE_LISTEN;
}

function isWatchModeActive() {
  return currentMode === MODE_WATCH;
}

/* ---------- WORK SESSION ---------- */
// A wall-clock commitment device. While a session is active, picking Watch
// mode is blocked. Storage is local (per-browser), and uses absolute
// timestamps so the timer keeps running across tab closes, browser restarts,
// and inactive tabs.

const NO_TIME_GRACE_MS = 15_000;
const NO_TIME_LOCK_MS = 20 * 60 * 1000;

let workSession = null; // { startedAt, endsAt, durationMinutes, noTime } | null
let workSessionTimer = null;

async function loadWorkSession() {
  const session = await getWorkSession();
  if (session && (session.noTime || session.endsAt > getNow())) {
    workSession = session;
  } else {
    workSession = null;
    if (session) clearWorkSession().catch(() => {});
  }
  scheduleWorkSessionTransitionCheck();
}

function lockStartsAt() {
  if (!workSession) return 0;
  if (workSession.noTime) {
    if (workSession.noGrace) return workSession.startedAt;
    return workSession.startedAt + NO_TIME_GRACE_MS;
  }
  return workSession.startedAt;
}

function lockEndsAt() {
  if (!workSession) return 0;
  if (workSession.noTime) return lockStartsAt() + NO_TIME_LOCK_MS;
  return workSession.endsAt;
}

function isWorkSessionActive() {
  if (!workSession) return false;
  if (workSession.noTime) return true;
  return workSession.endsAt > getNow();
}

function isWorkSessionLockActive() {
  if (!workSession) return false;
  const now = getNow();
  return now >= lockStartsAt() && now < lockEndsAt();
}

function remainingLockMs() {
  if (!isWorkSessionLockActive()) return 0;
  return Math.max(0, lockEndsAt() - getNow());
}

function formatSessionRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)} remaining`;
  return `${m}:${pad(s)} remaining`;
}

// Same as formatSessionRemaining but without the trailing "remaining" — used
// when the surrounding label already names what the time refers to.
function formatTimeRemainingShort(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function watchLockDescriptionText() {
  const t = formatTimeRemainingShort(remainingLockMs());
  if (workSession?.noTime) {
    return `Locked automatically for 20 minutes for work mode "No time session" selection. Code required to end work session early. Time remaining: ${t}`;
  }
  return `Code required to end work session early. Time remaining: ${t}`;
}

// Returns the next moment (ms timestamp) when the session UI state changes.
// For timed: endsAt (session ends → popup). For no-time: 10s mark (lock
// starts → popover content), 21min mark (lock ends → popover content).
// Returns 0 when there's nothing scheduled.
function nextWorkSessionTransitionAt() {
  if (!workSession) return 0;
  const now = getNow();
  if (workSession.noTime) {
    const lockStart = lockStartsAt();
    const lockEnd = lockEndsAt();
    if (now < lockStart) return lockStart;
    if (now < lockEnd) return lockEnd;
    return 0;
  }
  return workSession.endsAt > now ? workSession.endsAt : 0;
}

function scheduleWorkSessionTransitionCheck() {
  if (workSessionTimer) {
    clearTimeout(workSessionTimer);
    workSessionTimer = null;
  }
  const next = nextWorkSessionTransitionAt();
  if (!next) return;
  // Wake at the transition + 500ms, cap at one minute so a long session
  // re-checks periodically and survives inactive-tab throttling drift.
  const wait = Math.max(1000, Math.min(next - getNow() + 500, 60_000));
  workSessionTimer = setTimeout(() => {
    handleWorkSessionTransition();
  }, wait);
}

async function handleWorkSessionTransition() {
  if (!workSession) {
    scheduleWorkSessionTransitionCheck();
    return;
  }
  // Timed session just expired → end + popup.
  if (!workSession.noTime && workSession.endsAt <= getNow()) {
    await endWorkSession({ silent: false });
    return;
  }
  // No-time session: lock-state boundaries are just UI updates, the session
  // itself doesn't end. Refresh the clock popover if it's open and reschedule.
  refreshWorkClockPopover();
  scheduleWorkSessionTransitionCheck();
}

// Clears in-memory + persisted session state and updates the clock. If
// `silent` is false (the natural-timer-expiry case), also raises the
// "Start a new session?" popup.
async function endWorkSession({ silent } = { silent: true }) {
  workSession = null;
  if (workSessionTimer) {
    clearTimeout(workSessionTimer);
    workSessionTimer = null;
  }
  await clearWorkSession().catch(() => {});
  closeWorkClockPopover();
  ensureWorkClock();
  if (!silent) showSessionEndedPopup();
}

const MIN_SESSION_MINUTES = 20;

async function startWorkSessionAndEnter(opts = {}) {
  // opts: { minutes, noTime, noGrace }. Every new session gets at least a
  // 20-minute Watch lock: timed sessions are clamped up to 20 min, and no-time
  // sessions hit the 20-minute fixed lock as before.
  closeStandaloneSessionLengthPicker();
  closeWorkClockPopover();
  const adjusted = { ...opts };
  if (!adjusted.noTime && typeof adjusted.minutes === "number") {
    adjusted.minutes = Math.max(MIN_SESSION_MINUTES, adjusted.minutes);
  }
  const session = await setWorkSession(adjusted);
  if (session) {
    workSession = session;
    scheduleWorkSessionTransitionCheck();
  }
  await onModePicked(MODE_WORK);
}

const PICKER_FADE_MS = 220;
let pickerCloseTimeout = null;
let pickerTickInterval = null;

function clearPickerTick() {
  if (pickerTickInterval) {
    clearInterval(pickerTickInterval);
    pickerTickInterval = null;
  }
}

function startPickerTick() {
  if (pickerTickInterval) return;
  pickerTickInterval = setInterval(tickPickerLockDisplay, 1000);
}

function tickPickerLockDisplay() {
  const picker = document.getElementById(MODE_PICKER_ID);
  if (!picker) {
    clearPickerTick();
    return;
  }
  // Skip when the picker has transitioned to the session-length sub-step —
  // no Watch card present then.
  const watchCard = picker.querySelector('[data-mode="watch"]');
  if (!watchCard) return;
  const desc = watchCard.querySelector(".better-feed-mode-card-desc");
  if (!desc) return;

  if (isWorkSessionLockActive()) {
    desc.textContent = watchLockDescriptionText();
  } else if (watchCard.classList.contains("better-feed-mode-card-locked")) {
    // Lock just ended — restore the Watch card to its normal state.
    watchCard.classList.remove("better-feed-mode-card-locked");
    watchCard.disabled = false;
    const watchMeta = MODE_CARDS.find(c => c.id === MODE_WATCH);
    if (watchMeta) desc.textContent = watchMeta.desc;
  }
}

function removeModePicker() {
  const picker = document.getElementById(MODE_PICKER_ID);
  if (!picker) return;
  if (picker.classList.contains("better-feed-picker-closing")) return;
  clearPickerTick();
  picker.classList.add("better-feed-picker-closing");
  if (pickerCloseTimeout !== null) clearTimeout(pickerCloseTimeout);
  pickerCloseTimeout = setTimeout(() => {
    picker.remove();
    pickerCloseTimeout = null;
  }, PICKER_FADE_MS + 20);
}

function renderModePicker() {
  // If a previous picker is still fading out, cancel that and reuse it.
  if (pickerCloseTimeout !== null) {
    clearTimeout(pickerCloseTimeout);
    pickerCloseTimeout = null;
  }
  const existing = document.getElementById(MODE_PICKER_ID);
  if (existing) {
    existing.classList.remove("better-feed-picker-closing");
    existing.classList.add("better-feed-picker-visible");
    startPickerTick();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = MODE_PICKER_ID;

  const inner = document.createElement("div");
  inner.className = "better-feed-mode-picker-inner";

  const title = document.createElement("h2");
  title.className = "better-feed-mode-picker-title";
  title.textContent = "What are you here for?";

  const sub = document.createElement("p");
  sub.className = "better-feed-mode-picker-sub";
  sub.textContent = "Pick a mode for this browser session.";

  const cards = document.createElement("div");
  cards.className = "better-feed-mode-cards";

  for (const card of MODE_CARDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "better-feed-mode-card";
    btn.setAttribute("data-mode", card.id);

    const name = document.createElement("div");
    name.className = "better-feed-mode-card-name";
    name.textContent = card.name;

    const desc = document.createElement("div");
    desc.className = "better-feed-mode-card-desc";

    const watchLocked = card.id === MODE_WATCH && isWorkSessionLockActive();
    if (watchLocked) {
      btn.classList.add("better-feed-mode-card-locked");
      desc.textContent = watchLockDescriptionText();
    } else {
      desc.textContent = card.desc;
    }

    btn.appendChild(name);
    btn.appendChild(desc);
    btn.addEventListener("click", () => {
      if (!isWorkLikeMode(card.id) && isWorkSessionLockActive()) {
        // Any attempt to leave the work-like modes during an active lock
        // (Watch is the only non-worklike mode at present) opens the password
        // challenge. The card description tells the user this is the path
        // to end the session early.
        renderWorkUnlockModal({ targetMode: card.id });
        return;
      }
      if (isWorkLikeMode(card.id) && !isWorkSessionActive()) {
        // Snapshot the mode-cards content so the sub-step's Back button can
        // restore it in place — covers the "accidentally clicked Work" case.
        const savedChildren = Array.from(inner.childNodes);
        renderSessionLengthSubpicker(inner, {
          onBack: () => inner.replaceChildren(...savedChildren)
        });
        return;
      }
      onModePicked(card.id);
    });
    cards.appendChild(btn);
  }

  // Top-right X to dismiss the picker when the user opened it by mistake
  // (e.g., misclicked the mode-switcher chip). Hidden on cold start since
  // there's no mode to go back to.
  if (currentMode && !coldStartActive) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "better-feed-mode-picker-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      // Clear the fresh-tab gate so the picker doesn't immediately re-show.
      freshTabAwaitingMode = false;
      removeModePicker();
    });
    overlay.appendChild(closeBtn);
  }

  inner.appendChild(title);
  inner.appendChild(sub);
  inner.appendChild(cards);
  overlay.appendChild(inner);

  (document.body || document.documentElement).appendChild(overlay);
  // Trigger the fade-in by setting the visible class on the next frame —
  // the browser needs to paint the opacity:0 state first for the
  // transition to fire.
  requestAnimationFrame(() => {
    overlay.classList.add("better-feed-picker-visible");
  });
  pauseAllVideos();
  markModeReady();
  startPickerTick();
}

async function renderSessionLengthSubpicker(inner, { noGrace = false, onBack = null, hideNoTime = false } = {}) {
  const settings = await getSettings();
  const customDefault = settings.workCustomMinutes || 60;

  inner.replaceChildren();

  const title = document.createElement("h2");
  title.className = "better-feed-mode-picker-title";
  title.textContent = "Please select session length";
  inner.appendChild(title);

  const cards = document.createElement("div");
  cards.className = "better-feed-mode-cards better-feed-session-length-cards";

  function makeSessionCard(label, desc, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "better-feed-mode-card";
    const name = document.createElement("div");
    name.className = "better-feed-mode-card-name";
    name.textContent = label;
    btn.appendChild(name);
    if (desc) {
      const descEl = document.createElement("div");
      descEl.className = "better-feed-mode-card-desc";
      descEl.textContent = desc;
      btn.appendChild(descEl);
    }
    btn.addEventListener("click", onClick);
    return btn;
  }

  cards.appendChild(
    makeSessionCard("30 minutes", "", () =>
      startWorkSessionAndEnter({ minutes: 30, noGrace })
    )
  );
  cards.appendChild(
    makeSessionCard("1 hour", "", () =>
      startWorkSessionAndEnter({ minutes: 60, noGrace })
    )
  );

  // Custom is structurally a card but clicking it reveals an inline form
  // rather than starting a session directly. Wire the click handler below.
  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "better-feed-mode-card";
  const customName = document.createElement("div");
  customName.className = "better-feed-mode-card-name";
  customName.textContent = "Custom";
  customBtn.appendChild(customName);
  cards.appendChild(customBtn);

  if (!hideNoTime) {
    cards.appendChild(
      makeSessionCard(
        "No time session",
        "Open-ended session. Automatic 20 minute watch mode lock when started.",
        () => startWorkSessionAndEnter({ noTime: true, noGrace })
      )
    );
  }

  inner.appendChild(cards);

  // Custom form — hidden until "Custom" is clicked. Pre-populated with the
  // last custom value (stored in settings.workCustomMinutes).
  const customForm = document.createElement("div");
  customForm.className = "better-feed-custom-session-form";
  customForm.style.display = "none";

  const hLabel = document.createElement("label");
  hLabel.textContent = "Hours";
  const hInput = document.createElement("input");
  hInput.type = "number";
  hInput.min = "0";
  hInput.max = "23";
  hInput.step = "1";
  hInput.value = String(Math.floor(customDefault / 60));
  hLabel.appendChild(hInput);

  const mLabel = document.createElement("label");
  mLabel.textContent = "Minutes";
  const mInput = document.createElement("input");
  mInput.type = "number";
  mInput.min = "0";
  mInput.max = "59";
  mInput.step = "1";
  mInput.value = String(customDefault % 60);
  mLabel.appendChild(mInput);

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "better-feed-custom-session-start";
  startBtn.textContent = "Start";

  customForm.appendChild(hLabel);
  customForm.appendChild(mLabel);
  customForm.appendChild(startBtn);

  const minNote = document.createElement("div");
  minNote.className = "better-feed-custom-session-min-note";
  minNote.textContent = `Minimum ${MIN_SESSION_MINUTES} minutes`;
  customForm.appendChild(minNote);

  inner.appendChild(customForm);

  // Back button sits below the session-length picker (and below the custom
  // form when it's expanded). Goes wherever the caller chose to navigate.
  if (onBack) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "better-feed-session-length-back";
    backBtn.textContent = "← Back";
    backBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    });
    inner.appendChild(backBtn);
  }

  customBtn.addEventListener("click", () => {
    customForm.style.display = "flex";
    hInput.focus();
  });

  startBtn.addEventListener("click", async () => {
    const h = Math.max(0, parseInt(hInput.value, 10) || 0);
    const m = Math.max(0, parseInt(mInput.value, 10) || 0);
    const total = Math.max(MIN_SESSION_MINUTES, h * 60 + m);
    await saveSettings({ ...settings, workCustomMinutes: total });
    startWorkSessionAndEnter({ minutes: total, noGrace });
  });
}

function maybeShowModePicker() {
  if (coldStartActive) return;
  if (!modeLoaded) return;
  if (currentMode && !freshTabAwaitingMode) return;
  renderModePicker();
}

function removeModeSwitcher() {
  document.getElementById(MODE_SWITCHER_ID)?.remove();
}

function findSwitcherAnchor() {
  const avatarBtn =
    document.querySelector("ytd-masthead #avatar-btn") ||
    document.querySelector("ytd-masthead button#avatar-btn");
  if (avatarBtn) {
    const wrapper = avatarBtn.closest(
      "ytd-topbar-menu-button-renderer, ytd-button-renderer, yt-button-shape"
    );
    if (wrapper && wrapper.parentElement) return wrapper;
    return avatarBtn;
  }
  const signIn =
    document.querySelector('ytd-masthead ytd-button-renderer:has(a[href*="accounts.google.com"])') ||
    document.querySelector('ytd-masthead a[aria-label*="Sign in"]');
  if (signIn) {
    const wrapper = signIn.closest("ytd-button-renderer, yt-button-shape") || signIn;
    if (wrapper.parentElement) return wrapper;
  }
  return null;
}

function buildSwitcherChip() {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.id = MODE_SWITCHER_ID;
  chip.title = "Switch mode";

  const dot = document.createElement("span");
  dot.className = "better-feed-mode-switcher-dot";

  const label = document.createElement("span");
  label.className = "better-feed-mode-switcher-label";

  chip.appendChild(dot);
  chip.appendChild(label);
  chip.addEventListener("click", () => {
    renderModePicker();
  });
  return chip;
}

function tryInsertSwitcher() {
  if (!currentMode) return false;
  const anchor = findSwitcherAnchor();
  if (!anchor) return false;

  let chip = document.getElementById(MODE_SWITCHER_ID);
  if (!chip) chip = buildSwitcherChip();

  const labelEl = chip.querySelector(".better-feed-mode-switcher-label");
  if (labelEl) labelEl.textContent = MODE_LABELS[currentMode] || currentMode;

  const correctlyPlaced =
    chip.parentElement === anchor.parentElement && chip.nextElementSibling === anchor;
  if (!correctlyPlaced) {
    anchor.parentElement.insertBefore(chip, anchor);
  }
  return true;
}

/* ---------- WORK CLOCK ICON ---------- */
// Sits to the left of the mode switcher whenever a work session is active.
// Click toggles a popover with the time remaining. The popover ticks every
// second while open.

const WORK_CLOCK_ID = "better-feed-work-clock";
const WORK_CLOCK_POPOVER_ID = "better-feed-work-clock-popover";
const WORK_CLOCK_HIDE_DELAY_MS = 200;
let workClockPopoverInterval = null;
let workClockHideTimer = null;
// "status" = default time/buttons view. "selecting" = inline session-length
// picker (triggered by the "New session" button). In selecting mode the
// popover is sticky: hover-out doesn't auto-close it, and the tick interval
// won't refresh content (which would wipe form state).
let workClockPopoverMode = "status";

function buildWorkClock() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = WORK_CLOCK_ID;
  btn.title = "Work session — hover for remaining time";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5 3 .8-1.3-4.3-2.6V7z"/>' +
    "</svg>";
  btn.addEventListener("mouseenter", showWorkClockPopover);
  btn.addEventListener("mouseleave", scheduleHideWorkClockPopover);
  return btn;
}

function tryInsertWorkClock() {
  // Stay visible whenever the user is in Work or Listen mode, regardless of
  // whether a session is active. That way "New session" stays one hover away
  // after the user dismisses the Session-ended popup.
  if (!isWorkLikeMode(currentMode)) return false;
  const anchor = findSwitcherAnchor();
  if (!anchor) return false;

  let clock = document.getElementById(WORK_CLOCK_ID);
  if (!clock) clock = buildWorkClock();

  // Sit to the LEFT of the mode switcher (if it's there), otherwise just
  // before the avatar anchor.
  const switcher = document.getElementById(MODE_SWITCHER_ID);
  const positionBefore =
    switcher && switcher.parentElement === anchor.parentElement ? switcher : anchor;
  const correctlyPlaced =
    clock.parentElement === positionBefore.parentElement &&
    clock.nextElementSibling === positionBefore;
  if (!correctlyPlaced) {
    positionBefore.parentElement.insertBefore(clock, positionBefore);
  }
  return true;
}

function removeWorkClock() {
  document.getElementById(WORK_CLOCK_ID)?.remove();
  closeWorkClockPopover();
}

function ensureWorkClock() {
  if (!isWorkLikeMode(currentMode)) {
    removeWorkClock();
    return;
  }
  tryInsertWorkClock();
}

function closeWorkClockPopover() {
  document.getElementById(WORK_CLOCK_POPOVER_ID)?.remove();
  if (workClockPopoverInterval) {
    clearInterval(workClockPopoverInterval);
    workClockPopoverInterval = null;
  }
  if (workClockHideTimer) {
    clearTimeout(workClockHideTimer);
    workClockHideTimer = null;
  }
  document.removeEventListener("click", closeWorkClockPopoverOnOutsideClick);
  workClockPopoverMode = "status";
}

function closeWorkClockPopoverOnOutsideClick(e) {
  const popover = document.getElementById(WORK_CLOCK_POPOVER_ID);
  if (!popover) return;
  if (popover.contains(e.target)) return;
  const clock = document.getElementById(WORK_CLOCK_ID);
  if (clock && clock.contains(e.target)) return;
  closeWorkClockPopover();
}

function cancelHideWorkClockPopover() {
  if (workClockHideTimer) {
    clearTimeout(workClockHideTimer);
    workClockHideTimer = null;
  }
}

function scheduleHideWorkClockPopover() {
  // Sticky while the user is picking a new session — only the outside-click
  // listener can close the popover in that mode.
  if (workClockPopoverMode === "selecting") return;
  cancelHideWorkClockPopover();
  workClockHideTimer = setTimeout(() => {
    workClockHideTimer = null;
    closeWorkClockPopover();
  }, WORK_CLOCK_HIDE_DELAY_MS);
}

function describeSessionForPopover() {
  // No-time runs are intentionally NOT surfaced as sessions in the popover:
  // they look like "no session active" and only offer the New-session button.
  // The underlying 20-min Watch lock is still enforced by the picker / mode
  // change flow — the popover just doesn't broadcast it.
  if (!workSession || workSession.noTime) {
    return { text: "No active session", showEndButton: false, showNewButton: true };
  }
  return {
    text: formatSessionRemaining(Math.max(0, workSession.endsAt - getNow())),
    showEndButton: true,
    showNewButton: true
  };
}

function renderWorkClockPopoverContent(popover) {
  popover.replaceChildren();

  if (workClockPopoverMode === "selecting") {
    popover.classList.add("better-feed-work-clock-popover-selecting");
    // Render the session-length sub-step directly into the popover. noGrace
    // is true because this path is "user re-committing mid-Work" — same
    // behavior as the old standalone picker. The popover variant hides the
    // no-time option and omits the back button (outside-click dismisses).
    renderSessionLengthSubpicker(popover, {
      noGrace: true,
      hideNoTime: true
    });
    return;
  }

  popover.classList.remove("better-feed-work-clock-popover-selecting");

  const state = describeSessionForPopover();

  const timeText = document.createElement("div");
  timeText.className = "better-feed-work-clock-time";
  timeText.textContent = state.text;
  popover.appendChild(timeText);

  if (state.showEndButton) {
    const endBtn = document.createElement("button");
    endBtn.type = "button";
    endBtn.className = "better-feed-work-clock-end-btn";
    endBtn.textContent = "End session early";
    endBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      closeWorkClockPopover();
      renderWorkUnlockModal();
    });
    popover.appendChild(endBtn);
  }

  if (state.showNewButton) {
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "better-feed-work-clock-end-btn";
    newBtn.textContent = "New session";
    newBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      workClockPopoverMode = "selecting";
      cancelHideWorkClockPopover();
      renderWorkClockPopoverContent(popover);
      // Outside-click is now the dismiss path for the inline picker.
      // Defer the listener so the click that opened us doesn't fire it.
      setTimeout(() => {
        document.addEventListener("click", closeWorkClockPopoverOnOutsideClick);
      }, 0);
    });
    popover.appendChild(newBtn);
  }
}

function refreshWorkClockPopover() {
  const popover = document.getElementById(WORK_CLOCK_POPOVER_ID);
  if (!popover) return;
  renderWorkClockPopoverContent(popover);
}

function showWorkClockPopover() {
  cancelHideWorkClockPopover();
  if (document.getElementById(WORK_CLOCK_POPOVER_ID)) return;
  const clock = document.getElementById(WORK_CLOCK_ID);
  if (!clock) return;
  if (!isWorkLikeMode(currentMode)) return;

  const popover = document.createElement("div");
  popover.id = WORK_CLOCK_POPOVER_ID;
  renderWorkClockPopoverContent(popover);

  document.body.appendChild(popover);

  positionPopoverBelowButton(popover, clock);

  // Keep open while the mouse is on the popover, including the gap between
  // the icon and the popover (handled by the hide delay).
  popover.addEventListener("mouseenter", cancelHideWorkClockPopover);
  popover.addEventListener("mouseleave", scheduleHideWorkClockPopover);

  // Tick once a second while open — refresh the entire content so we pick up
  // session/lock transitions and the end-of-timed-session popup trigger.
  // In selecting mode the popover content is an interactive picker, so we
  // skip refreshing to avoid wiping form state on every tick.
  workClockPopoverInterval = setInterval(async () => {
    if (workClockPopoverMode === "selecting") return;
    if (workSession && !workSession.noTime && getNow() >= workSession.endsAt) {
      closeWorkClockPopover();
      await endWorkSession({ silent: false });
      return;
    }
    refreshWorkClockPopover();
  }, 1000);
}

/* ---------- DAILY LIMIT ICON ---------- */
// Hourglass icon to the left of the mode switcher in Watch mode. Click toggles
// a small popover showing today's videos-watched and time-watched against the
// configured daily limits. Click outside (or click the icon again) closes it.

const DAILY_LIMIT_BUTTON_ID = "better-feed-daily-limit";
const DAILY_LIMIT_POPOVER_ID = "better-feed-daily-limit-popover";

function buildDailyLimitButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = DAILY_LIMIT_BUTTON_ID;
  btn.title = "Daily limit — click for today's stats";
  // Material Icons "hourglass_empty" path.
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
    '<path d="M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z"/>' +
    "</svg>";
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    toggleDailyLimitPopover();
  });
  return btn;
}

function tryInsertDailyLimitButton() {
  if (currentMode !== MODE_WATCH) return false;
  const anchor = findSwitcherAnchor();
  if (!anchor) return false;

  let btn = document.getElementById(DAILY_LIMIT_BUTTON_ID);
  if (!btn) btn = buildDailyLimitButton();

  // Sit to the LEFT of the mode switcher (same slot the work-clock uses in
  // Work mode — they're mutually exclusive since they key off mode).
  const switcher = document.getElementById(MODE_SWITCHER_ID);
  const positionBefore =
    switcher && switcher.parentElement === anchor.parentElement ? switcher : anchor;
  const correctlyPlaced =
    btn.parentElement === positionBefore.parentElement &&
    btn.nextElementSibling === positionBefore;
  if (!correctlyPlaced) {
    positionBefore.parentElement.insertBefore(btn, positionBefore);
  }
  return true;
}

function removeDailyLimitButton() {
  document.getElementById(DAILY_LIMIT_BUTTON_ID)?.remove();
  closeDailyLimitPopover();
}

function ensureDailyLimitButton() {
  if (currentMode !== MODE_WATCH) {
    removeDailyLimitButton();
    return;
  }
  tryInsertDailyLimitButton();
}

function formatDailyLimitDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

async function renderDailyLimitPopoverContent(popover) {
  popover.replaceChildren();

  const settings = await getSettings();
  const state = await getDailyState(settings);

  const title = document.createElement("div");
  title.className = "better-feed-daily-limit-popover-title";
  title.textContent = "Today";
  popover.appendChild(title);

  const videosWatched = Array.isArray(state.videoIds) ? state.videoIds.length : 0;
  const secondsWatched = Number(state.secondsWatched) || 0;
  const enabled = !!settings.dailyLimitEnabled;
  const mode = settings.dailyLimitMode || "both";

  const videosRow = document.createElement("div");
  videosRow.className = "better-feed-daily-limit-popover-row";
  const videosLabel = document.createElement("span");
  videosLabel.className = "better-feed-daily-limit-popover-label";
  videosLabel.textContent = "Videos";
  const videosValue = document.createElement("span");
  videosValue.className = "better-feed-daily-limit-popover-value";
  videosValue.textContent =
    enabled && mode !== "time"
      ? `${videosWatched} / ${settings.maxVideosPerDay}`
      : `${videosWatched}`;
  videosRow.appendChild(videosLabel);
  videosRow.appendChild(videosValue);
  popover.appendChild(videosRow);

  const timeRow = document.createElement("div");
  timeRow.className = "better-feed-daily-limit-popover-row";
  const timeLabel = document.createElement("span");
  timeLabel.className = "better-feed-daily-limit-popover-label";
  timeLabel.textContent = "Time";
  const timeValue = document.createElement("span");
  timeValue.className = "better-feed-daily-limit-popover-value";
  timeValue.textContent =
    enabled && mode !== "videos"
      ? `${formatDailyLimitDuration(secondsWatched)} / ${formatDailyLimitDuration(settings.maxSecondsPerDay)}`
      : formatDailyLimitDuration(secondsWatched);
  timeRow.appendChild(timeLabel);
  timeRow.appendChild(timeValue);
  popover.appendChild(timeRow);

  if (!enabled) {
    const note = document.createElement("div");
    note.className = "better-feed-daily-limit-popover-note";
    note.textContent = "Daily limit is off.";
    popover.appendChild(note);
  }
}

function refreshDailyLimitPopover() {
  const popover = document.getElementById(DAILY_LIMIT_POPOVER_ID);
  if (!popover) return;
  renderDailyLimitPopoverContent(popover);
}

function showDailyLimitPopover() {
  if (document.getElementById(DAILY_LIMIT_POPOVER_ID)) return;
  const btn = document.getElementById(DAILY_LIMIT_BUTTON_ID);
  if (!btn) return;
  if (currentMode !== MODE_WATCH) return;

  const popover = document.createElement("div");
  popover.id = DAILY_LIMIT_POPOVER_ID;
  renderDailyLimitPopoverContent(popover);

  document.body.appendChild(popover);

  positionPopoverBelowButton(popover, btn);

  // Defer the outside-click listener so the click that opened us doesn't fire it.
  setTimeout(() => {
    document.addEventListener("click", closeDailyLimitPopoverOnOutsideClick);
  }, 0);
}

function closeDailyLimitPopover() {
  document.getElementById(DAILY_LIMIT_POPOVER_ID)?.remove();
  document.removeEventListener("click", closeDailyLimitPopoverOnOutsideClick);
}

function closeDailyLimitPopoverOnOutsideClick(e) {
  const popover = document.getElementById(DAILY_LIMIT_POPOVER_ID);
  if (!popover) return;
  if (popover.contains(e.target)) return;
  const btn = document.getElementById(DAILY_LIMIT_BUTTON_ID);
  if (btn && btn.contains(e.target)) return;
  closeDailyLimitPopover();
}

function toggleDailyLimitPopover() {
  if (document.getElementById(DAILY_LIMIT_POPOVER_ID)) {
    closeDailyLimitPopover();
  } else {
    showDailyLimitPopover();
  }
}

/* ---------- WORK SESSION UNLOCK CHALLENGE ---------- */
// Lets the user end a session early — but only by typing a fresh 16-20 digit
// numeric code shown on screen, no spaces, no paste, no select-copy on the
// display. Friction is the point: ending early should require a deliberate,
// annoying action so it doesn't happen impulsively.

const WORK_UNLOCK_ID = "better-feed-work-unlock";

// generateUnlockCode lives in shared.js so the work-session unlock and the
// watching-lock unlock can't drift apart.

function renderWorkUnlockModal({ targetMode } = {}) {
  document.getElementById(WORK_UNLOCK_ID)?.remove();
  // Allow the challenge whenever a session is active — even outside the lock
  // window, the user explicitly opted into friction by picking the session.
  if (!isWorkSessionActive()) return;

  const code = generateUnlockCode();

  const overlay = document.createElement("div");
  overlay.id = WORK_UNLOCK_ID;

  const card = document.createElement("div");
  card.className = "better-feed-work-unlock-card";

  const title = document.createElement("h2");
  title.className = "better-feed-work-unlock-title";
  title.textContent = "End work session early?";
  card.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "better-feed-work-unlock-sub";
  sub.textContent =
    "Type the code below exactly to confirm. This friction is intentional — pause and decide whether you really want to leave focus.";
  card.appendChild(sub);

  const codeDisplay = document.createElement("div");
  codeDisplay.className = "better-feed-work-unlock-code";
  codeDisplay.textContent = code;
  card.appendChild(codeDisplay);

  const input = document.createElement("input");
  input.className = "better-feed-work-unlock-input";
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.placeholder = "Type the code";
  card.appendChild(input);

  const buttons = document.createElement("div");
  buttons.className = "better-feed-work-unlock-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "better-feed-work-unlock-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => overlay.remove());

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "better-feed-work-unlock-confirm";
  confirmBtn.textContent = "End session";
  confirmBtn.disabled = true;
  confirmBtn.addEventListener("click", async () => {
    if (input.value !== code) return;
    overlay.remove();
    // Manual end — never show the "Start new session?" popup. If the user
    // is going to a different mode, also switch.
    await endWorkSession({ silent: true });
    if (targetMode && VALID_MODES.includes(targetMode)) {
      await onModePicked(targetMode);
    }
  });

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  card.appendChild(buttons);
  overlay.appendChild(card);

  // Filter to digits only and block paste / drop. Drag-drop a value would also
  // bypass the typing requirement, so prevent that too.
  input.addEventListener("input", () => {
    const stripped = input.value.replace(/[^0-9]/g, "");
    if (stripped !== input.value) input.value = stripped;
    confirmBtn.disabled = input.value !== code;
  });
  input.addEventListener("paste", e => e.preventDefault());
  input.addEventListener("drop", e => e.preventDefault());
  // Enter submits when the input matches.
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click();
    if (e.key === "Escape") overlay.remove();
  });

  (document.body || document.documentElement).appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}

/* ---------- STANDALONE SESSION LENGTH PICKER ---------- */
// Used by the clock popover's "New session" button to skip the main mode
// picker and go straight to the session-length sub-step.

const SESSION_LENGTH_PICKER_ID = "better-feed-session-length-picker";

function closeStandaloneSessionLengthPicker() {
  document.getElementById(SESSION_LENGTH_PICKER_ID)?.remove();
}

function showStandaloneSessionLengthPicker() {
  closeStandaloneSessionLengthPicker();

  const overlay = document.createElement("div");
  overlay.id = SESSION_LENGTH_PICKER_ID;

  const inner = document.createElement("div");
  inner.className = "better-feed-mode-picker-inner";

  // Sessions started from the clock popover / session-ended popup skip the
  // 10-second grace window — the user is re-committing mid-Work, no
  // fat-finger window required.
  renderSessionLengthSubpicker(inner, {
    noGrace: true,
    onBack: () => closeStandaloneSessionLengthPicker()
  });

  overlay.appendChild(inner);
  (document.body || document.documentElement).appendChild(overlay);

  // Click backdrop to dismiss.
  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.remove();
  });
}

/* ---------- SESSION ENDED POPUP ---------- */
// Fires when a timed session reaches its endsAt. Asks the user if they want
// to start a new one. Yes → standalone session-length picker. No → just
// dismiss; the clock icon stays available with a "New session" button.

const SESSION_ENDED_POPUP_ID = "better-feed-session-ended-popup";

function showSessionEndedPopup() {
  document.getElementById(SESSION_ENDED_POPUP_ID)?.remove();
  if (!isWorkLikeMode(currentMode)) return;

  const overlay = document.createElement("div");
  overlay.id = SESSION_ENDED_POPUP_ID;

  const card = document.createElement("div");
  card.className = "better-feed-session-ended-card";

  const title = document.createElement("h2");
  title.className = "better-feed-session-ended-title";
  title.textContent = "Session complete";
  card.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "better-feed-session-ended-sub";
  sub.textContent = "Start a new session?";
  card.appendChild(sub);

  const buttons = document.createElement("div");
  buttons.className = "better-feed-session-ended-buttons";

  const noBtn = document.createElement("button");
  noBtn.type = "button";
  noBtn.className = "better-feed-session-ended-no";
  noBtn.textContent = "No";
  noBtn.addEventListener("click", () => overlay.remove());

  const yesBtn = document.createElement("button");
  yesBtn.type = "button";
  yesBtn.className = "better-feed-session-ended-yes";
  yesBtn.textContent = "Yes";
  yesBtn.addEventListener("click", () => {
    overlay.remove();
    showStandaloneSessionLengthPicker();
  });

  buttons.appendChild(noBtn);
  buttons.appendChild(yesBtn);
  card.appendChild(buttons);
  overlay.appendChild(card);
  (document.body || document.documentElement).appendChild(overlay);
}

let mastheadObserver = null;
let switcherCheckScheduled = false;
function scheduleSwitcherCheck() {
  if (switcherCheckScheduled) return;
  switcherCheckScheduled = true;
  requestAnimationFrame(() => {
    switcherCheckScheduled = false;
    tryInsertSwitcher();
    tryInsertWorkClock();
    tryInsertDailyLimitButton();
  });
}

function startMastheadObserver() {
  if (mastheadObserver) return;
  mastheadObserver = new MutationObserver(() => {
    if (!currentMode) return;
    scheduleSwitcherCheck();
  });
  mastheadObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function stopMastheadObserver() {
  if (mastheadObserver) {
    mastheadObserver.disconnect();
    mastheadObserver = null;
  }
}

function ensureModeSwitcher() {
  if (!currentMode) {
    removeModeSwitcher();
    removeWorkClock();
    removeDailyLimitButton();
    stopMastheadObserver();
    return;
  }
  tryInsertSwitcher();
  ensureWorkClock();
  ensureDailyLimitButton();
  startMastheadObserver();
}

let inOnModePicked = 0;

// Trigger playback on the current /watch page's video element. Retries
// briefly because on a hard navigation the <video> tag may not be in the
// DOM yet when the mode is picked. The originating click on the picker
// satisfies the browser's user-gesture requirement for audio autoplay
// only while the gesture is "fresh", so we poll quickly and stop early
// once a video element appears.
function playActiveVideoSoon() {
  let attempts = 0;
  const maxAttempts = 20; // 20 * 100ms = up to 2s of waiting
  const tryPlay = () => {
    if (location.pathname !== "/watch") return;
    const videoEl = getActiveVideoEl();
    if (videoEl) {
      try {
        const p = videoEl.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {}
      return;
    }
    if (++attempts < maxAttempts) {
      setTimeout(tryPlay, 100);
    }
  };
  tryPlay();
}

async function onModePicked(mode) {
  if (!VALID_MODES.includes(mode)) return;
  // Leaving the work-like modes is locked while a session is in progress.
  if (!isWorkLikeMode(mode) && isWorkSessionLockActive()) return;

  // Leaving Work/Listen mode through normal picker navigation should end the
  // session (silently — the user has chosen to move on). The password
  // challenge path clears the session before calling onModePicked, so this
  // is a no-op for that flow.
  if (workSession && !isWorkLikeMode(mode)) {
    await endWorkSession({ silent: true });
  }

  // Snapshot URL up-front. The storage onChanged listener (which fires
  // when setCurrentMode writes below) calls syncUrlToMode and would
  // otherwise rewrite the hash to the target before our home-check runs.
  const startingPath = location.pathname;
  const startingHash = location.hash;
  const targetHash = markerHashForMode(mode);
  const startedAtTargetMarker =
    startingPath === "/feed/library" && startingHash === targetHash;
  // "Home-ish" means a page that's either the vanilla YouTube home or one of
  // our marker URLs. Picking a mode on those pages should navigate to the new
  // mode's marker URL. Any other page (watch, search, channel, playlist, etc.)
  // is somewhere the user intentionally went — we apply the mode in place and
  // leave them on the page they came for.
  const onHomeishPage =
    startingPath === "/" ||
    (startingPath === "/feed/library" && MARKER_HASHES.has(startingHash));
  const shouldNavigateToMarker = onHomeishPage && !startedAtTargetMarker;

  const prev = currentMode;
  inOnModePicked++;
  try {
    await setCurrentMode(mode);
    currentMode = mode;
    modeLoaded = true;
    freshTabAwaitingMode = false;

    if (shouldNavigateToMarker) {
      // Picker stays opaque during the navigation wait; the new page's
      // pre-ready background carries the dark color through and then
      // fades in the new mode UI. The storage listener's in-place
      // updates are suppressed (via inOnModePicked) so we don't briefly
      // expose the previous-mode page underneath.
      window.location.href = markerUrlForMode(mode);
      return;
    }

    // Either already at the target marker, or on a specific content page
    // (e.g. /watch from an external link). Fade the picker out and update
    // in-page state without moving the user off the page they came for.
    removeModePicker();
    // If they landed on /watch and just picked a mode, the click that
    // dismissed the picker counts as the user gesture browsers require for
    // audio-enabled autoplay. Kick the player off so the user doesn't have
    // to chase down the play button after committing to a mode.
    if (location.pathname === "/watch") {
      playActiveVideoSoon();
    }
    syncUrlToMode();
    ensureModeSwitcher();
    await applyFeatureSettings();
    if (prev === MODE_WATCH && mode !== MODE_WATCH) {
      await stopWatchTracking().catch(() => {});
      stopWatchedMarking();
    }
    update();
    applyDefaultSidebarForMode(mode);
    if (mode === MODE_WATCH) {
      maybeStartWatchTracking();
      maybeStartWatchedMarking();
      armGraceExpirationTimer();
    }
  } finally {
    inOnModePicked--;
  }
}

function formatResetTime(settings) {
  const hour = settings.refreshHour;
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:00 ${ampm}`;
}

function renderSeeYouTomorrow(settings) {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const wrap = document.createElement("div");
  wrap.className = "better-feed-see-you";

  const title = document.createElement("div");
  title.className = "better-feed-see-you-title";
  title.textContent = "See you tomorrow.";

  const sub = document.createElement("div");
  sub.className = "better-feed-see-you-sub";
  sub.textContent = `Daily limit reached — resets at ${formatResetTime(settings)}.`;

  wrap.appendChild(title);
  wrap.appendChild(sub);
  container.appendChild(wrap);
  browse.insertBefore(container, browse.firstChild);
  // Hide the left sidebar entirely (matches Work mode's collapsed-sidebar
  // behavior). Class is removed in removeCustomHome.
  document.documentElement.classList.add("better-feed-see-you-tomorrow");
  markModeReady();
}

function renderWorkPlaceholder() {
  const browse = ensureBrowseOrReturn();
  if (!browse) return;

  removeCustomHome();

  const container = document.createElement("div");
  container.id = CUSTOM_HOME_ID;

  const wrap = document.createElement("div");
  wrap.className = "better-feed-see-you";

  const title = document.createElement("div");
  title.className = "better-feed-see-you-title";
  title.textContent = "Work mode";

  const sub = document.createElement("div");
  sub.className = "better-feed-see-you-sub";
  sub.textContent = "Use the search bar above to find tutorials or research material.";

  wrap.appendChild(title);
  wrap.appendChild(sub);
  container.appendChild(wrap);
  browse.insertBefore(container, browse.firstChild);
  markModeReady();
}

function update() {
  applyMarkerModeClass();
  if (isHomePage()) {
    onHomePage();
  } else {
    onNonHomePage();
  }
}

/* ---------- INIT ---------- */

applyFeatureSettings();
detectAndApplyTheme();
ensureThemeObserver();
// NOTE: applyMarkerModeClass() is intentionally NOT called here. At module
// load `currentMode` is still null, so it would briefly toggle off the
// `better-feed-work-mode` class that early.js set from localStorage, causing
// the mini-guide to flash. The IIFE below calls it after loadCurrentMode().

(async () => {
  // Rebrand migration: copy any leftover ytWeekly* keys to betterFeed* on
  // the first load after the rename. Must run BEFORE the loadX() calls below
  // so they read from the migrated keys, not the empty new ones.
  await migrateLegacyStorageKeys();
  // Init reads can run in parallel — none depend on each other.
  await Promise.all([
    loadFakeNowOffset(),
    loadCurrentMode(),
    loadWorkSession()
  ]);
  syncUrlToMode();
  applyMarkerModeClass();
  // Queue the sidebar default. markModeReady will apply it before
  // lifting pre-ready, so the drawer animation plays invisibly and
  // the user sees the final sidebar state from the first paint.
  pendingSidebarMode = currentMode;
  await applyFeatureSettings();
  ensureModeSwitcher();

  const coldStart = await detectColdStart();
  if (coldStart) {
    coldStartActive = true;
    coldStartAwaitingChoice = true;
    update();
  } else {
    try { await hydrateFromSync(); } catch (_) {}
  }

  // Force the picker on freshly-opened YouTube tabs (typed URL, bookmark,
  // external link), but NOT on internal Cmd-click / SPA / reload / back-forward.
  // Skipped during cold start since it already owns the picker's timing.
  if (!coldStart && currentMode && isFreshTabNavigation()) {
    freshTabAwaitingMode = true;
  }
  if (!coldStartActive) {
    setTimeout(update, 500);
  }
  maybeShowModePicker();
  maybeStartWatchTracking();
  maybeStartWatchedMarking();
  armGraceExpirationTimer();
  // If hydrate just landed ID-only stub videos in local storage, fill in
  // titles/channels via oEmbed. Fire-and-forget; storage onChanged re-renders.
  rebuildVideoMetadataIfNeeded().catch(() => {});
})();

async function maybeRedirectSpaHome() {
  // SPA-navigation safety net: the dNR redirect rule is main_frame-scoped and
  // does NOT fire on client-side yt-navigate route changes to "/". When the
  // user lands on the vanilla home via SPA nav, redirect to the marker URL so
  // the custom home takes over.
  if (location.pathname !== "/") return;
  if (MARKER_HASHES.has(location.hash)) return;
  if (!currentMode) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  if (currentMode === MODE_WATCH) {
    if (!settings.weeklyHomeEnabled) return;
    if (!settings.redirectHomeEnabled) return;
  }

  window.location.replace(markerUrlForMode(currentMode));
}

document.addEventListener("yt-navigate-start", () => {
  maybeRedirectSpaHome();
  stopWatchTracking().catch(() => {});
  stopWatchedMarking();
});

// Tab close / hard-navigate fallback. Best-effort: the page is unloading, so
// chrome.storage.sync.set may not finish, but Chrome can usually queue it.
window.addEventListener("pagehide", () => {
  if (watchedMarkLastWrittenFraction > 0) {
    flushProgressToSync().catch(() => {});
  }
});

document.addEventListener("yt-navigate-finish", () => {
  maybeRedirectSpaHome();
  setTimeout(update, 250);
  enforceAutoplayDisabledIfEnabled();
  maybeEnforceGraceOnNavigation();
  maybeStartWatchTracking();
  maybeStartWatchedMarking();
  ensureModeSwitcher();
});

async function enforceAutoplayDisabledIfEnabled() {
  const settings = await getSettings();
  if (settings.enabled && settings.disableAutoplay) {
    persistAutoplayDisabledFlag();
    enforceAutoplayDisabled();
  }
}

/* ---------- DAILY LIMIT TRACKING ---------- */

const WATCH_FLUSH_INTERVAL_MS = 5000;
const VIDEO_COUNT_THRESHOLD_SEC = 5;

let watchTrackInterval = null;
let watchTrackVideoId = null;
let watchTrackLastCurrentTime = null;
let watchTrackPendingSeconds = 0;
let watchTrackPlaybackSeconds = 0;
let watchTrackLastFlushTime = 0;
let watchTrackVideoCounted = false;
let watchTrackStartGen = 0;

function getWatchPageVideoId() {
  if (location.pathname !== "/watch") return null;
  const params = new URLSearchParams(location.search);
  return params.get("v");
}

function getActiveVideoEl() {
  return (
    document.querySelector("video.html5-main-video") ||
    document.querySelector("#movie_player video") ||
    document.querySelector("video")
  );
}

// Serialize every daily-state read-modify-write. setInterval fires
// tickWatchTracking every 1s regardless of whether the previous (async) tick
// finished, so the seconds-flush and the video-count write can interleave
// across ticks and clobber each other's snapshot (lost watch-seconds or a
// lost counted videoId). Routing both through one chain makes them atomic
// w.r.t. each other — same pattern as modifyHidden/modifyWatched.
let _dailyStateChain = Promise.resolve();
function queueDailyStateUpdate(fn) {
  const run = _dailyStateChain.then(() => fn()).catch(() => undefined);
  _dailyStateChain = run;
  return run;
}

async function flushWatchSeconds(settings) {
  if (watchTrackPendingSeconds <= 0) return null;
  // Capture + zero pending SYNCHRONOUSLY (before any await) so a concurrent
  // tick can't double-count it; the storage read-modify-write is serialized.
  const pending = watchTrackPendingSeconds;
  watchTrackPendingSeconds = 0;
  watchTrackLastFlushTime = getNow();
  return queueDailyStateUpdate(async () => {
    const state = await getDailyState(settings);
    state.secondsWatched = (state.secondsWatched || 0) + pending;
    await saveDailyState(state);
    return state;
  });
}

function resetWatchTrackingState() {
  watchTrackVideoId = null;
  watchTrackLastCurrentTime = null;
  watchTrackPendingSeconds = 0;
  watchTrackPlaybackSeconds = 0;
  watchTrackLastFlushTime = 0;
  watchTrackVideoCounted = false;
}

async function stopWatchTracking() {
  if (watchTrackInterval) {
    clearInterval(watchTrackInterval);
    watchTrackInterval = null;
  }
  if (watchTrackPendingSeconds > 0) {
    try {
      const settings = await getSettings();
      await flushWatchSeconds(settings);
    } catch (_) {}
  }
  resetWatchTrackingState();
}

async function maybeStartWatchTracking() {
  const myGen = ++watchTrackStartGen;
  await stopWatchTracking();
  if (myGen !== watchTrackStartGen) return;

  if (!isWatchModeActive()) return;

  const videoId = getWatchPageVideoId();
  if (!videoId) return;

  const settings = await getSettings();
  if (myGen !== watchTrackStartGen) return;
  if (!settings.enabled || !settings.dailyLimitEnabled) return;

  const state = await getDailyState(settings);
  if (myGen !== watchTrackStartGen) return;
  const grace = await getDailyGrace(settings);
  if (myGen !== watchTrackStartGen) return;
  const graceActive = isGraceActiveForLocation(grace, location);

  if (isDailyLimitHit(state, settings) && !graceActive) {
    redirectToBlockedMarker();
    return;
  }

  const isNewVideo = !state.videoIds.includes(videoId);
  if (isNewVideo && isDailyVideoQuotaReached(state, settings) && !graceActive) {
    redirectToBlockedMarker();
    return;
  }

  if (myGen !== watchTrackStartGen) return;
  watchTrackVideoId = videoId;
  watchTrackVideoCounted = !isNewVideo;
  watchTrackInterval = setInterval(() => tickWatchTracking(), 1000);
}

async function tickWatchTracking() {
  const expectedVideoId = watchTrackVideoId;
  if (!expectedVideoId) return;
  if (getWatchPageVideoId() !== expectedVideoId) return;

  const videoEl = getActiveVideoEl();
  if (!videoEl || videoEl.paused || videoEl.ended || videoEl.readyState < 3) {
    watchTrackLastCurrentTime = null;
    return;
  }

  const currentTime = videoEl.currentTime;
  const prev = watchTrackLastCurrentTime;
  watchTrackLastCurrentTime = currentTime;

  if (prev === null) return;
  const delta = currentTime - prev;
  if (delta <= 0 || delta > 2) return;

  const settings = await getSettings();
  if (watchTrackVideoId !== expectedVideoId) return;
  if (!settings.enabled || !settings.dailyLimitEnabled) {
    await stopWatchTracking();
    return;
  }

  const grace = await getDailyGrace(settings);
  if (isGraceActiveForLocation(grace, location)) {
    if (grace.type === "minutes" && getNow() >= grace.expiresAt) {
      await stopWatchTracking();
      await saveDailyGrace(null);
      redirectToBlockedMarker();
    }
    return;
  }

  watchTrackPendingSeconds += delta;
  watchTrackPlaybackSeconds += delta;

  let graceJustGranted = false;
  if (!watchTrackVideoCounted && watchTrackPlaybackSeconds >= VIDEO_COUNT_THRESHOLD_SEC) {
    watchTrackVideoCounted = true;
    graceJustGranted = await queueDailyStateUpdate(async () => {
      const state = await getDailyState(settings);
      if (state.videoIds.includes(expectedVideoId)) return false;
      state.videoIds = [...state.videoIds, expectedVideoId];
      await saveDailyState(state);
      if (state.videoIds.length >= settings.maxVideosPerDay) {
        const existingGrace = await getDailyGrace(settings);
        if (!existingGrace) {
          await saveDailyGrace({
            type: "finish",
            videoId: expectedVideoId,
            dayKey: getDailyDayKey(settings)
          });
          return true;
        }
      }
      return false;
    });
  }

  const state = await getDailyState(settings);
  const projectedSeconds = (state.secondsWatched || 0) + watchTrackPendingSeconds;
  const limitHit = isDailyLimitHit(
    { ...state, secondsWatched: projectedSeconds },
    settings
  );

  const shouldFlush =
    limitHit || getNow() - watchTrackLastFlushTime >= WATCH_FLUSH_INTERVAL_MS;

  if (shouldFlush) {
    await flushWatchSeconds(settings);
  }

  if (limitHit && !graceJustGranted) {
    if (watchTrackInterval) {
      clearInterval(watchTrackInterval);
      watchTrackInterval = null;
    }
    if (!document.getElementById("better-feed-daily-popup")) {
      try { videoEl.pause(); } catch (_) {}
      showDailyLimitPopup();
    }
  }
}

function redirectToBlockedMarker() {
  const videoEl = document.querySelector("video");
  if (videoEl) {
    try { videoEl.pause(); } catch (_) {}
  }
  // Daily-limit redirect only fires in Watch mode.
  window.location.href = markerUrlForMode(MODE_WATCH);
}

/* ---------- AUTO-MARK WATCHED ---------- */
// Independent of the daily-limit ticker because we want this to work even
// when daily limits are off. Marks the current /watch video as watched once
// the player has 60s or less remaining. For videos shorter than 60s, falls
// back to the player's `ended` state since the remaining-time rule would
// otherwise fire immediately at t=0.

const WATCHED_MARK_REMAINING_THRESHOLD_SEC = 20;
const PROGRESS_WRITE_DELTA = 0.01;
let watchedMarkInterval = null;
let watchedMarkVideoId = null;
let watchedMarkLastWrittenFraction = -1;
let watchedMarkStartGen = 0;

async function maybeStartWatchedMarking() {
  // Generation guard (same pattern as maybeStartWatchTracking): two rapid
  // yt-navigate-finish calls each await storage below; without this, both
  // could reach setInterval and orphan the first interval.
  const myGen = ++watchedMarkStartGen;
  stopWatchedMarking();
  if (!isWatchModeActive()) return;
  if (location.pathname !== "/watch") return;
  const videoId = getWatchPageVideoId();
  if (!videoId) return;
  // Only auto-mark videos that are on the current week's homepage. Search
  // results, sidebar suggestions, etc. don't get tracked.
  const stored = await getStoredWeeklyVideos();
  if (myGen !== watchedMarkStartGen) return;
  const inGrid =
    Array.isArray(stored.videos) &&
    stored.videos.some(v => v && v.videoId === videoId);
  if (!inGrid) return;
  const watched = await getWatchedVideos();
  if (myGen !== watchedMarkStartGen) return;
  if (watched.has(videoId)) return;
  watchedMarkVideoId = videoId;
  watchedMarkInterval = setInterval(tickWatchedMarking, 2000);
}

function stopWatchedMarking() {
  if (watchedMarkInterval) {
    clearInterval(watchedMarkInterval);
    watchedMarkInterval = null;
  }
  // Sync only when we actually wrote progress locally during this session,
  // i.e. user watched at least one tick's worth of a current-week video.
  // The per-tick writes stayed local; this is the one sync write per exit.
  const didWriteProgress = watchedMarkLastWrittenFraction > 0;
  watchedMarkVideoId = null;
  watchedMarkLastWrittenFraction = -1;
  if (didWriteProgress) {
    flushProgressToSync().catch(() => {});
  }
}

async function tickWatchedMarking() {
  const expectedVideoId = watchedMarkVideoId;
  if (!expectedVideoId) return;
  if (getWatchPageVideoId() !== expectedVideoId) {
    stopWatchedMarking();
    return;
  }
  const videoEl = getActiveVideoEl();
  if (!videoEl) return;
  const duration = videoEl.duration;
  const currentTime = videoEl.currentTime;
  if (!isFinite(duration) || duration <= 0) return;
  const remaining = duration - currentTime;
  const fraction = Math.max(0, Math.min(1, currentTime / duration));

  // Skip the position:0 / negligible-progress write — it pollutes sync with
  // no observable value and the progress bar renderer ignores 0 anyway.
  if (currentTime > 0 && Math.abs(fraction - watchedMarkLastWrittenFraction) >= PROGRESS_WRITE_DELTA) {
    watchedMarkLastWrittenFraction = fraction;
    setVideoProgress(expectedVideoId, currentTime, duration).catch(() => {});
  }

  // Three ways to count as "watched":
  //  - The player itself signals it ended (reliable when it fires, but YouTube
  //    can swap the video before the event lands).
  //  - 60s or less remaining (the main rule for medium/long videos).
  //  - ≥ 90% of the duration played (handles short videos where the 60s rule
  //    can never fire, e.g. a 57-second clip).
  const reachedThreshold =
    videoEl.ended ||
    (duration > WATCHED_MARK_REMAINING_THRESHOLD_SEC &&
      remaining <= WATCHED_MARK_REMAINING_THRESHOLD_SEC) ||
    currentTime / duration >= 0.9;
  if (!reachedThreshold) return;
  stopWatchedMarking();
  await modifyWatched(set => set.add(expectedVideoId));
}

/* ---------- WORK MODE: CHANNEL-CLICK CONFIRMATION ---------- */

const CHANNEL_CONFIRM_ID = "better-feed-channel-confirm";

function isChannelLinkHref(href) {
  if (!href) return false;
  return (
    href.startsWith("/@") ||
    href.startsWith("https://www.youtube.com/@") ||
    href.includes("/channel/UC")
  );
}

function showChannelConfirm(targetUrl) {
  if (document.getElementById(CHANNEL_CONFIRM_ID)) return;

  const overlay = document.createElement("div");
  overlay.id = CHANNEL_CONFIRM_ID;

  const card = document.createElement("div");
  card.className = "better-feed-channel-confirm-card";

  const title = document.createElement("h2");
  title.textContent = "Are you sure you want to go to this channel?";

  const sub = document.createElement("p");
  sub.textContent = "Every video you see will be a distraction to your work.";

  const buttons = document.createElement("div");
  buttons.className = "better-feed-channel-confirm-buttons";

  const noBtn = document.createElement("button");
  noBtn.className = "secondary";
  noBtn.textContent = "No, stay here";
  noBtn.addEventListener("click", () => overlay.remove());

  const yesBtn = document.createElement("button");
  yesBtn.className = "primary";
  yesBtn.textContent = "Yes, go to channel";
  yesBtn.addEventListener("click", () => {
    overlay.remove();
    window.location.href = targetUrl;
  });

  buttons.appendChild(noBtn);
  buttons.appendChild(yesBtn);
  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(buttons);
  overlay.appendChild(card);

  (document.body || document.documentElement).appendChild(overlay);
}

function onWorkModeLinkClick(event) {
  if (!isWorkLikeMode(currentMode)) return;

  const link = event.target.closest && event.target.closest("a[href]");
  if (!link) return;

  if (!isChannelLinkHref(link.getAttribute("href"))) return;

  // Skip our own overlays and the masthead (avatar = channel link, but
  // it's an account-access click, not a "go look at a channel" click).
  if (
    link.closest(
      "#better-feed-mode-picker, #better-feed-channel-confirm, #better-feed-mode-switcher, #better-feed-daily-popup, ytd-masthead"
    )
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showChannelConfirm(link.href);
}

document.addEventListener("click", onWorkModeLinkClick, { capture: true });
document.addEventListener("auxclick", onWorkModeLinkClick, { capture: true });

function showDailyLimitPopup() {
  if (document.getElementById("better-feed-daily-popup")) return;

  const overlay = document.createElement("div");
  overlay.id = "better-feed-daily-popup";

  const card = document.createElement("div");
  card.className = "better-feed-daily-popup-card";

  const title = document.createElement("h2");
  title.textContent = "Daily limit reached";

  const sub = document.createElement("p");
  sub.textContent = "You've hit your daily watching limit. Pick one or call it a day.";

  const buttons = document.createElement("div");
  buttons.className = "better-feed-daily-popup-buttons";

  const exitBtn = document.createElement("button");
  exitBtn.className = "secondary";
  exitBtn.textContent = "Exit video";
  exitBtn.addEventListener("click", () => {
    dismissDailyLimitPopup();
    redirectToBlockedMarker();
  });

  const oneMinBtn = document.createElement("button");
  oneMinBtn.className = "secondary";
  oneMinBtn.textContent = "1 more minute";
  oneMinBtn.addEventListener("click", () => onGraceChosen("minutes", 60));

  const fiveMinBtn = document.createElement("button");
  fiveMinBtn.className = "secondary";
  fiveMinBtn.textContent = "5 more minutes";
  fiveMinBtn.addEventListener("click", () => onGraceChosen("minutes", 300));

  const finishBtn = document.createElement("button");
  finishBtn.textContent = "Finish video";
  finishBtn.addEventListener("click", () => onGraceChosen("finish"));

  buttons.appendChild(exitBtn);
  buttons.appendChild(oneMinBtn);
  buttons.appendChild(fiveMinBtn);
  buttons.appendChild(finishBtn);

  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function dismissDailyLimitPopup() {
  const overlay = document.getElementById("better-feed-daily-popup");
  if (overlay) overlay.remove();
}

async function onGraceChosen(type, seconds) {
  const settings = await getSettings();
  const dayKey = getDailyDayKey(settings);
  const currentVideoId = getWatchPageVideoId();
  let grace;
  if (type === "minutes") {
    grace = { type: "minutes", expiresAt: getNow() + seconds * 1000, dayKey };
  } else {
    grace = { type: "finish", videoId: currentVideoId, dayKey };
  }
  await saveDailyGrace(grace);
  dismissDailyLimitPopup();

  watchTrackVideoId = currentVideoId;
  watchTrackLastCurrentTime = null;
  watchTrackPendingSeconds = 0;
  watchTrackLastFlushTime = getNow();
  // Reset the playback accumulator + counted flag too. The daily-limit-hit
  // path cleared the interval without resetWatchTrackingState(), so these
  // carry stale values; leaving them would let the video-count branch
  // re-fire spuriously and double-count this video on the next tick.
  watchTrackPlaybackSeconds = 0;
  watchTrackVideoCounted = false;
  if (!watchTrackInterval) {
    watchTrackInterval = setInterval(() => tickWatchTracking(), 1000);
  }

  const videoEl = getActiveVideoEl();
  if (videoEl) {
    try { videoEl.play(); } catch (_) {}
  }
}

let graceExpirationTimer = null;

async function armGraceExpirationTimer() {
  if (graceExpirationTimer) {
    clearTimeout(graceExpirationTimer);
    graceExpirationTimer = null;
  }
  if (!isWatchModeActive()) return;
  const settings = await getSettings();
  if (!settings.enabled || !settings.dailyLimitEnabled) return;

  const grace = await getDailyGrace(settings);
  if (!grace || grace.type !== "minutes") return;

  const remaining = grace.expiresAt - getNow();
  if (remaining <= 0) {
    await saveDailyGrace(null);
    const state = await getDailyState(settings);
    if (isDailyLimitHit(state, settings)) redirectToBlockedMarker();
    return;
  }

  graceExpirationTimer = setTimeout(async () => {
    graceExpirationTimer = null;
    const current = await getDailyGrace(settings);
    if (!current || current.type !== "minutes") return;
    if (getNow() < current.expiresAt) return;
    await saveDailyGrace(null);
    await stopWatchTracking();
    redirectToBlockedMarker();
  }, remaining + 200);
}

async function maybeEnforceGraceOnNavigation() {
  if (!isWatchModeActive()) return;
  const settings = await getSettings();
  if (!settings.enabled || !settings.dailyLimitEnabled) return;

  const grace = await getDailyGrace(settings);
  if (!grace) return;

  if (grace.type === "minutes") {
    if (getNow() >= grace.expiresAt) {
      await saveDailyGrace(null);
      const state = await getDailyState(settings);
      if (isDailyLimitHit(state, settings)) redirectToBlockedMarker();
    }
    return;
  }

  if (grace.type === "finish") {
    if (!isGraceActiveForLocation(grace, location)) {
      await saveDailyGrace(null);
      const state = await getDailyState(settings);
      if (isDailyLimitHit(state, settings)) redirectToBlockedMarker();
    }
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  applyFakeNowOffsetChange(changes);
  if (STORAGE_FAKE_NOW_OFFSET_KEY in changes) {
    update();
  }

  if (coldStartActive) {
    if (STORAGE_VIDEOS_KEY in changes && Array.isArray(changes[STORAGE_VIDEOS_KEY].newValue) && changes[STORAGE_VIDEOS_KEY].newValue.length > 0) {
      coldStartReceived.videos = true;
    }
    if (SETTINGS_KEY in changes && changes[SETTINGS_KEY].newValue) {
      coldStartReceived.settings = true;
    }
    checkColdStartDataReady();
  }

  const settingsCleared =
    SETTINGS_KEY in changes && changes[SETTINGS_KEY].newValue === undefined;
  const videosCleared =
    STORAGE_VIDEOS_KEY in changes &&
    (changes[STORAGE_VIDEOS_KEY].newValue === undefined ||
      (Array.isArray(changes[STORAGE_VIDEOS_KEY].newValue) &&
        changes[STORAGE_VIDEOS_KEY].newValue.length === 0));
  if (settingsCleared || videosCleared) {
    // "Clear local data" wiped the authoritative chrome.storage mode, but the
    // localStorage mode mirror (origin-scoped to this YouTube tab) survives a
    // clear initiated from the options page and would otherwise feed early.js
    // a stale mode on the next load. Zero it here.
    try { localStorage.removeItem(MODE_LOCALSTORAGE_KEY); } catch (_) {}
    await maybeReEnterColdStart();
  }

  if (SETTINGS_KEY in changes) {
    applyFeatureSettings();
    update();
    refreshDailyLimitPopover();
  }

  if (STORAGE_VIDEOS_KEY in changes) {
    update();
    // Sync hydration / cross-device updates may have brought in stub entries
    // (IDs only) — fill in title/channel from oEmbed in the background.
    rebuildVideoMetadataIfNeeded().catch(() => {});
  }

  // Background-owned refresh status flipped (idle/refreshing/error) — re-render
  // so renderFromStorage swaps between the grid, loader, and retry message.
  if (STORAGE_REFRESH_STATUS_KEY in changes) {
    update();
  }

  if (
    STORAGE_HIDDEN_VIDEOS_KEY in changes ||
    STORAGE_HIDDEN_CHANNELS_KEY in changes
  ) {
    refreshVisibleVideosAfterHide();
  }

  if (STORAGE_WATCHED_VIDEOS_KEY in changes) {
    update();
  }

  if (STORAGE_DAILY_STATE_KEY in changes) {
    update();
    refreshDailyLimitPopover();
  }

  if (STORAGE_DAILY_GRACE_KEY in changes) {
    update();
    armGraceExpirationTimer();
  }

  if (STORAGE_MODE_KEY in changes) {
    const newValue = changes[STORAGE_MODE_KEY].newValue;

    // This tab opened fresh and is still waiting for the user's pick. Don't
    // auto-adopt a sibling tab's mode change — the picker should stay up.
    if (freshTabAwaitingMode) return;

    currentMode = VALID_MODES.includes(newValue) ? newValue : null;
    modeLoaded = true;
    // Keep the page-origin localStorage mirror (read synchronously by early.js
    // at document_start) in lockstep with the authoritative chrome.storage
    // mode — including when the mode is CLEARED (newValue undefined). The
    // background context can never do this (localStorage is undefined in a
    // service worker / event page), and "Clear local data" runs from the
    // options-page origin which cannot touch this tab's localStorage. Without
    // this line a stale mirror survives a clear and drives early.js into the
    // wrong mode styling on the next load.
    syncModeToLocalStorage(currentMode);

    // Same-tab mode picks are owned by onModePicked — let it handle the
    // URL update and navigation. If we also ran the in-place updates
    // below, the picker would fade out and expose the previous-mode UI
    // (or whatever native YT content is underneath on non-home pages)
    // before the navigation completes.
    if (inOnModePicked > 0) return;

    syncUrlToMode();
    if (!currentMode) {
      removeModeSwitcher();
      await stopWatchTracking().catch(() => {});
      await applyFeatureSettings();
      update();
      maybeShowModePicker();
    } else {
      removeModePicker();
      ensureModeSwitcher();
      await applyFeatureSettings();
      update();
      if (currentMode === MODE_WATCH) {
        maybeStartWatchTracking();
        armGraceExpirationTimer();
      } else {
        await stopWatchTracking().catch(() => {});
      }
    }
  }

  if (STORAGE_WORK_SESSION_KEY in changes) {
    const newValue = changes[STORAGE_WORK_SESSION_KEY].newValue;
    const isValid =
      newValue &&
      typeof newValue === "object" &&
      typeof newValue.startedAt === "number" &&
      (newValue.noTime ||
        (typeof newValue.endsAt === "number" && newValue.endsAt > getNow()));
    workSession = isValid ? newValue : null;
    scheduleWorkSessionTransitionCheck();
    ensureWorkClock();
    refreshWorkClockPopover();
  }
});
