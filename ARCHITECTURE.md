# Architecture

A walk through how BetterFeed works under the hood. Read [README.md](README.md)
first for what the extension does from a user's perspective; this document
explains the implementation.

---

## Big-picture flow

```
                  ┌──────────────────────────┐
                  │  user visits youtube.com │
                  └────────────┬─────────────┘
                               │
              ┌────────────────▼─────────────────┐
              │ dNR redirect rule (background.js)│
              │  www.youtube.com/  →             │
              │  www.youtube.com/feed/library    │
              │     #better-feed-{watch|work|...}│
              └────────────────┬─────────────────┘
                               │
                  ┌────────────▼────────────┐
                  │  document_start:        │
                  │  early.js + preload.css │
                  │  hide native shell      │
                  └────────────┬────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  content.js loads (parsed   │
                │  DOM). update() runs and    │
                │  picks a render branch.     │
                └──────────────┬──────────────┘
                               │
        ┌──────────────────────┼─────────────────────────┐
        ▼                      ▼                         ▼
   weekly grid             Work mode               cold-start /
   (Watch mode)            placeholder             mode picker
                                                   (no settings yet)
```

The redirect rule is the **only** thing that runs before the page parses. Every
visit to `youtube.com/` becomes a visit to `youtube.com/feed/library#better-feed-*`,
which is just a normal YouTube page with a hash. `early.js` notices the hash and
sets `.better-feed-marker-mode` on `<html>`; `preload.css` then hides every native
child of `ytd-browse` so the library content can't flash through. By the time
content.js loads, the page is a blank canvas onto which the weekly grid is
drawn.

The redirect rule turns off when:

- The extension is disabled (`settings.enabled = false`).
- The user is in Work/Listen mode (those modes don't replace the home page).
- A refresh is due (we *want* to land on the real home so we can scrape it).

That last point is why the rule is re-evaluated on every settings / mode /
video-list / fake-time change, plus once every 5 minutes via a `chrome.alarms`
heartbeat.

---

## Modules

### `manifest.json`

Manifest V3. Lists:

- `permissions`: `storage`, `declarativeNetRequest`, `alarms`.
- `host_permissions`: `*://www.youtube.com/*`.
- Two content-script entries on `*://www.youtube.com/*`:
  - At `document_start`: `early.js` + `preload.css`.
  - At default time: `shared.js`, `content.js`.
- `background.service_worker`: `background.js`.
- `options_ui.page`: `options.html` (opens in a tab).
- `action.default_popup`: `popup.html`.
- The `key` field locks the extension ID so unpacked development and Web Store
  installs share the same ID. See [CONTRIBUTING.md](CONTRIBUTING.md#publishing-to-the-chrome-web-store).

### `background.js` — service worker

Idle until something wakes it. On wake-up:

1. `loadFakeNowOffset()` so `getNow()` returns the right value.
2. `updateRedirectRule()` — read `settings`, `mode`, `refreshAfter`,
   `hasVideos`, decide whether the redirect rule should be installed, then
   `declarativeNetRequest.updateDynamicRules`.
3. On `onInstalled`: clear mode (so the user picks again), hydrate from sync,
   open the welcome tab if `reason === "install"`.
4. On `onStartup`: same minus the welcome tab.
5. Every 5 minutes (`chrome.alarms`): re-run `updateRedirectRule()`.
6. On `chrome.runtime.onMessage` `"better-feed-prepare-scrape"`: temporarily
   remove the redirect rule so content.js can navigate the tab to the real
   `youtube.com/` and scrape. The rule is reinstalled by the next
   settings/mode change once the scrape finishes.

The service worker holds no in-memory state across wake-ups — everything
re-reads from `chrome.storage`.

### `early.js` + `preload.css`

Both load at `document_start`. The JS reads `location.hash` (set by the
redirect rule) and `localStorage.betterFeedMode` (mirrored by `shared.js`) and
applies a small set of `<html>` classes:

- `better-feed-marker-mode` on every marker URL.
- `better-feed-pre-ready` on every YouTube page until `content.js` says it's
  done initializing (fades in the app shell over 220 ms).
- `better-feed-work-mode` when entering Work mode (so the sidebar / home grid
  / etc. can be hidden before YouTube tries to render them).

The CSS rules in `preload.css` are intentionally `!important` and use
`html.<class>` ancestor selectors — they have to outrank YouTube's own
stylesheets without the benefit of the cascade.

### `shared.js`

The shared layer between every other script. Imported by:

- The service worker via `importScripts("shared.js")`.
- The content scripts via `manifest.content_scripts[1].js`.
- The popup and options pages via `<script src="shared.js">`.

There are **no side effects at load time** — every function only runs when
called. This is critical: if `shared.js` tried to attach listeners or write
storage at load, the service worker would re-run them on every wake-up.

Key responsibilities:

- **Storage key constants.** `SETTINGS_KEY`, `STORAGE_VIDEOS_KEY`, etc. Every
  caller refers to them by name; values use the `betterFeed*` prefix. Old
  installs using the historical `ytWeekly*` keys are migrated on first load
  by `migrateLegacyStorageKeys()`.
- **Settings sanitizer.** `sanitizeSettings()` is the single chokepoint that
  validates every field against `DEFAULT_SETTINGS`. Anything from disk passes
  through it — if a future version adds a field, the sanitizer fills it in
  on read.
- **Mode storage.** `getCurrentMode` / `setCurrentMode` / `clearCurrentMode`,
  with a mirror to `localStorage` so `early.js` can read it synchronously.
- **Work session state.** `getWorkSession` / `setWorkSession` / `clearWorkSession`.
  A session is either timed (`startedAt`, `endsAt`, `durationMinutes`) or
  open-ended (`startedAt`, `noTime: true`); see `setWorkSession` for the
  `noGrace` flag.
- **Hidden / watched / progress writers.** Each has its own write chain
  (`hiddenWriteChain`, `watchedWriteChain`, `progressWriteChain`) — a
  `Promise` that serializes concurrent calls so two simultaneous writers
  can't clobber each other.
- **Daily state.** `getDailyState`, `saveDailyState`, `isDailyLimitHit`.
  Lives in local storage only — daily progress doesn't roam across devices.
- **`getNow()` / `loadFakeNowOffset()` / `applyFakeNowOffsetChange()`.** A
  whole-codebase substitute for `Date.now()` so the Debug page's fake-time
  feature can offset every timestamp. Every refresh / session / lock
  comparison routes through `getNow()`.
- **`hydrateFromSync()` and `applySyncChangeToLocal()`.** The two halves of
  the local <-> sync reconciler.

### `content.js`

The behavior file. ~6700 lines, organized into the labeled sections you'll
see if you grep for `/* ---------- ... ---------- */`. The top-of-file
header lists every section and what it owns.

The single entry point is `update()` (around the **MAIN** section). On any
mode change / storage change / SPA navigation / cold-start completion, all
roads lead to `update()`, which:

1. Checks for cold-start (a fresh install with no settings yet) and renders
   the four-step welcome flow if so.
2. Routes Work/Listen mode to `renderWorkPlaceholder()`.
3. Routes Watch mode on `/` (or the marker URL) to the weekly home renderer
   (`getOrCreateWeeklyVideos` -> `renderCustomHome`).
4. Falls through to `onNonHomePage()` for `/watch`, `/results`, channel
   pages, etc. — these don't replace anything, they just apply feature
   toggles (autoplay, comments, etc.).

### `options.js` + `options.html`

The options page is a multi-page UI with a sidebar nav and `data-page`
sections. Auto-save: any field listed in `AUTO_SAVE_FIELDS` fires
`change` -> `autoSave()` -> `saveSettings()` (which routes through
`sanitizeSettings`).

The **Watching lock** is enforced on the page itself: sections marked
`data-lockable="watching"` get a banner overlay (`.lock-banner`) whenever
`hasWatchProgressToday()` returns true, and the contents (inside
`.lock-controls`) are `disabled`. Clicking **Unlock** opens the same
typed-code challenge as the work-session unlock.

### `popup.js` + `popup.html`

Lightweight. Two buttons: **Settings** (opens the options page) and
**Hidden Items** (expands an inline restore list).

### `welcome.html` + `welcome.js`

Pure marketing. Shown once via `chrome.tabs.create({ url: "welcome.html" })`
in the install handler. Two CTAs: open settings, or jump to YouTube.

---

## The refresh pipeline

Refresh is the trickiest path in the codebase. Here's the sequence when a
refresh is due:

1. **Detection.** `getOrCreateWeeklyVideos()` checks
   `now >= stored.refreshAfter || !hasStoredVideos`. If false, the stored
   grid is used as-is.

2. **Bouncing off the marker.** If the user is on the marker URL (which is
   almost always the case), we need to navigate to the *real* home page
   to scrape. The marker page can't scrape itself — the redirect rule
   would just keep bouncing it. So content.js:
   - Stores `REFRESH_RETURN_FLAG = "1"` in `sessionStorage`.
   - Sends `"better-feed-prepare-scrape"` to the service worker.
   - The service worker drops the redirect rule and replies `{ok: true}`.
   - content.js sets `window.location.href = "https://www.youtube.com/"`.

3. **Scraping.** With the redirect rule gone, the navigation lands on the
   real home page. The same content.js loads again, sees
   `REFRESH_RETURN_FLAG = "1"` in sessionStorage, renders the "Refreshing..."
   loading screen, then:
   - `waitForVideoLinks(targetCount)` waits for YouTube's grid to populate.
   - `scrapeRecommendations(candidateCount)` snapshots N candidate videos.
   - `chooseWeeklyVideos()` picks the final set, filtering hidden /
     mix-radio / sponsored / live items.

4. **Enrichment.** `enrichVideosFast()` fires per-video lookups against
   the watch page and channel page (with `FETCH_TIMEOUT_MS = 1800`) to fill
   in duration, view count, publish date, and the channel avatar.

5. **Save + return.** `saveWeeklyVideos(videosToSave, nextRefreshAfter)`
   writes the result to local storage (which mirrors a slim ID-only version
   to sync). Then content.js:
   - Clears `REFRESH_RETURN_FLAG`.
   - Navigates back to the marker URL.
   - The service worker re-installs the redirect rule on the next storage
     change (`STORAGE_VIDEOS_KEY` changed).

6. **Render.** On the marker page reload, `update()` runs again, sees the
   freshly-stored grid, and renders it.

`REFRESH_BACKFILL_BUFFER = 5` is a small over-scrape — the watch-page
enrichment sometimes flags a video as live ("Streamed N ago") that the
home-grid scrape didn't catch, and we'd rather drop a few than show a
short grid.

---

## Modes and the mode picker

Three modes:

| Mode    | Hash               | Behavior                                      |
|---------|--------------------|-----------------------------------------------|
| Watch   | `#better-feed-watch` | Weekly home grid. Daily limit applies.      |
| Work    | `#better-feed-work`  | Search-only. Sidebar/home/grids hidden.     |
| Listen  | `#better-feed-listen`| Same friction as Work; named for intent.    |

Treated as equivalent by `isWorkLikeMode(mode)` in content.js. If you find
a Watch-vs-Work check that should also apply to Listen, use that helper.

`currentMode` lives in `chrome.storage.local.betterFeedSessionMode` and is
mirrored to `localStorage` so `early.js` can read it synchronously. The
URL hash is the source of truth on marker pages; localStorage is the
fallback for non-marker pages (e.g. `/watch`).

When the user opens YouTube fresh (typed URL, bookmark, external link)
the mode picker re-prompts — see `isFreshTabNavigation()`. SPA navigations
inside the same tab don't re-prompt.

---

## Work session state machine

Two flavors, both stored at `STORAGE_WORK_SESSION_KEY`:

- **Timed:** `{ startedAt, endsAt, durationMinutes }`. Watch is locked
  until `endsAt`. Session auto-ends at `endsAt`.
- **No-time:** `{ startedAt, noTime: true }`. No end. Watch lock is
  dynamic — see below.

For no-time sessions:

```
0s                   15s (NO_TIME_GRACE_MS)            20m (NO_TIME_LOCK_MS)
├──── grace window ──┼──────── lock window ────────────┼───── no lock ─────────>
   bail freely          unlock code required               bail freely (but
                                                            session is still
                                                            running)
```

When the lock window is active, choosing Watch from the mode switcher
opens the unlock challenge (`renderWorkUnlockModal`) — type a fresh 16–20
digit code to release.

A "no-grace" session (`noGrace: true`) skips the grace window entirely. Set
when starting a session from the **clock popover** or the **session-ended
popup** — the user is already mid-Work and re-committing, so there's no
fat-finger window to protect.

The transitions between grace / lock / no-lock are handled by
`scheduleWorkSessionTransitionCheck()`, which sets a `setTimeout` for the
next transition boundary and rebuilds the masthead chip when it fires.

---

## Daily limit

Tracks two counters per "day key":

- `videoIds` — set of videos started today.
- `secondsWatched` — total watch seconds today.

A "day" is delimited by the user's `refreshHour` setting. Before that hour,
content.js treats the day as the previous calendar date — so a limit of "3
videos per day" with a refresh hour of 5am resets at 5am, not midnight.

`isDailyLimitHit(state, settings)` respects `dailyLimitMode`:

| Mode    | Trigger                                                |
|---------|--------------------------------------------------------|
| `videos`| `videoIds.length >= maxVideosPerDay`                    |
| `time`  | `secondsWatched >= maxSecondsPerDay`                    |
| `both`  | Either of the above (whichever hits first).             |

When hit, content.js redirects the tab to the marker URL and renders the
"see you tomorrow" takeover (`renderSeeYouTomorrow`). The user can dismiss
with a grace (`onGraceChosen("minutes", seconds)` or `("finish")`).
Graces are stored at `STORAGE_DAILY_GRACE_KEY` and time out via either
`armGraceExpirationTimer` (minutes) or `maybeEnforceGraceOnNavigation`
(finish — re-checked on every SPA navigate).

---

## Watch tracking and auto-watched marking

Two parallel tickers, both keyed off the `<video>` element on watch pages:

- **`tickWatchTracking()`** every 5 seconds. Accumulates real seconds the
  user has been on this video (not in a paused state), persists them to
  the daily state's `secondsWatched`, and flips the daily-limit takeover
  on if the threshold crosses.
- **`tickWatchedMarking()`** every 250ms. Writes per-video
  `{position, duration}` to `STORAGE_PROGRESS_KEY` so the progress bar
  renders the next time the grid loads. Within 20 seconds of the end the
  video is added to the watched set (`modifyWatched`).

Progress is flushed to sync on `pagehide` (`flushProgressToSync`) — only
on exit signals, not every tick. The flush also prunes stale entries
(videos no longer in the current week's grid) before writing.

---

## Storage and sync model

### Local-only (per-device)

| Key                              | Contents                                          |
|----------------------------------|---------------------------------------------------|
| `STORAGE_MODE_KEY`               | Current mode (watch/work/listen).                 |
| `STORAGE_WORK_SESSION_KEY`       | Work session state (per-device focus state).      |
| `STORAGE_DAILY_STATE_KEY`        | Today's videoIds + secondsWatched.                |
| `STORAGE_DAILY_GRACE_KEY`        | Active "5 more min" / "finish video" grace.       |
| `STORAGE_HIDDEN_METADATA_KEY`    | Title/channel cache for hidden items.             |
| `STORAGE_FAKE_NOW_OFFSET_KEY`    | Debug fake-time offset.                           |

The hidden-metadata cache is *not* synced; cross-device installs rebuild
it via YouTube's oEmbed endpoint when the popup or options page renders.

### Synced across devices

| Key                              | Contents                                          |
|----------------------------------|---------------------------------------------------|
| `SETTINGS_KEY`                   | Sanitized settings + `_updatedAt` for LWW.        |
| `STORAGE_VIDEOS_KEY`             | Weekly grid (sync ships IDs only; local has full).|
| `STORAGE_REFRESH_AFTER_KEY`      | Timestamp of the next due refresh.                |
| `STORAGE_HIDDEN_VIDEOS_KEY`      | Set of hidden video IDs.                          |
| `STORAGE_HIDDEN_CHANNELS_KEY`    | Set of hidden channel keys.                       |
| `STORAGE_WATCHED_VIDEOS_KEY`     | Set of watched video IDs (this week).             |
| `STORAGE_PROGRESS_KEY`           | Per-video position. Sync ships bare numbers.      |

Sync caps:

- `MAX_HIDDEN_PER_TYPE = 5000` — local cap.
- `SYNC_HIDDEN_VIDEOS_CAP = 200`, `SYNC_HIDDEN_CHANNELS_CAP = 100`,
  `SYNC_WATCHED_VIDEOS_CAP = 200` — the tail of the local list is shipped.

`priorityWriteSync(items, { evictKeysInOrder })` retries a quota-exceeded
sync set by progressively removing lower-priority keys.

### Reconciliation (`hydrateFromSync` + `applySyncChangeToLocal`)

- **Settings:** last-writer-wins on `_updatedAt`.
- **Weekly grid + `refreshAfter`:** higher `refreshAfter` wins (newer week
  beats older).
- **Hidden videos / channels / watched videos:** set union. There's no
  delete signal; removed items can re-appear if a stale device pushes the
  old set. The capped sync slice keeps drift bounded.
- **Progress map:** max-position wins per video.

---

## Hidden items and oEmbed rebuild

Hidden videos are stored as `{Set videoIds, Set channelKeys, metadata}`,
where `metadata` is `{[id]: {title, channelName}}`. The metadata blob is
local-only — when a fresh device hydrates, the popup/options page calls
`backfillMissingHiddenVideoMetadata()`, which hits `youtube.com/oembed`
to recover titles + channels. Same trick for the weekly grid in
`rebuildVideoMetadataIfNeeded()` (content.js).

oEmbed concurrency is capped at 4 (`OEMBED_CONCURRENCY`) to stay
neighborly with YouTube's edge.

---

## CSS hiding strategy

There are two CSS injection points:

1. **`preload.css`** at `document_start`. Targets the native YouTube
   shell — hides the home grid, the marker-page library content, the
   Work-mode sidebar, the cold-start app shell. Uses `!important` and
   `html.<class>` ancestor selectors to outrank YouTube's stylesheet.

2. **`injectFeatureStyle()`** in content.js. A second `<style>` block
   that toggles every feature class (`better-feed-hide-shorts`,
   `better-feed-hide-comments`, etc.) on `<body>` based on settings.

The split lets `preload.css` ship before any DOM parses (anti-flash work)
while keeping the feature-toggle CSS dynamic.

---

## Cold start

When the extension is installed on a device that's never synced:

1. `update()` notices `!hasStoredVideos && !hasStoredSettings` and enters
   cold-start mode.
2. `renderColdStartSetup()` asks whether to wait for sync or start fresh.
3. If "wait for sync," `COLD_START_TIMEOUT_MS = 5000` ms is the budget.
   If sync arrives, the weekly grid populates immediately. If it doesn't,
   `renderColdStartSyncFailed()` offers manual retry or fresh-start.
4. If "start fresh," `renderColdStartRefreshSchedule()` asks for a refresh
   schedule (with a "Custom" subview for per-day picking).
5. Once a schedule is chosen, settings save and the normal refresh
   pipeline takes over.

All four states are tracked by `coldStartView` and re-entered through
`update()` (so a settings reset wipes back to the cold-start setup).

---

## Notable design decisions

- **No build step.** Everything is plain JS, no bundling, no transpilation.
  Edit a file, reload the unpacked extension, done. The trade-off is
  that the codebase can't use modules — all files share a global scope.
- **Single `update()` dispatcher.** Easier to reason about than a state
  machine class for the small number of UI states involved.
- **Marker URL trick instead of an embedded WebView.** Reusing
  `/feed/library` means YouTube's app shell (masthead, sidebar, search,
  player) all still work — we just hide the body content and inject our
  grid. Channel pages, watch pages, search, etc. are untouched.
- **Sync ships IDs only for the weekly grid.** Cuts the per-grid sync
  blob by ~80% and makes the 102 KB per-item sync quota much harder to hit.
  oEmbed fills in the metadata after the IDs land.
- **`getNow()` everywhere.** Every timestamp comparison routes through it
  so the Debug fake-time offset can rewind/forward the entire extension
  with one storage write. Critical for testing weekly/multi/daily refresh
  flows without waiting a calendar day.
- **Friction-by-typing for unlock codes.** No paste, no autofill, no copy
  from the displayed code. The point is to make the user pause — anything
  that lets them script the unlock defeats the feature.
