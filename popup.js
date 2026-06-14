// =============================================================================
// popup.js - toolbar popup (opens from the BetterFeed extension icon).
//
// Two top-level buttons:
//   - Settings   : opens the full options page in a new tab.
//   - Hidden Items : toggles a view of the hidden videos/channels list within
//                    the popup, with per-item Restore and a Restore All button.
//
// Video metadata that came back from sync as bare IDs (post-reinstall case)
// is rebuilt via YouTube's oEmbed endpoint and persisted to the metadata
// map, so the popup keeps showing real titles after the refresh cycle.
// =============================================================================

// showStatus lives in shared.js (shared with options.js).

function showContent(contentId) {
  document.querySelectorAll(".content").forEach(el => {
    el.classList.remove("active");
  });

  const content = document.getElementById(contentId);
  if (content) {
    content.classList.add("active");
  }
}

function buildHiddenItemRow({ type, id, badgeText, badgeClass, displayText }) {
  const item = document.createElement("div");
  item.className = "better-feed-hidden-item";

  const content = document.createElement("div");
  content.className = "better-feed-hidden-item-content";

  const badge = document.createElement("span");
  badge.className = `better-feed-hidden-item-badge${badgeClass ? ` ${badgeClass}` : ""}`;
  badge.textContent = badgeText;

  const text = document.createElement("span");
  text.className = "better-feed-hidden-item-text";
  text.textContent = displayText;

  content.appendChild(badge);
  content.appendChild(text);

  const button = document.createElement("button");
  button.className = "better-feed-restore-btn";
  button.dataset.type = type;
  button.dataset.id = id;
  button.textContent = "Restore";

  item.appendChild(content);
  item.appendChild(button);

  return item;
}

// backfillMissingHiddenVideoMetadata lives in shared.js (one copy shared with
// options.js; this page passes loadHiddenItems as the onUpdated re-render).

// channelDisplayFromKey lives in shared.js (shared with options.js).

async function loadHiddenItems() {
  const hiddenData = await getHiddenItemsWithMetadata();
  const list = document.getElementById("hidden-list");
  if (!list) return;

  list.innerHTML = "";

  for (const videoId of hiddenData.videos) {
    const meta = hiddenData.metadata[videoId];
    const displayText = meta?.title
      ? `${meta.title}${meta.channelName ? ` • ${meta.channelName}` : ""}`
      : `Hidden video • ${videoId}`;

    list.appendChild(buildHiddenItemRow({
      type: "video",
      id: videoId,
      badgeText: "Video",
      displayText
    }));
  }

  for (const channelKey of hiddenData.channels) {
    const meta = hiddenData.metadata[channelKey];
    // channelDisplayFromKey (shared.js) owns the whole fallback chain -
    // handle / UC id / name:-key / URL path segment - so popup and options
    // label the same hidden channel identically.
    const displayName =
      meta?.channelName || channelDisplayFromKey(channelKey) || "Hidden channel";

    list.appendChild(buildHiddenItemRow({
      type: "channel",
      id: channelKey,
      badgeText: "Channel",
      badgeClass: "channel",
      displayText: displayName
    }));
  }

  // Fire-and-forget backfill of any entries missing metadata. loadHiddenItems
  // is re-invoked once results land.
  backfillMissingHiddenVideoMetadata(loadHiddenItems).catch(() => {});
}

async function unhideItem(type, id) {
  await modifyHidden(state => {
    if (type === "video") {
      state.videos.delete(id);
      delete state.metadata[id];
    } else if (type === "channel") {
      state.channels.delete(id);
      delete state.metadata[id];
    }
  });
  await loadHiddenItems();
  showStatus("Item restored!", true);
}

async function restoreAll() {
  if (!confirm("Restore all hidden videos and channels?")) return;

  await modifyHidden(state => {
    state.videos.clear();
    state.channels.clear();
    for (const k of Object.keys(state.metadata)) delete state.metadata[k];
  });
  await loadHiddenItems();
  showStatus("All items restored!", true);
}

document.getElementById("settings-menu-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById("hidden-menu-btn").addEventListener("click", () => {
  showContent("hidden-content");
  loadHiddenItems();
});

document.getElementById("restore-all-btn").addEventListener("click", restoreAll);

document.addEventListener("click", async event => {
  if (event.target.classList.contains("better-feed-restore-btn")) {
    const type = event.target.dataset.type;
    const id = event.target.dataset.id;
    await unhideItem(type, id);
  }
});

// Re-render the Hidden Items list if a sync hydrate (or any other context)
// changes the hidden keys while the popup is open and showing that view -
// otherwise a mid-open sync merge leaves a stale list until the user re-clicks.
// (Only the hide/unhide keys; the metadata backfill re-renders itself.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const hiddenContent = document.getElementById("hidden-content");
  if (!hiddenContent || !hiddenContent.classList.contains("active")) return;
  if (STORAGE_HIDDEN_VIDEOS_KEY in changes || STORAGE_HIDDEN_CHANNELS_KEY in changes) {
    loadHiddenItems();
  }
});

(async () => {
  // Best-effort: a sync-reconciliation failure shouldn't surface as an unhandled
  // rejection in the popup (matches the .catch() on the backfill call).
  try {
    await migrateLegacyStorageKeys();
    // Adopt any active Debug fake-clock BEFORE hydrating - hydrateFromSync's
    // daily-state merge resolves "today" via getNow(), and every other context
    // loads the offset at init. Without this, a popup opened during fake-time
    // testing merges daily state against the real clock.
    await loadFakeNowOffset();
    await hydrateFromSync();
  } catch (_) {}
})();

