// Talking to a tab, and surviving the tab navigating out from under you.
//
// Both of this extension's features hit the same three problems, so they are
// solved once here:
//
//   1. A content script has to be injected before it can be messaged, but
//      injecting twice must be harmless. Both scripts guard themselves with a
//      `window.__starling*` check, so this module just always injects.
//   2. Injection is refused on chrome:// pages, the Web Store, PDFs and
//      about:blank. That refusal is normal and needs a readable message, not
//      a stack trace.
//   3. The agent's whole purpose is to navigate, which destroys the content
//      script mid-conversation. Every step therefore re-injects and waits for
//      the new document rather than assuming the old one is still there.

/** Pages Chrome will not let any extension script run on. Worth naming
 *  explicitly: the failure is otherwise a bare "Cannot access contents of the
 *  page", which reads as a bug in the extension rather than a browser rule. */
const BLOCKED = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):|^https:\/\/chrome\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/;

export class TabError extends Error {}

export function checkInjectable(url) {
  if (!url) throw new TabError("This tab has no address yet. Load a page first.");
  if (BLOCKED.test(url)) {
    throw new TabError(
      "Chrome does not allow extensions to run on this page. Open an ordinary http(s) site and try again.",
    );
  }
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new TabError("No active tab.");
  return tab;
}

/** Inject a content script, idempotently. */
export async function inject(tabId, file) {
  const tab = await chrome.tabs.get(tabId);
  checkInjectable(tab.url);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  } catch (err) {
    throw new TabError(`Could not run Starling on this page: ${err.message}`);
  }
  return tab;
}

/** Send a message and get a reply, with the disconnect cases named.
 *
 *  `chrome.tabs.sendMessage` rejects with "Receiving end does not exist" for
 *  three quite different situations -- not injected, injected then navigated
 *  away, or the listener threw. Only the middle one is expected during agent
 *  work, and the caller handles it by re-injecting, so it is worth
 *  distinguishing here rather than at every call site.
 */
export async function send(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response === undefined) {
      throw new TabError("The page did not answer. It may have navigated.");
    }
    return response;
  } catch (err) {
    if (err instanceof TabError) throw err;
    throw new TabError(err.message || String(err));
  }
}

/** Inject then message, which is what almost every caller actually wants. */
export async function call(tabId, file, message) {
  await inject(tabId, file);
  return send(tabId, message);
}

/** Resolve once the tab has finished loading whatever it is loading.
 *
 *  Both halves matter. A click that starts a navigation leaves the tab
 *  "loading" and the old content script already dead, so messaging it races;
 *  a click that only ran some JavaScript never changes status at all, so
 *  waiting unconditionally would hang. Hence: settle quickly if nothing is
 *  loading, wait properly if something is.
 */
export function waitForLoad(tabId, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(reason);
    };

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish("loaded");
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    // A navigation is not always underway by the time we are asked to wait,
    // so poll the status once after a beat rather than trusting the first
    // read. Without the delay, a click that DOES navigate is regularly still
    // reported "complete" from the previous document.
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") finish("idle");
      } catch {
        finish("gone");
      }
    }, 250);
  });
}
