# Privacy Policy

_Last updated: 2026-06-11_

BetterFeed is a Chrome extension that replaces YouTube's algorithmic home
page with a static weekly grid. This document describes exactly what data
the extension stores, where it goes, and what it does not do. The source
code is open and GPL-licensed - every claim below can be verified by
reading the source.

---

## What the extension stores on your device

All of the following live in `chrome.storage.local` on the device where
BetterFeed is installed:

- **Settings.** Your refresh schedule, daily-limit configuration, mode,
  and the toggles for each cleanup option (hide Shorts, hide comments,
  etc.).
- **Weekly grid.** The set of YouTube video IDs and the metadata
  (title, channel, duration, view count, publish date, thumbnail URL,
  channel avatar URL) for the current week's home page.
- **Hidden items.** Video IDs and channel URLs you've chosen to hide,
  plus a local cache of their titles and channel names.
- **Watched videos.** A list of video IDs from the current week's grid
  that you've finished watching.
- **Per-video playback progress.** Position and duration for each
  video in the current week's grid, used to render the progress bar.
- **Daily watch state.** Today's date key, the list of video IDs you've
  started today, and the seconds watched today (tracked per device - see
  the device identifier below).
- **Device identifier.** A random ID (e.g. `dev-a1b2c3…`) generated once
  per install. It exists only so each device's watch-seconds can be kept
  in its own bucket when the daily state is merged across devices; it is
  random, local, and not derived from or linked to your identity,
  hardware, or Google account.
- **Active grace.** Any "5 more minutes" or "finish this video"
  override you've granted yourself after the daily limit.
- **Work session state.** The start time and end time (or "no time"
  flag) of your current Work session, when one is active.
- **Debug fake-time offset.** Zero unless you set it manually via the
  Debug page; lets you test refresh schedules without waiting.

The extension also writes the active mode (`watch`, `work`, or `listen`)
and the list of currently-active cleanup-styling classes to the page's
`localStorage`, so mode- and cleanup-specific styling can be applied
synchronously at page load (this is what prevents YouTube's native UI
from flashing before the extension's UI takes over).

---

## What is synced across your devices

If you have Chrome sync enabled and signed in with a Google account,
the following subset is mirrored to `chrome.storage.sync`, which Google
syncs across your signed-in browsers:

- Settings (sanitized).
- The weekly grid - **as bare video IDs only**. Titles, channel names,
  thumbnails, and other metadata are rebuilt on each device by
  re-fetching from YouTube (see below).
- Hidden video IDs and hidden channel keys (each capped at the most
  recent 200 / 100 entries).
- The watched-video set for the current week (capped at the most
  recent 200 entries).
- Per-video playback position (just the position number per ID;
  duration is recovered locally).
- The next-refresh timestamp.
- Daily watch state - today's date key, the video IDs started today,
  and the seconds watched today keyed by each device's random
  identifier. This is synced so the daily limit applies across your
  devices (watching on a second computer can't bypass it). The device
  identifier is random and carries no personal information.

Cross-device sync goes through your own Google account. The BetterFeed
project never sees this data.

Mode, work-session, daily grace, the hidden-item title/channel cache,
and the debug fake-time offset are **not** synced - they stay on the
device that wrote them.

---

## Network requests the extension makes

BetterFeed only contacts YouTube. All requests are to `youtube.com`
(and its CDN `i.ytimg.com` for thumbnail images), made from your
browser, with no proxy or middleman:

- **`youtube.com/oembed`** - public metadata endpoint. Used after a
  cross-device sync (which carries only video IDs) to recover titles
  and channel names for hidden items and weekly-grid videos.
- **`youtube.com/watch?v=<id>`** - fetched anonymously (cookies omitted) from
  the active YouTube tab's content script to fill in duration, view count,
  publish date, and the live-stream flag for videos that are missing them:
  after a cross-device sync hydration, after a manual add via the Debug page,
  and on page init for any stub entries. The streaming-pass implementation
  reads only the first ~256 KB and cancels.
- **Channel page URLs** (e.g. `youtube.com/@channelname`) - fetched the same
  way (anonymously, from the content script) to extract the channel avatar
  from the page's `og:image` tag.
- **Thumbnail images on `i.ytimg.com`** - loaded as normal `<img>`
  tags when the weekly grid renders.
- **A background request to `youtube.com/`** - when a refresh is due, the
  extension's background script fetches the real YouTube home page (with
  your logged-in cookies, same as a normal visit) and reads the
  recommendations from the JSON the page already embeds. No tab is
  navigated; nothing is sent anywhere.

These are the same hosts your browser already talks to whenever you
use YouTube. The extension does not contact any other server, and it
does not send any data to a server operated by the BetterFeed project,
because there is no such server.

---

## What BetterFeed does not do

- **No analytics, no telemetry, no crash reporting.** The extension
  has no remote logging endpoint and never reports usage data to anyone.
- **No third-party services.** No CDN scripts, ad networks, A/B testing
  services, or external SDKs are loaded.
- **No personal information collected.** The extension never asks for
  or stores an email address, name, account identifier, IP address,
  precise location, payment data, or contact list.
- **No tracking of your YouTube account.** It does not read your
  YouTube account, your subscriptions, your watch history, or your
  recommendations beyond the home-page recommendations it reads during
  a refresh.
- **No sale or sharing of data with third parties.** There is no data
  to sell, and the project has no business relationships through which
  to share it.

---

## How you can clear your data

The Debug page hosts the data-clearing tools. It's a support surface,
so its tab is hidden by default - open the extension's options page and
add `#debug` to the end of the URL to reveal it.

- **Debug → Clear local data** wipes everything BetterFeed has stored
  on this device. (Sync data survives and will rehydrate into local on
  the next page load.)
- **Debug → Clear sync data** wipes the subset that's synced to your
  Google account. This propagates to every device on your Chrome sync
  chain. Local data on the device you click from is untouched.
- **Uninstalling the extension** removes everything in
  `chrome.storage.local` for the extension. The `chrome.storage.sync`
  data persists on Google's servers until you also clear it via the
  Debug page or until you remove the extension across all your synced
  devices.

You can also clear individual items: remove a hidden video or channel
from the popup's Hidden Items list, or from the Hidden videos page in
Settings.

---

## Permissions the extension requests

| Permission                | Why                                                                |
|---------------------------|--------------------------------------------------------------------|
| `storage`                 | To persist settings, the weekly grid, hidden lists, watched videos, and per-video progress. |
| `declarativeNetRequest`   | To redirect `youtube.com/` to the marker URL where the custom home is rendered. The rule is local; no traffic is logged or sent anywhere. |
| `alarms`                  | A 5-minute timer that re-checks whether a refresh is now due.      |
| `*://www.youtube.com/*`   | The only host the content scripts and redirect rule touch.         |

---

## Changes to this policy

Material changes to what the extension stores or fetches will be
reflected here, with a new "Last updated" date. The history is visible
in the project's Git log.

---

## Questions

BetterFeed is open source. The full source code is in this repository.
If you find a discrepancy between this document and the code, please
open an issue.

License: GNU General Public License v3.0 or later (see [LICENSE](LICENSE)).
