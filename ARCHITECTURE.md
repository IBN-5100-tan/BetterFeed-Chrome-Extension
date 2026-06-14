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

The redirect rule fires at the network layer, before the request ever
reaches a tab. When it's active, every visit to `youtube.com/` becomes a
visit to `youtube.com/feed/library#better-feed-*`, which is just a normal
YouTube page with a hash. Then at `document_start` - before any DOM is
parsed - `early.js` notices the hash and sets `.better-feed-marker-mode`
on `<html>`; `preload.css` then hides every native child of `ytd-browse`
(except our `#better-feed-home`) so the library content can't flash
through. By the time content.js loads, the page is a blank canvas onto
which the weekly grid is drawn.

The redirect rule turns off when the extension is disabled
(`settings.enabled = false`). In Watch mode it also turns off when
`settings.weeklyHomeEnabled` or `settings.redirectHomeEnabled` is off.
It is intentionally **decoupled from refresh-due state** - the background
refreshes the grid in place (a plain HTTP fetch, no navigation), so
`youtube.com/` should always land on the marker URL and never flash the
native home just because a refresh is pending.

In Work / Listen mode the rule stays on and redirects to a different
marker hash (`#better-feed-work` / `#better-feed-listen`); content.js
renders the Work placeholder on that page instead of the weekly grid.

The rule is re-evaluated on every settings / mode / fake-time storage
change, plus once every 5 minutes via a `chrome.alarms` heartbeat.
(Video-list / refresh-after changes no longer recompute the rule, since
it no longer depends on refresh-due state.)

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

### `background.js` - service worker (Chrome) / event page (Firefox)

Idle until something wakes it. It **owns the entire weekly refresh** and
keeps the redirect rule in sync:

1. `ensureFreshVideos(reason)` → `runRefresh()` is the whole refresh: when
   Watch mode (or no mode yet) + extension + weekly home are enabled and a
   refresh is due, it `fetch()`es `https://www.youtube.com/` directly,
   parses the embedded `ytInitialData` (`extractVideosFromYouTubeHomeHtml`),
   filters hidden / live, picks the grid (`chooseWeeklyVideos`), and saves
   via `saveWeeklyVideosToStorage` (which also advances `refreshAfter` and
   ships IDs to sync). No tab navigation, no DOM scraping. A single-flight
   guard (an in-memory promise plus a persisted `STORAGE_REFRESH_STATUS_KEY`
   of `{state:"idle"|"refreshing"|"error"}`) prevents double-fetching across
   wake-ups and tabs. On failure it does **not** advance `refreshAfter`, so
   the next trigger retries. The dNR rule is main_frame-scoped, so this
   `fetch` (an `xmlhttprequest`) is never redirected - no rule juggling.
2. `updateRedirectRule()` reads `settings` + `mode`, decides whether the
   redirect rule should be installed, then calls
   `declarativeNetRequest.updateDynamicRules`. Decoupled from refresh-due.
3. On `onInstalled` with `reason === "install"`: clear mode, migrate legacy
   keys, hydrate from sync, install the rule, `ensureFreshVideos`, open the
   welcome tab. Other install reasons preserve the mode.
4. On `onStartup`: clear mode, migrate, hydrate from sync, install the rule,
   `ensureFreshVideos`. (Hydrate completes first so the due-check sees the
   synced `refreshAfter`.)
5. On `chrome.storage.onChanged` (local): recompute the rule on settings /
   mode / fake-time changes; call `ensureFreshVideos` on settings /
   `refreshAfter` / videos / mode / fake-time changes. The status key is
   excluded from both (it's the refresh's own output - would loop). Sync
   changes route through `applySyncChangeToLocal()`.
6. Every 5 minutes (`chrome.alarms` `better-feed-refresh-check`): recompute
   the rule and `ensureFreshVideos` (flips a stale "due" into a refresh).
7. On `chrome.runtime.onMessage` of type `"better-feed-ensure-fresh"`: a
   fire-and-forget nudge from content (used when the event page was asleep
   at cold start). Idempotent via the single-flight lock + due-check.
8. On `chrome.tabs.onRemoved` / `onUpdated`: if no YouTube tabs remain,
   clear the mode so the next visit re-prompts the picker (with a short
   double-check to tolerate Firefox's transient zero-tab query).

The worker holds no in-memory state across wake-ups except the in-flight
refresh lock - everything else re-reads from `chrome.storage`.

### `early.js` + `preload.css`

Both load at `document_start`. The JS reads `location.hash` (set by the
redirect rule) and `localStorage.betterFeedMode` (mirrored by `shared.js`) and
applies a small set of `<html>` classes:

- `better-feed-marker-mode` and `better-feed-pre-ready` on marker URLs
  only - those whose hash is one of `#better-feed`, `#better-feed-watch`,
  `#better-feed-work`, or `#better-feed-listen`.
  `better-feed-pre-ready` keeps the app shell invisible until
  `content.js` calls `markModeReady()`, which fades it in over 220ms.
- `better-feed-work-mode` if the resolved mode is Work, or
  `better-feed-watch-mode` if Watch, on every YouTube page. Listen mode
  gets no class from early.js; once content.js loads,
  `applyMarkerModeClass()` adds `better-feed-work-mode` to `<html>` (it
  treats Listen and Work as equivalent via `isWorkLikeMode`). This lets
  preload.css hide the sidebar / home grid / etc. before YouTube paints
  them, including on non-marker pages like `/watch`.
- The last-known cleanup classes (`better-feed-hide-shorts`, …), replayed
  from the `betterFeedFeatureClasses` localStorage mirror that
  `applyFeatureSettings()` writes - so features.css can hide Shorts /
  comments / watch-recs before first paint instead of flashing them in.
  Gated by `FEATURE_CLASSES_EARLY`, an exact-match allowlist mirroring
  content.js's `FEATURE_CLASS_SETTINGS` (update both when adding a
  cleanup toggle); content.js reconciles the real set once settings load.

The CSS rules in `preload.css` are intentionally `!important` and use
`html.<class>` ancestor selectors - they have to outrank YouTube's own
stylesheets without the benefit of the cascade.

### `shared.js`

The shared layer between every other script. Imported by:

- The service worker via `importScripts("shared.js")`.
- The content scripts via `manifest.content_scripts[1].js`.
- The popup and options pages via `<script src="shared.js">`.

There are **no side effects at load time** - every function only runs when
called. This is critical: if `shared.js` tried to attach listeners or write
storage at load, the service worker would re-run them on every wake-up.

Key responsibilities:

- **Storage key constants.** `SETTINGS_KEY`, `STORAGE_VIDEOS_KEY`, etc. Every
  caller refers to them by name; values use the `betterFeed*` prefix. Old
  installs using the historical `ytWeekly*` keys are migrated on first load
  by `migrateLegacyStorageKeys()`.
- **Settings sanitizer.** `sanitizeSettings()` is the single chokepoint that
  validates every field against `DEFAULT_SETTINGS`. Anything from disk passes
  through it - if a future version adds a field, the sanitizer fills it in
  on read.
- **Mode storage.** `getCurrentMode` / `setCurrentMode` / `clearCurrentMode`,
  with a mirror to `localStorage` so `early.js` can read it synchronously.
- **Work session state.** `getWorkSession` / `setWorkSession` / `clearWorkSession`.
  A session is either timed (`startedAt`, `endsAt`, `durationMinutes`) or
  open-ended (`startedAt`, `noTime: true`); see `setWorkSession` for the
  `noGrace` flag.
- **Hidden / watched / progress writers.** Each has its own write chain
  (`enqueueHiddenWrite`, `enqueueWatchedWrite`, `enqueueProgressWrite`, built
  by `makeSerialQueue()`) - a `Promise` that serializes concurrent calls so
  two simultaneous writers can't clobber each other.
- **Daily state.** `getDailyState`, `saveDailyState`, `isDailyLimitHit`.
  Syncs across devices as a CRDT (`mergeDailyState`) so the daily limit can't be
  bypassed by switching devices - see the Daily limit section.
- **`getNow()` / `loadFakeNowOffset()` / `applyFakeNowOffsetChange()`.** A
  whole-codebase substitute for `Date.now()` so the Debug page's fake-time
  feature can offset every timestamp. Every refresh / session / lock
  comparison routes through `getNow()`.
- **`hydrateFromSync()` and `applySyncChangeToLocal()`.** The two halves of
  the local <-> sync reconciler.

### `content.js`

The behavior file. ~4700 lines, organized into the labeled sections you'll
see if you grep for `/* ---------- ... ---------- */`. The top-of-file
header lists every section and what it owns.

The single entry point is `update()`, defined near the bottom of the file
just before the **INIT** section. The actual branching logic lives in
`onHomePage()` / `onNonHomePage()`, both in the **MAIN** section.
On any mode change / storage change / SPA navigation / cold-start
completion, all roads lead to `update()`, which calls
`applyMarkerModeClass()` and then dispatches to `onHomePage()` or
`onNonHomePage()` based on `isHomePage()`.

`onHomePage()` then branches:

1. If cold-start is active, render the cold-start UI
   (`renderColdStartSetup` / `…RefreshSchedule` / `…RefreshCustom` /
   `…SyncFailed` / `…Loading`).
2. If the mode is Work or Listen (`isWorkLikeMode`), render
   `renderWorkPlaceholder()`.
3. If the mode isn't Watch, strip our UI and return.
4. If settings are disabled or `weeklyHomeEnabled` is off, strip our UI.
5. If the daily limit is hit and no grace is active, render
   `renderSeeYouTomorrow()`.
6. Otherwise, `renderFromStorage()` reads the stored grid + the background's
   refresh status and paints the grid, the "Refreshing…" loader, a quiet
   retry message, or - when the saved set exists but can't render (every
   video hidden, or every video flagged live) - an honest terminal message
   instead of a spinner that would never resolve. A pure read, no
   fetching/saving (see the refresh pipeline below).

`onNonHomePage()` runs on `/watch`, `/results`, channel pages, etc. It
doesn't replace anything - it just removes our injected style/grid (if
present) and lets YouTube render. Feature toggles (autoplay, comments, etc.)
are applied globally by `applyFeatureSettings()` - which toggles `better-feed-*`
classes on `<html>` - with the matching rules in features.css (loaded by the
manifest) regardless of page.

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

The refresh is **owned entirely by the background** (`background.js`). It
never navigates a tab and never touches the DOM - it fetches YouTube's home
HTML directly and parses the JSON the page already embeds. content.js is a
pure renderer that reacts to what the background stores.

1. **Trigger.** `ensureFreshVideos(reason)` runs on: the 5-minute alarm,
   `onInstalled` / `onStartup` (after `hydrateFromSync`), qualifying local
   `storage.onChanged` events (settings / `refreshAfter` / videos / mode /
   fake-time), and a fire-and-forget `"better-feed-ensure-fresh"` nudge that
   content sends when it has no grid (covers the cold-start / event-page-asleep
   case). All of these are in-process reactions to top-level background
   listeners - no cross-context message sits on the critical path.

2. **Guard + due-check (`runRefresh`).** Returns immediately unless Watch mode
   (or no mode yet) + `enabled` + `weeklyHomeEnabled`, and `isRefreshDue`. A
   single-flight guard - an in-memory `refreshInFlight` promise plus a
   persisted `STORAGE_REFRESH_STATUS_KEY` (`{state:"refreshing", startedAt}`
   honored for `REFRESH_INFLIGHT_TTL_MS`) - prevents two wakes or two tabs
   from double-fetching.

3. **Fetch + parse.** `fetchYouTubeHomeHtml()` is a plain
   `fetch("https://www.youtube.com/", {credentials:"include"})`. The dNR
   redirect rule is `main_frame`-scoped, so it does **not** match this fetch
   (an `xmlhttprequest`) - no rule drop/restore needed.
   `extractVideosFromYouTubeHomeHtml()` (shared.js) walks the embedded
   `ytInitialData`, pulling each `lockupViewModel` into a complete video
   record (title, channel, avatar, duration, views, publish date, live flag).
   No enrichment step - the parser already returns full objects.

4. **Filter + pick + save.** `filterHiddenVideos()` strips hidden items;
   live broadcasts are dropped when `settings.excludeLiveVideos`;
   `chooseWeeklyVideos()` dedups, prefers fully-populated entries, and slices
   to `videoCount + REFRESH_BACKFILL_BUFFER` (capped at `MAX_WEEKLY_VIDEOS`).
   `saveWeeklyVideosToStorage(chosen, getNextRefreshTime(settings))` writes
   `STORAGE_VIDEOS_KEY` + `STORAGE_REFRESH_AFTER_KEY` and mirrors a slim
   ID-only version to sync.

5. **Status + render.** On success the status flips to `{state:"idle"}`; on
   failure to `{state:"error"}` **without advancing `refreshAfter`** (so the
   next alarm retries). The `STORAGE_VIDEOS_KEY` / status writes fire
   `storage.onChanged` in every live tab - content's listener calls `update()`
   → `renderFromStorage()`, which swaps the loader for the freshly-stored
   grid. That `storage.onChanged` is the **only** render-notification channel;
   there are no retry timers or focus hooks.

`REFRESH_BACKFILL_BUFFER = 5` is a small over-scrape (save `videoCount + 5`).
The renderer's order encodes a deliberate asymmetry: it **live-filters the saved
pool first**, then takes the first `videoCount` as the week's **fixed set**, then
**hidden-filters** that set. So a late-detected live stream is *backfilled* from
the reserve (you always get `videoCount` watchable videos), while **hiding shrinks
the grid and never backfills** - once your week's videos are in place, hiding them
must not surface new ones until the next scheduled refresh.

> Historical note: refresh used to work by redirect-bouncing the tab to vanilla
> `youtube.com`, DOM-scraping the rendered grid, and bouncing back - wrapped in
> cooldowns, retry timers, and sessionStorage flags. That was replaced by the
> background HTTP-fetch design above; the JSON the server embeds is far more
> stable than the rendered DOM, and there's no navigation to race.

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

The canonical store for the active mode is
`chrome.storage.local.betterFeedSessionMode`, read via `getCurrentMode()`.
Two mirrors of it exist so early code can resolve the mode synchronously:
`localStorage.betterFeedMode` (written by `syncModeToLocalStorage` on
every `setCurrentMode` / `clearCurrentMode`) and the marker-page URL
hash (set by the dNR redirect rule). `early.js` reads the URL hash first
on marker pages; on non-marker pages (e.g. `/watch`) it falls back to
`localStorage`. Once `content.js` loads, `loadCurrentMode()` re-reads
from `chrome.storage.local` so the in-memory `currentMode` matches the
canonical store.

When the user opens YouTube fresh (typed URL, bookmark, external link)
the mode picker re-prompts - see `isFreshTabNavigation()`. SPA navigations
inside the same tab don't re-prompt.

---

## Work session state machine

Two flavors, both stored at `STORAGE_WORK_SESSION_KEY`:

- **Timed:** `{ startedAt, endsAt, durationMinutes }`. Watch is locked
  until `endsAt`. Session auto-ends at `endsAt`.
- **No-time:** `{ startedAt, noTime: true }`. No end. Watch lock is
  dynamic - see below.

For no-time sessions, the lock window has three phases:

```
session start         + NO_TIME_GRACE_MS (15s)        + NO_TIME_LOCK_MS (20m)
├──── grace window ──┼──────── lock window ────────────┼───── no lock ─────────>
   bail freely          unlock code required               bail freely (but
                                                            session is still
                                                            running)
```

`lockStartsAt()` returns `startedAt + NO_TIME_GRACE_MS`; `lockEndsAt()`
returns `lockStartsAt() + NO_TIME_LOCK_MS`. So the lock window is 20
minutes long, beginning 15 seconds after the session starts.

When the lock window is active, choosing Watch from the mode switcher
opens the unlock challenge (`renderWorkUnlockModal`) - type a fresh 16-20
digit code to release.

A "no-grace" session (`noGrace: true`) skips the grace window entirely
(`lockStartsAt()` returns `startedAt` directly). Set when starting a
session from the **clock popover** or the **session-ended popup** - the
user is already mid-Work and re-committing, so there's no fat-finger
window to protect.

The transitions between grace / lock / no-lock are handled by
`scheduleWorkSessionTransitionCheck()`, which sets a `setTimeout` for the
next transition boundary and rebuilds the masthead chip when it fires.

---

## Daily limit

Tracks two counters per "day key":

- `videoIds` - array of distinct video IDs started today.
- `secondsByDevice` - `{ deviceId: seconds }`; total watch time =
  `dailyTotalSeconds()` = sum of the buckets.

A "day" is delimited by the user's `refreshHour` setting. Before that hour,
content.js treats the day as the previous calendar date - so a limit of "3
videos per day" with a refresh hour of 5am resets at 5am, not midnight.

**Cross-device.** The daily state **syncs** so the limit roams (you can't bypass
it by switching devices). It's merged as a CRDT (`mergeDailyState`): different
day-keys → the later day wins (a new day resets everyone); same day → `videoIds`
union + per-device-bucket max. Each device writes only its OWN seconds bucket, so
summing the buckets gives the true cross-device total with no double-counting or
lost time. The watch tab pushes the state to sync immediately on a video-count
change or the limit-hit moment, and debounced (~30s) for routine seconds flushes
(quota). `getDeviceId()` is a stable, local-only, never-synced random id.
*Caveat:* "today" is local-time + `refreshHour`, so devices in different
timezones can roll over at slightly different moments (same-timezone is exact).
The "5 more minutes"/"finish" grace stays **per-device** (re-decided on each).

`isDailyLimitHit(state, settings)` respects `dailyLimitMode`:

| Mode    | Trigger                                                |
|---------|--------------------------------------------------------|
| `videos`| `videoIds.length >= maxVideosPerDay`                    |
| `time`  | `dailyTotalSeconds(state) >= maxSecondsPerDay`          |
| `both`  | Either of the above (whichever hits first).             |

The takeover (`renderSeeYouTomorrow`) is owned by `onHomePage` - it
renders whenever the user lands on the Watch marker page with the limit
hit and no grace. Two other code paths funnel into that takeover by
navigating to the marker:

- **During playback** (`tickWatchTracking`): when the projected
  `secondsWatched` would hit the limit, the player is paused and
  `showDailyLimitPopup()` opens with four buttons - "1 more minute"
  (`onGraceChosen("minutes", 60)`), "5 more minutes"
  (`onGraceChosen("minutes", 300)`), "Finish video"
  (`onGraceChosen("finish")`), and "Exit video"
  (calls `redirectToBlockedMarker()` directly).
- **Arriving at `/watch`** (`maybeStartWatchTracking`): if the limit is
  already hit and no grace is active - or starting a new video would
  push `videoIds.length` past `maxVideosPerDay` - `redirectToBlockedMarker()`
  navigates the tab to the Watch marker URL, where `onHomePage` then
  renders the takeover.

The user can dismiss with a grace via `onGraceChosen("minutes", seconds)`
or `onGraceChosen("finish")`. Graces are stored at
`STORAGE_DAILY_GRACE_KEY` and time out via either
`armGraceExpirationTimer` (minutes - fires a `setTimeout` at the
expiration boundary) or `maybeEnforceGraceOnNavigation` (finish - also
catches expired minutes graces, re-checked on every SPA navigate). A
"finish" grace is also auto-granted by `tickWatchTracking` when the
video count limit is crossed mid-watch, so the user isn't pulled out of
the video they're currently watching.

---

## Watch tracking and auto-watched marking

Two parallel tickers, both keyed off the `<video>` element on watch
pages. They have different scopes - the daily-limit ticker runs for any
video, the watched-marking ticker only for videos in the current week's
grid:

- **`tickWatchTracking()`** every 1 second, started by `maybeStartWatchTracking()`
  when the active mode is Watch and `settings.dailyLimitEnabled`. It
  computes the per-tick delta from `videoEl.currentTime`, skips paused /
  ended / not-yet-ready frames, and discards seek jumps (`delta > 2s` or
  `delta <= 0`). Real watched seconds accumulate in
  `watchTrackPendingSeconds` and are flushed to this device's bucket in the
  daily state's `secondsByDevice` every `WATCH_FLUSH_INTERVAL_MS` (5s) - not on
  every tick. After `VIDEO_COUNT_THRESHOLD_SEC` (5s) of playback, the video's
  ID is appended to `state.videoIds`; if that push crosses
  `maxVideosPerDay`, a `"finish"` grace is auto-granted for the current
  video so the user isn't yanked out mid-watch. If the daily limit is
  hit and no grace is active, the player is paused and the
  see-you-tomorrow popup is shown.
- **`tickWatchedMarking()`** every 2 seconds, started by
  `maybeStartWatchedMarking()` *only* when the current `/watch` video is
  in the stored weekly grid (search results, sidebar suggestions, etc.
  are skipped). Writes per-video `{position, duration}` to
  `STORAGE_PROGRESS_KEY`, skipping the position-0 write and any write
  whose fraction is within `PROGRESS_WRITE_DELTA = 0.01` of the last
  one. The video is added to the watched set (`modifyWatched`) when any
  of these thresholds fire: `videoEl.ended`,
  ≤ `WATCHED_MARK_REMAINING_THRESHOLD_SEC` (20s) remaining on a video
  longer than 20s, or ≥ 90% played.

Progress is flushed to sync via `flushProgressToSync` on `pagehide` and
on `stopWatchedMarking()` (when the watched ticker stops because the user
navigated away or the video changed) - never on every tick. The flush
also prunes stale entries (videos no longer in the current week's grid)
before writing.

---

## Storage and sync model

Two `chrome.storage` areas are in play: `local` (per-device, larger quota)
and `sync` (cross-device, tight quotas). Every key listed below lives in
`local`; the "Synced" subset is *also* mirrored to `sync` on write.

### Local-only (per-device)

| Key                              | Contents                                          |
|----------------------------------|---------------------------------------------------|
| `STORAGE_MODE_KEY`               | Current mode (watch/work/listen).                 |
| `STORAGE_WORK_SESSION_KEY`       | Work session state (per-device focus state).      |
| `STORAGE_DAILY_GRACE_KEY`        | Active "5 more min" / "finish video" grace (per-device). |
| `STORAGE_DEVICE_ID_KEY`          | Stable random per-device id (tags daily seconds buckets). |
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
| `STORAGE_HIDDEN_VIDEOS_KEY`      | Array of hidden video IDs.                        |
| `STORAGE_HIDDEN_CHANNELS_KEY`    | Array of hidden channel keys.                     |
| `STORAGE_WATCHED_VIDEOS_KEY`     | Array of watched video IDs (this week).           |
| `STORAGE_PROGRESS_KEY`           | `{ [videoId]: {position, duration} }` locally; sync ships only the position as a bare number per video. |
| `STORAGE_DAILY_STATE_KEY`        | Daily limit progress: `videoIds` + `secondsByDevice`. CRDT-merged (`mergeDailyState`) so the limit roams across devices. |

Sync caps:

- `MAX_HIDDEN_PER_TYPE = 5000` - local cap.
- `SYNC_HIDDEN_VIDEOS_CAP = 200`, `SYNC_HIDDEN_CHANNELS_CAP = 100`,
  `SYNC_WATCHED_VIDEOS_CAP = 200` - the tail of the local list is shipped.

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
- **Daily state (`mergeDailyState`):** later day-key wins outright (new day
  resets); within the same day, `videoIds` union + per-device-bucket max on
  `secondsByDevice` (summed for the limit check). Each device writes only its
  own bucket, so the cross-device total is exact - no double-count, no loss.

---

## Hidden items and oEmbed rebuild

On disk, hidden state lives in three keys: `STORAGE_HIDDEN_VIDEOS_KEY`
and `STORAGE_HIDDEN_CHANNELS_KEY` (each an array of IDs / channel keys)
and `STORAGE_HIDDEN_METADATA_KEY` - a single map keyed by both video IDs
and channel keys. Video entries look like `{type: "video", title,
channelName}`; channel entries look like `{type: "channel", channelName}`.
`getHiddenItems()` / `getHiddenItemsWithMetadata()` return them in memory
as `{videos: Set, channels: Set, metadata}` for ergonomic membership tests.

The metadata blob is local-only - when a fresh device hydrates, the
popup/options page calls `backfillMissingHiddenVideoMetadata()`, which
hits `youtube.com/oembed` to recover titles + channels. The same trick
fills in the weekly grid via `rebuildVideoMetadataIfNeeded()`
(content.js).

oEmbed concurrency for the hidden-items backfill is capped at 4
(`OEMBED_CONCURRENCY`); the content-script weekly-grid rebuild uses its own
`VIDEO_METADATA_REBUILD_CONCURRENCY` (also 4). Both stay neighborly with
YouTube's edge.

---

## CSS hiding strategy

There are two CSS injection points:

1. **`preload.css`** at `document_start`. Targets the native YouTube
   shell - hides the home grid (always, unless
   `better-feed-show-native-home` is set), the marker-page library
   content, the Work-mode sidebar, and (via `better-feed-pre-ready`)
   fades in the whole `ytd-app` once content.js has decided what to
   render. Uses `!important` and `html.<class>` ancestor selectors to
   outrank YouTube's stylesheet.

2. **features.css**, loaded by the manifest. Its rules are gated on feature
   classes (`better-feed-hide-shorts`, `better-feed-hide-comments`, etc.),
   which `applyFeatureSettings()` toggles on `<html>`
   (`document.documentElement`) whenever settings change. The constants are
   named `BODY_CLASS_*` for historical reasons but attach to `<html>`,
   matching the `html.<class>` selectors used throughout.

The split lets `preload.css` ship before any DOM parses (anti-flash work)
while keeping the feature-toggle CSS dynamic.

---

## Cold start

When the extension is installed on a device that's never synced:

1. The init IIFE in `content.js` calls `detectColdStart()`, which returns
   true when *both* `SETTINGS_KEY` and `STORAGE_VIDEOS_KEY` are missing
   from local storage.
2. `renderColdStartSetup()` asks whether to wait for sync or start fresh.
3. If "wait for sync," `COLD_START_TIMEOUT_MS = 5000` ms is the budget.
   If sync arrives, the weekly grid populates immediately. If it doesn't,
   `renderColdStartSyncFailed()` offers manual retry or fresh-start.
4. If "start fresh," `renderColdStartRefreshSchedule()` asks for a refresh
   schedule (with a "Custom" subview for per-day picking).
5. Once a schedule is chosen, settings save and the normal refresh
   pipeline takes over.

All four states are tracked by `coldStartView`. The storage listener
calls `maybeReEnterColdStart()` whenever settings *or* videos are
cleared in storage; that function only re-enters cold start if
`detectColdStart()` still finds both missing, so a single-key clear
(e.g., settings without videos) won't reset the UI on its own.

---

## Notable design decisions

- **No build step.** Everything is plain JS, no bundling, no transpilation.
  Edit a file, reload the unpacked extension, done. The trade-off is
  that the codebase can't use modules - all files share a global scope.
- **Single `update()` dispatcher.** Easier to reason about than a state
  machine class for the small number of UI states involved.
- **Marker URL trick instead of an embedded WebView.** Reusing
  `/feed/library` means YouTube's app shell (masthead, sidebar, search,
  player) all still work - we just hide the body content and inject our
  grid. Channel pages, watch pages, search, etc. are untouched.
- **Sync ships IDs only for the weekly grid.** Cuts the per-grid sync
  blob by ~80% and keeps it under `chrome.storage.sync`'s 8 KB
  per-item quota (with plenty of room under the 102 KB total quota).
  oEmbed fills in the metadata after the IDs land.
- **`getNow()` everywhere refresh / session / lock / grace state is
  evaluated.** Sync LWW timestamps (`_updatedAt`) and a few timer-wait
  calculations deliberately use real `Date.now()`, but anything the user
  can observe as time-dependent state routes through `getNow()` so the
  Debug fake-time offset can rewind/forward the entire extension with
  one storage write. Critical for testing weekly/multi/daily refresh
  flows without waiting a calendar day.
- **Friction-by-typing for unlock codes.** No paste, no autofill, no copy
  from the displayed code. The point is to make the user pause - anything
  that lets them script the unlock defeats the feature.
