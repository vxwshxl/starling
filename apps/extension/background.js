// Service worker. Deliberately almost empty.
//
// The obvious place to run the agent loop is here, and that is a trap: an MV3
// service worker is killed after ~30 seconds idle, and the loop spends most of
// its time waiting -- for a page to finish loading, for the model to think.
// A killed worker takes the loop's state with it and the agent stops
// mid-task, which during a demo looks like the model gave up.
//
// So the loop lives in the side panel instead (sidepanel/panel.js). A panel is
// an ordinary extension page: it has the same chrome.scripting and
// chrome.tabs access, it can fetch the loopback service, and it stays alive
// for exactly as long as it is open -- which is exactly as long as the user is
// watching the agent work. This file only does the two things a panel cannot:
// react to the toolbar button, and own the context menu.

const PANEL_PATH = "sidepanel/index.html";

// Clicking the toolbar icon opens the panel. This is the documented way to do
// it without an onClicked handler, and it must be set at the top level rather
// than inside an event -- the worker is restarted often and the setting has to
// be reapplied each time it wakes.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[starling] could not set panel behaviour", err));

const MENU_TRANSLATE = "starling-translate-page";

function installMenu() {
  // removeAll first: onInstalled fires again on every reload of an unpacked
  // extension, and creating a duplicate id throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE,
      title: "Translate this page with Starling",
      contexts: ["page", "selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(installMenu);
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_TRANSLATE || !tab?.id) return;
  // Open the panel first. This call must happen synchronously inside the user
  // gesture -- awaiting anything before it makes Chrome reject it as not
  // user-initiated, with an error that reads as a permissions problem.
  chrome.sidePanel.open({ tabId: tab.id });
  // The panel may still be booting, so the request is left in storage rather
  // than sent as a message to a listener that does not exist yet. The panel
  // picks it up when it is ready and clears it.
  await chrome.storage.session.set({
    pendingRequest: { kind: "translate", tabId: tab.id, at: Date.now() },
  });
});
