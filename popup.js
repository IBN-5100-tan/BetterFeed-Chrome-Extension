// =============================================================================
// popup.js — toolbar popup (opens from the BetterFeed extension icon).
//
// Two top-level buttons:
//   - Settings   : opens the full options page in a new tab.
//   - Hidden Items : reveals the hidden-videos/channels list right in the
//                    popup, with per-item Restore and a Restore All button.
//
// Video metadata that came back from sync as bare IDs (post-reinstall case)
// is rebuilt via YouTube's oEmbed endpoint and persisted to the metadata
// map, so the popup keeps showing real titles after the refresh cycle.
// =============================================================================

function showStatus(message, isSuccess = true) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = message;
  status.className = `status show ${isSuccess ? "success" : "info"}`;

  setTimeout(() => {
    status.classList.remove("show");
  }, 2000);
}

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

// fetchVideoMetadataFromOEmbed + OEMBED_CONCURRENCY live in shared.js so
// the popup, options page, and content script all use the same fetcher.

async function backfillMissingHiddenVideoMetadata() {
  const { videos, metadata } = await getHiddenItemsWithMetadata();
  const existing = metadata || {};
  const missing = [...videos].filter(id => id && !existing[id]?.title);
  if (missing.length === 0) return;

  const fetched = {};
  for (let i = 0; i < missing.length; i += OEMBED_CONCURRENCY) {
    const batch = missing.slice(i, i + OEMBED_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchVideoMetadataFromOEmbed));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) fetched[batch[j]] = results[j];
    }
  }
  if (Object.keys(fetched).length === 0) return;

  await modifyHidden(state => {
    if (!state.metadata) state.metadata = {};
    for (const [id, m] of Object.entries(fetched)) {
      if (!state.metadata[id]?.title) state.metadata[id] = { type: "video", ...m };
    }
  });
  await loadHiddenItems();
}

function channelDisplayFromKey(key) {
  if (!key) return null;
  const handle = key.match(/@([^/?#&]+)/);
  if (handle) return `@${handle[1]}`;
  const ucId = key.match(/\/channel\/(UC[^/?#&]+)/i);
  if (ucId) return ucId[1];
  return null;
}

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
    const fallback = channelDisplayFromKey(channelKey);
    const displayName = meta?.channelName
      ? meta.channelName
      : fallback
        || (channelKey.startsWith("name:") ? channelKey.slice(5) : channelKey);

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
  backfillMissingHiddenVideoMetadata().catch(() => {});
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

(async () => {
  await migrateLegacyStorageKeys();
  await hydrateFromSync();
})();

