// =============================================================================
// welcome.js - wiring for the post-install welcome.html tab.
//
// Two buttons:
//   - Open settings    : opens the full options page.
//   - Got it, take me to YouTube : navigates this tab to youtube.com (so the
//                                  redirect rule then carries the user onto
//                                  the weekly home).
// =============================================================================

document.getElementById("open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("close-tab").addEventListener("click", async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      chrome.tabs.update(tab.id, { url: "https://www.youtube.com/" });
      return;
    }
  } catch (_) {}
  window.location.href = "https://www.youtube.com/";
});
