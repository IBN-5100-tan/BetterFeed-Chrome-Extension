# Contributing to BetterFeed

Thanks for the interest. This document covers everything you need to develop
on BetterFeed: load it in Chrome, find your way around the code, use the
built-in debug helpers, and (for maintainers) publish to the Chrome Web Store.

If you're new to the codebase, skim [README.md](README.md) first for what
the extension does, then [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces
fit together.

---

## Development setup

No build step, no Node, no install. The extension is plain JS + HTML + CSS,
loaded directly by Chrome.

1. Clone the repo.
2. Open `chrome://extensions` in any Chromium browser.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and choose this directory.
5. Pin the extension to your toolbar for quick access to the popup.

After any code change, click the **reload** icon on the BetterFeed card on
`chrome://extensions`, then refresh any open YouTube tabs. Service-worker
changes also need a reload of the worker (the same button covers it).

### Where to view logs

| Process            | DevTools                                                       |
|--------------------|----------------------------------------------------------------|
| content scripts    | Right-click youtube.com -> Inspect -> Console.                  |
| service worker     | `chrome://extensions` -> BetterFeed -> "service worker" link.   |
| options page       | Open settings tab -> right-click -> Inspect.                    |
| popup              | Right-click the popup -> Inspect (must keep it open).           |

---

## Debug tools (inside the extension)

The **Settings → Debug** page is the maintainer's toolkit:

- **Daily state readout.** Shows the day key, videos watched, time
  watched, and current grace. Auto-refreshes on storage changes.
- **Manual refresh.** Forces the next page load to scrape a fresh grid.
- **Force-add video.** Paste an ID / `youtu.be` / watch URL / shorts URL;
  the extension prepends a stub to the weekly grid and the content script
  fills in metadata via oEmbed on the next render.
- **Welcome page.** Reopens `welcome.html` (the first-install screen).
- **Fake current time.** Sets a global offset that `getNow()` applies to
  every timestamp. Use this to test weekly/multi/daily refresh flows
  without waiting a day. Apply, reload YouTube, observe the grid refresh;
  clear to return to real time.
- **Storage.**
  - *Reset daily limit* — clears `STORAGE_DAILY_STATE_KEY` +
    `STORAGE_DAILY_GRACE_KEY`.
  - *Clear local data* — `chrome.storage.local.clear()`. Sync survives
    and rehydrates back into local on the next page load.
  - *Clear sync data* — `chrome.storage.sync.clear()`. Propagates to
    every device on your sync chain. Local on this device is untouched.

### Useful console snippets

Inside a YouTube tab (content script context), all the `shared.js` helpers
are in scope:

```js
// What does the storage look like right now?
await chrome.storage.local.get(null);
await chrome.storage.sync.get(null);

// Inspect or change the active mode.
await getCurrentMode();
await setCurrentMode("watch");

// Inspect the current settings (sanitized).
await getSettings();

// Set a fake-time offset (10 minutes into the future).
await chrome.storage.local.set({
  [STORAGE_FAKE_NOW_OFFSET_KEY]: 10 * 60 * 1000
});

// Trigger a refresh on next load.
await chrome.storage.local.remove([STORAGE_VIDEOS_KEY, STORAGE_REFRESH_AFTER_KEY]);
```

---

## Code organization

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deep dive. The short version:

```
manifest.json    MV3 manifest.
background.js    Service worker (dNR redirect rule, refresh-due alarm).
early.js         Runs at document_start, applies <html> classes.
preload.css      Hides native YouTube shell before paint.
shared.js        Storage / settings / sync / getNow(). Loaded by everything.
content.js       Everything users see on a YouTube tab. ~6700 lines.
options.html/js  Full-tab settings page.
popup.html/js    Toolbar popup.
welcome.html/js  Post-install hero page.
pictures/        Welcome-page images and feature icons.
```

Each source file starts with a header comment explaining its role and listing
its sections. Inside `content.js`, search for `/* ---------- ` to jump
between sections.

### Style

- Plain ES2020. No Node, no bundling, no transpilation.
- All files share a global scope (no modules). Constants are uppercase
  snake_case; functions are camelCase.
- Two-space indent, double-quoted strings, semicolons.
- Comments only where the *why* is non-obvious. The code itself describes
  the *what*.
- When you add a new setting:
  1. Add it to `DEFAULT_SETTINGS` in `shared.js`.
  2. Validate it in `sanitizeSettings`.
  3. Add the form control to `options.html`, the load wiring to
     `options.js#loadSettings`, and the save wiring to `options.js#autoSave`.
  4. If it's user-visible behavior, wire it into `content.js` (most
     feature toggles map to a `BODY_CLASS_*` constant and a CSS rule in
     `injectFeatureStyle`).

---

## Testing changes

There's no automated test suite — UI surface area is large, and most bugs
show up only against the real YouTube DOM. Manual flows that cover most of
the surface:

1. **Fresh install.** Wipe local + sync, reload, walk through the cold-start
   flow, pick a mode, watch the first grid populate.
2. **Refresh schedule.** In Debug, set fake time past `refreshAfter`,
   reload a YouTube tab, confirm a new grid scrapes successfully.
3. **Mode picker.** Open a fresh YouTube tab, confirm the picker appears;
   pick each mode and confirm the UI matches.
4. **Work session.** Start a 20-minute session, attempt to switch back to
   Watch — confirm the unlock challenge appears. Wait out the timer
   (use fake time), confirm the session-ended popup appears.
5. **Daily limit.** Set the limit to 1 video / 1 minute. Watch one,
   confirm the see-you-tomorrow takeover, try both grace flows.
6. **Watching lock.** Watch any amount today, then open Settings.
   Confirm Refresh and Daily-limit sections are locked. Type the code,
   confirm unlock.
7. **Cross-device.** With sync set up, install on a second profile and
   confirm settings + grid + hidden items + watched flags arrive.
8. **Disable + enable.** Toggle the extension on/off; confirm the
   redirect rule installs/removes and the grid disappears/reappears.

---

## Publishing to the Chrome Web Store

> Maintainers only. Skip this section if you're submitting a PR.

### The `key` field in manifest.json

The `key` field in `manifest.json` pins the extension ID. **Do not change
or remove it.** It's what makes unpacked development installs share the
same ID as the Web Store version, so:

- Sync data stays attached when you swap between dev and store builds.
- The Web Store accepts a fresh upload as an update to the existing
  listing rather than rejecting it as a different extension.

The Web Store signs uploads server-side, so there is no local `.pem`
signing key to safeguard. If you ever need to self-distribute a `.crx`
file outside the Store, you can generate a new key via Chrome's "Pack
extension" dialog at `chrome://extensions`, but that's not part of the
normal release path. `.gitignore` keeps `*.pem` excluded as a defensive
guard in case anyone ever does generate one locally.

### Packaging

1. Bump `version` in `manifest.json`.
2. Zip the extension:

   ```sh
   zip -r betterfeed.zip . -x "*.pem" "*.git*" "*.DS_Store" "*.zip" "*.crx" "*.md" "CONTRIBUTING*"
   ```

3. Upload `betterfeed.zip` to the Chrome Web Store developer dashboard.
4. Submit for review.

---

## Filing issues

Useful info to include:

- Browser + version (Chrome/Brave/Edge, exact build).
- BetterFeed version (from `chrome://extensions`).
- Mode you were in when the issue happened (Watch / Work / Listen).
- Whether the issue reproduces with sync disabled.
- Steps to reproduce, ideally starting from a fresh `Clear local data`.
- Console output from the relevant DevTools context (content script /
  service worker / options page).

For YouTube-DOM-related bugs (something stopped hiding, a scrape is
returning zero videos), YouTube redesigns are the most common cause —
include a screenshot of the broken element with DevTools open to its
selectors so the fix is just an update to the selector list at the top
of `content.js`.

---

## License

By contributing, you agree your contributions are licensed under the
**GNU General Public License v3.0 or later**, the same terms as the rest
of the project.
