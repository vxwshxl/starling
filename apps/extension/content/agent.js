// The agent's hands and eyes, in the page.
//
// Two jobs, and the split between them is the safety property of the whole
// design:
//
//   index()    numbers every interactive element it can actually see and
//              hands the list to the model
//   execute()  performs one action against one of THOSE numbers
//
// The model never writes a selector. It picks a number out of a list this
// script produced, and `execute` resolves that number through a map this
// script owns. A hallucinated reference therefore fails here, visibly, with
// "e47 is no longer on the page" -- rather than matching something plausible
// and clicking the wrong button. The service rejects unknown refs too
// (agent.py's `validate`), so it takes two independent failures to touch an
// element nobody listed.

(() => {
  if (window.__starlingAgent) return;

  const OVERLAY_ID = "starling-agent-overlay";
  const OWN_MARKER = "data-starling-ui";

  /** Elements a person can act on. Roles are included because half the
   *  buttons on a modern page are <div role="button">. */
  const INTERACTIVE = [
    "a[href]", "button", "input", "select", "textarea", "summary", "label[for]",
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]',
    '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
    "[onclick]", '[contenteditable=""]', '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  const state = {
    refs: new Map(), // "e12" -> Element
    counter: 0,
  };

  // ---------------------------------------------------------------------
  // Seeing
  // ---------------------------------------------------------------------

  function isVisible(element) {
    if (!element.isConnected) return false;
    if (element.closest(`[${OWN_MARKER}]`)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    // checkVisibility catches the cases a rect cannot: visibility:hidden,
    // content-visibility, and an ancestor with display:none that still
    // reports a rect in some engines. Chrome 105+, and the manifest floors
    // us at 116.
    if (element.checkVisibility && !element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    })) return false;
    // Entirely off to one side. Elements below the fold are kept -- the agent
    // is allowed to scroll to them -- but a carousel slide parked at
    // left:-9999px is not something the user can be shown.
    if (rect.right < 0 || rect.left > (window.innerWidth || 0)) return false;
    return true;
  }

  /** What to call this element, in the order a person would read it. */
  function accessibleName(element) {
    const candidates = [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("alt"),
      // aria-labelledby points at other elements; resolve it rather than
      // reporting the raw id list, which means nothing to the model.
      element
        .getAttribute?.("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" "),
      element.labels?.length ? [...element.labels].map((l) => l.innerText).join(" ") : null,
      // Not for <select>: its innerText is the concatenation of every option,
      // so an unlabelled dropdown came back named "Assam Nagaland" -- which
      // reads to the model like a control that is already set to both.
      // The options are reported separately in `entry.options` regardless.
      element.tagName === "SELECT" ? null : element.innerText,
      element.value,
      element.getAttribute?.("title"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("name"),
    ];
    for (const candidate of candidates) {
      const text = (candidate || "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 140);
    }
    return "";
  }

  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox" || type === "radio") return type;
      return `input:${type}`;
    }
    if (tag === "textarea") return "input:text";
    if (tag === "select") return "select";
    if (tag === "summary") return "expander";
    return tag;
  }

  /** A short extract of the page's own prose, so the agent can answer a
   *  question the page already answers instead of clicking around to find it. */
  function pageText() {
    const main = document.querySelector("main, article, [role=main]") || document.body;
    return (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
  }

  function index() {
    state.refs.clear();
    state.counter = 0;

    const height = window.innerHeight || 800;
    const found = [];
    for (const element of document.querySelectorAll(INTERACTIVE)) {
      if (!isVisible(element)) continue;
      const name = accessibleName(element);
      const role = roleOf(element);
      // A nameless element is unusable: the model has nothing to choose it by
      // and could only pick it at random. Icon-only buttons that carry no
      // aria-label genuinely are inaccessible, and pretending otherwise makes
      // the agent click things it does not understand.
      if (!name && role !== "input:text" && role !== "select") continue;

      const rect = element.getBoundingClientRect();
      found.push({ element, name, role, rect });
    }

    // Reading order: what is on screen first, then down the page. This is the
    // order agent.py truncates at MAX_ELEMENTS, so it decides what the model
    // gets to see at all on a long page.
    found.sort((a, b) => {
      const aOn = a.rect.bottom > 0 && a.rect.top < height ? 0 : 1;
      const bOn = b.rect.bottom > 0 && b.rect.top < height ? 0 : 1;
      return aOn - bOn || a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });

    const elements = found.map(({ element, name, role }) => {
      const ref = `e${++state.counter}`;
      state.refs.set(ref, element);
      const entry = { ref, role, name, tag: element.tagName.toLowerCase() };
      if (element.tagName === "SELECT") {
        entry.options = [...element.options].slice(0, 20).map((o) => o.text.trim());
        entry.value = element.value;
      } else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        const type = (element.type || "text").toLowerCase();
        // Never report the contents of a password field, not even to a model
        // running on this machine. There is no goal that needs it.
        if (type !== "password" && element.value) entry.value = element.value.slice(0, 80);
        if (element.placeholder) entry.placeholder = element.placeholder;
        if (type === "checkbox" || type === "radio") entry.checked = element.checked;
      }
      return entry;
    });

    return {
      url: location.href,
      title: document.title,
      elements,
      text: pageText(),
      scroll: {
        y: Math.round(window.scrollY),
        height: Math.round(document.documentElement.scrollHeight),
        atBottom:
          window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    // Marked as ours so the translation walker and the element index both
    // skip it. Without that, the agent can see and click its own highlight.
    overlay.setAttribute(OWN_MARKER, "");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "pointer-events:none", "z-index:2147483647",
    ].join(";");
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  /** Draw a ring around what the agent is about to touch.
   *
   *  Not decoration. An agent that acts invisibly is one you cannot supervise:
   *  when it clicks the wrong thing you need to see WHICH wrong thing, at the
   *  moment it happens, not infer it afterwards from a changed page. */
  function highlight(element, label) {
    const rect = element.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.setAttribute(OWN_MARKER, "");
    ring.style.cssText = [
      "position:absolute",
      `top:${rect.top - 4}px`, `left:${rect.left - 4}px`,
      `width:${rect.width + 8}px`, `height:${rect.height + 8}px`,
      "border:2px solid #5a45ad",
      "border-radius:6px",
      "box-shadow:0 0 0 3px rgba(90,69,173,.22)",
      "transition:opacity .5s ease .7s",
    ].join(";");
    if (label) {
      const tag = document.createElement("span");
      tag.textContent = label;
      tag.style.cssText = [
        "position:absolute", "top:-20px", "left:-2px",
        "font:600 11px/1.5 ui-sans-serif,system-ui,sans-serif",
        "background:#5a45ad", "color:#fff", "padding:0 6px",
        "border-radius:4px", "white-space:nowrap",
      ].join(";");
      ring.appendChild(tag);
    }
    ensureOverlay().appendChild(ring);
    requestAnimationFrame(() => { ring.style.opacity = "0"; });
    setTimeout(() => ring.remove(), 1600);
  }

  /** Set a field's value so a framework notices, or say why it cannot. */
  function setValue(element, value) {
    // Pick the prototype by what the element ACTUALLY is. The old version
    // assumed anything that was not a <textarea> was an <input>, so when the
    // model chose `type` on a button -- which Qwen2.5-3B does often -- the
    // input setter was invoked on a button and threw "Illegal invocation",
    // a message that says nothing about the real mistake. The service now
    // rejects `type` on a non-typable role before it reaches here, and this
    // stays as the second line of defence with an error worth reading.
    let prototype = null;
    if (element instanceof HTMLTextAreaElement) prototype = HTMLTextAreaElement.prototype;
    else if (element instanceof HTMLInputElement) prototype = HTMLInputElement.prototype;
    else if (element instanceof HTMLSelectElement) prototype = HTMLSelectElement.prototype;

    if (!prototype) {
      throw new Error(
        `${element.tagName.toLowerCase()} is not a text field — it cannot be typed into. ` +
        "Click it instead.",
      );
    }

    // Assigning `element.value` directly is invisible to React: it tracks the
    // last value it wrote and, seeing no change through its own setter,
    // discards the input event and restores the old value on the next render.
    // Going through the prototype's setter is the standard way around it, and
    // without this every "type into the search box" step silently does
    // nothing on roughly half the web.
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(element) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      element.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }),
      );
    }
    // Some forms listen for submit rather than for Enter. requestSubmit runs
    // validation and fires the submit event, which form.submit() skips.
    const form = element.form;
    if (form && typeof form.requestSubmit === "function") {
      try { form.requestSubmit(); } catch { /* a validation failure is the page's answer */ }
    }
  }

  function resolve(ref) {
    const element = state.refs.get(ref);
    if (!element) {
      throw new Error(`${ref} is not in the current index — the page changed under the agent.`);
    }
    if (!element.isConnected) {
      throw new Error(`${ref} is no longer on the page.`);
    }
    return element;
  }

  async function execute(action, args = {}) {
    const before = { url: location.href, y: window.scrollY };

    switch (action) {
      case "click": {
        const element = resolve(args.ref);
        const label = accessibleName(element);
        element.scrollIntoView({ block: "center", behavior: "instant" });
        highlight(element, `click ${args.ref}`);
        element.click();
        return { ok: true, label, before };
      }

      case "type": {
        const element = resolve(args.ref);
        const label = accessibleName(element);
        element.scrollIntoView({ block: "center", behavior: "instant" });
        highlight(element, `type ${args.ref}`);
        element.focus();
        if (element.isContentEditable) {
          element.textContent = args.text;
          element.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          setValue(element, args.text);
        }
        if (args.submit) pressEnter(element);
        return { ok: true, label, before };
      }

      case "select": {
        const element = resolve(args.ref);
        highlight(element, `select ${args.ref}`);
        const wanted = String(args.value).toLowerCase();
        // Match on the visible text first: the model was shown option labels,
        // not the underlying values, so that is what it will have named.
        const option = [...element.options].find(
          (o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted,
        ) || [...element.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
        if (!option) {
          const available = [...element.options].map((o) => o.text.trim()).join(", ");
          throw new Error(`No option matching "${args.value}". Available: ${available}`);
        }
        element.value = option.value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, label: option.text.trim(), before };
      }

      case "scroll": {
        const step = Math.round((window.innerHeight || 800) * 0.85);
        const targets = {
          down: { top: window.scrollY + step },
          up: { top: Math.max(0, window.scrollY - step) },
          top: { top: 0 },
          bottom: { top: document.documentElement.scrollHeight },
        };
        window.scrollTo({ ...targets[args.direction], behavior: "instant" });
        return { ok: true, label: args.direction, before };
      }

      case "back":
        history.back();
        return { ok: true, label: "back", before };

      case "navigate":
        location.href = args.url;
        return { ok: true, label: args.url, before };

      default:
        throw new Error(`The page cannot perform "${action}".`);
    }
  }

  /** What changed as a result. The agent's next prompt gets this, and it is
   *  what stops the loop repeating an action that did nothing. */
  function observeOutcome(before) {
    if (location.href !== before.url) return "the page navigated";
    if (Math.abs(window.scrollY - before.y) > 20) return "the page scrolled";
    return "ok";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("sl:")) return undefined;

    if (message.type === "sl:agent-ping") {
      sendResponse({ ok: true, script: "agent" });
      return false;
    }

    if (message.type === "sl:index") {
      try {
        sendResponse({ ok: true, ...index() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return false;
    }

    if (message.type === "sl:execute") {
      // Async, so the listener must return true to keep the channel open.
      // Returning false here would close it and the panel would see
      // "message port closed before a response was received" on every step.
      (async () => {
        try {
          const result = await execute(message.action, message.args);
          // Give the page a moment to react before reporting what changed --
          // a click that triggers a fetch has not navigated yet at the
          // instant it returns.
          await new Promise((r) => setTimeout(r, 350));
          sendResponse({ ...result, outcome: observeOutcome(result.before) });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
      })();
      return true;
    }

    return undefined;
  });

  window.__starlingAgent = { index, execute, state };
})();
