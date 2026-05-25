# BetterFeed

## Control your content. Kill doomscrolling.

BetterFeed is a Chrome extension that replaces YouTube's algorithmic, infinite
homepage with a small, **static** weekly grid that only changes when you decide.

You see the same videos until your scheduled refresh, so that **you can discover new
videos without all of the doomscrolling traps.**

---

![Before and after: YouTube's default homepage vs. BetterFeed's static weekly grid](pictures/before-after.png)

## Highlights

- **Static weekly home.** Pick a day and time; until then the grid doesn't move.
- **Three refresh cadences.** Weekly, multiple days per week, or daily.
- **Distraction cleanup.** Hide Shorts, watch-page recommendations, end-screen cards, autoplay,
  live chat, side panel, comments, notification bell, mix/radio playlists,
  voice search, Create button, Explore/Trending, Mix Radio playlists, and more.
- **Daily watch limit.** Cap by video count, watch-time, or both. Grace 
  ("5 more minutes" or "finish this video" for example) when you hit your set limit.
- **Modes.** Switch between Watch (the weekly feed), Work (search-only,
  no sidebar, channel-click confirmation), and Listen (coming soon; a music listening mode).
- **Work session lock.** Optionally commit to a session length; bailing out
  requires typing an unlock code.
- **Watching lock.** Once you've started watching for the day, the Refresh and Daily
  Limit settings lock behind the same code-typing challenge so you can't
  impulsively raise the limit mid-binge.
- **Cross-device sync.** Settings, weekly grid, hidden items, watched videos,
  and progress all roam via `chrome.storage.sync`.
- **Free, open source, GPL-licensed.**

---

## Install

### From source (development)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome / Brave / Edge / any Chromium browser.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and choose this folder.
5. Open `youtube.com` — you should land on the weekly home grid (after the
   one-time mode picker and an initial recommendation scrape).

### From the Chrome Web Store

> Not yet published. See [CONTRIBUTING.md](CONTRIBUTING.md#publishing-to-the-chrome-web-store)
> for the publish flow used by maintainers.

---

## Usage

### Modes

The first time you load YouTube, BetterFeed asks which mode to enter:

| Mode    | What it does                                                         |
|---------|----------------------------------------------------------------------|
| Watch   | Static weekly home. The default; lets you watch videos.              |
| Work    | Search-only. Hides every grid, sidebar entry, and recommendation.    |
| Listen  | Coming soon. To have music recommendations so you can discover new music and no daily limit so that you can listen to music while you work. |

Switch modes anytime via the **mode switcher button** in the YouTube masthead next to your profile icon.

### Refresh schedule

Configured under **Settings → Refresh**:

- **Weekly.** One day per week.
- **Multiple days per week.** Pick any combination of days; refreshes at the same hour each day.
- **Daily.** A new grid every day.

On a refresh, the extension navigates the active YouTube tab to the vanilla
home page in the background, scrapes a fresh set of recommendations, and
returns to the custom URL (some version of: `youtube.com/feed/library#better-feed`) with the new grid stored. Until the next refresh, you will always be redirected to and stay on the custom URL, and NOT `youtube.com` so YouTube's algorithm doesn't get messed up.

### Daily limit

Configured under **Settings → Daily limit**. Three modes:

- **Videos.** Cap by number of videos watched today.
- **Time.** Cap by total watch time (hours + minutes).
- **Both** (default). Whichever ceiling hits first ends the day.

When you hit the limit BetterFeed shows a "see you tomorrow" takeover.
A popup offers two graces: **5 more minutes** or **finish this video**.

### Hidden items

Click the x on a video card or the **Hide channel** menu item to suppress
videos / channels from future grids. Restore them from the popup
(toolbar icon) or **Settings → Hidden videos**.

### Work session lock

Starting a Work session optionally commits you for a fixed duration
(20 min minimum) or open-ended ("no time"). Until the lock window closes,
bailing back to Watch mode requires typing a fresh 16–20 digit code shown
on screen. There is no paste / copy / autofill — friction is the point.

### Watching lock

Once you've watched even one second today, the **Refresh schedule** and
**Daily limit** sections in Settings lock. Editing them re-opens the same
code-typing modal. Same theme as the work-session lock — designed to
prevent the "let me just bump the limit" loophole.

---

## Permissions

| Permission                | Why                                                                   |
|---------------------------|-----------------------------------------------------------------------|
| `storage`                 | Persist settings, the weekly grid, hidden lists, watched videos.      |
| `declarativeNetRequest`   | Redirect `youtube.com/` to the marker URL where the grid is rendered. |
| `alarms`                  | A 5-minute timer that re-checks whether a refresh is now due.         |
| `*://www.youtube.com/*`   | The only host the content scripts and redirect rule touch.            |

The extension does **not** make calls to any backend other than
`youtube.com/oembed` (a public YouTube endpoint used to recover video
titles + channel names from bare IDs after a reinstall).

---

## Storage model

Two storage areas:

- **`chrome.storage.local`** (per-device) — full state: settings, weekly
  grid, hidden lists, watched videos, per-video playback progress,
  daily-state counters, work session, mode, and the fake-time debug offset.
- **`chrome.storage.sync`** (cross-device) — a slim subset: settings, the
  weekly grid as ID-only, hidden lists, watched videos, and per-video
  positions. Other devices rebuild missing metadata via YouTube's oEmbed
  endpoint.

When sync changes, [`applySyncChangeToLocal`](shared.js) reconciles the
two using a "newer wins for settings / refresh-grid, set-union for hidden
and watched lists, max-position wins for progress" strategy.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data flow.

---

## Project layout

```
manifest.json    Chrome MV3 manifest. Lists permissions, content scripts,
                 the service worker, the popup, the options page, and the
                 web-accessible welcome page.

background.js    Service worker. Owns the dNR redirect rule and the
                 5-minute refresh-check alarm.

early.js +       Runs at document_start. Adds mode classes to <html> so
preload.css      preload.css can hide the native home / sidebar / app shell
                 before YouTube paints.

shared.js        Constants, settings schema, storage helpers, sync logic.
                 Loaded by every other script.

content.js       The big one. Everything users see on a YouTube tab:
                 the weekly grid, mode picker, daily limit, work sessions,
                 channel-click confirmation. See its top-of-file header for
                 the section index.

options.html +   The full-tab options page (Refresh, Cleanup, Daily limit,
options.js       Hidden, Advanced, Debug).

popup.html +     The toolbar popup. Two buttons: Settings, Hidden Items.
popup.js

welcome.html +   Shown once on first install. Hero + before/after images +
welcome.js       feature list + CTA.

pictures/        Welcome-page screenshots and icons.
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, debug tools, code
organization, and the Chrome Web Store publish flow.

Architecture details (storage model, the refresh pipeline, the mode +
session state machines) live in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## License

BetterFeed is licensed under the **GNU General Public License v3.0 or later**.
See `LICENSE` for the full text. Anyone is free to use, modify, and
redistribute it under the same terms.
