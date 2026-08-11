// Page translation, in the page.
//
// This script never talks to the network. It cannot: a content script's fetch
// carries the PAGE's origin, so a call to the loopback service would be
// blocked by CORS and there is no widening that fixes it without also opening
// the service to every site you visit. So the division of labour is:
//
//   this script   finds the text, decides what order to translate it in,
//                 and writes the results back
//   the panel     does the fetching
//
// Messages carry plain {id, text} pairs both ways. The DOM nodes themselves
// stay here, in `state.items`, indexed by id -- which is also what makes
// restore possible, and what makes a mis-ordered reply impossible to apply.
//
// The ordering is the thing that makes this feel fast. A 4B translation model
// on this machine cannot do three hundred segments in seconds, and no amount
// of engineering here changes that. What it can do is the forty segments the
// user is actually looking at. So segments are sorted by where they are
// relative to the viewport, sent in small chunks, and written back as each
// chunk lands: the first screen finishes in seconds and the rest arrives
// while the user reads it.

(() => {
  // Injected with chrome.scripting.executeScript, which happily runs the file
  // again on a second press. Re-running would rebind everything and lose the
  // originals, so the second run is a no-op that keeps the first run's state.
  if (window.__starlingTranslate) return;

  /** Text inside these is not prose and translating it breaks the page. */
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP",
    "VAR", "TEXTAREA", "SVG", "MATH", "CANVAS", "IFRAME", "OBJECT", "EMBED",
  ]);

  /** Inline elements that only change how text looks, never what it is.
   *
   *  These are absorbed into the surrounding sentence rather than splitting
   *  it, and that matters more than it sounds. One text node per DOM text
   *  node turns "The scheme funds <em>infrastructure</em> projects across
   *  the eight states" into three independent segments, and translating
   *  three fragments separately into Assamese produces word salad --
   *  Assamese is verb-final, so the pieces have to be reordered against each
   *  other and a fragment translated alone cannot know that.
   *
   *  <a> is deliberately NOT here. Absorbing a link would mean writing the
   *  whole translated sentence into one node and blanking the rest, which
   *  destroys the link text. A sentence containing a link is still split at
   *  the link; that is the remaining known limitation of this approach.
   */
  const FORMATTING_TAGS = new Set([
    "B", "I", "EM", "STRONG", "SPAN", "U", "SMALL", "MARK", "ABBR", "CITE",
    "DFN", "SUB", "SUP", "TIME", "BDI", "BDO", "FONT", "S", "INS", "DEL", "Q",
  ]);

  /** Attributes worth translating. Between them these cover the text a
   *  screen reader reads and the text a form shows before you type -- which
   *  on a government services site is most of the text that matters. */
  const ATTRS = ["placeholder", "title", "alt", "aria-label"];

  /** …plus the label on a button that is an <input>, where the label lives in
   *  `value` rather than in a child text node. */
  const VALUE_INPUTS = new Set(["submit", "button", "reset"]);

  const OWN_MARKER = "data-starling-ui";

  const state = {
    items: [],          // {id, node, kind, attr, lead, trail, source, applied}
    byId: new Map(),
    nextId: 1,
    seen: new WeakSet(), // text nodes already collected, so re-collect is cheap
    active: false,
    target: null,
    observer: null,     // MutationObserver, for content the page adds later
    viewport: null,     // IntersectionObserver, for content further down
    deferred: new Map(),// element -> [item], waiting to be scrolled near
    pending: [],        // ids to report to the panel, not yet sent
    notifyTimer: null,
  };

  /** How much of the page is translated before the user does anything.
   *
   *  This is THE speed dial, and it is not the model's speed -- that is fixed
   *  at roughly 2.4 segments a second. A 160-segment page translated in one
   *  pass is about a minute of waiting; the same page with only what is on
   *  screen plus one screen of runway is nine seconds, and the rest arrives
   *  as it is scrolled to.
   *
   *  It also removes the reason the old behaviour felt broken. Sending every
   *  segment at once meant the bottom of the page sat in English for a whole
   *  minute while the progress bar claimed to be working, so scrolling during
   *  a run looked like the translation had quietly given up. Now scrolling is
   *  what causes the work, and it happens where the user is looking. */
  const RUNWAY = 1.5; // screens below the fold translated up front

  // ---------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------

  function isSkippable(element) {
    if (!element) return true;
    if (element.closest(`[${OWN_MARKER}]`)) return true;
    // Honour the web's own opt-out. Google Translate reads the same two, so
    // sites that have already marked their brand names are marked for us too.
    if (element.closest('[translate="no"], .notranslate')) return true;
    if (element.isContentEditable) return true;
    for (let node = element; node; node = node.parentElement) {
      if (SKIP_TAGS.has(node.tagName)) return true;
    }
    return false;
  }

  function addItem(item) {
    const id = state.nextId++;
    const full = { id, applied: false, ...item };
    state.items.push(full);
    state.byId.set(id, full);
    return full;
  }

  /** Split a text node's value into (whitespace, content, whitespace).
   *
   *  The surrounding whitespace is layout, not content: inline elements sit on
   *  the spaces between them, so writing a translation back without them runs
   *  words together -- "Home About Us" becomes "HomeAboutUs". The lazy middle
   *  group is what makes this exact for values that are pure whitespace or
   *  that repeat their first character.
   */
  const WHITESPACE = /^(\s*)([\s\S]*?)(\s*)$/;

  /** Turn a run of adjacent text nodes into one translatable item.
   *
   *  The whole run's text is joined and translated as one sentence, and the
   *  result is written back into the FIRST node with the others blanked --
   *  there is no way to split a translation back across the original nodes,
   *  because the target language reorders the words. Any inline formatting
   *  inside the run is therefore flattened away; the text survives, the
   *  <em> does not. That trade is why FORMATTING_TAGS is a short list of
   *  purely cosmetic elements.
   */
  function runItemFor(nodes) {
    if (!nodes.length) return null;
    const raw = nodes.map((n) => n.nodeValue).join("");
    const [, lead, source, trail] = raw.match(WHITESPACE);
    for (const node of nodes) state.seen.add(node);
    if (!source) return null;
    return addItem({
      nodes,
      originals: nodes.map((n) => n.nodeValue),
      kind: "run",
      lead,
      trail,
      source,
    });
  }

  function textItemFor(node) {
    if (state.seen.has(node)) return null;
    if (!node.nodeValue || !node.nodeValue.trim()) return null;
    if (isSkippable(node.parentElement)) return null;
    return runItemFor([node]);
  }

  /** Which attributes of this element have already been registered.
   *
   *  Kept as a space-separated list in a data attribute rather than a WeakMap
   *  so that it survives this script being re-injected after a soft
   *  navigation. Matched by token, not substring -- `includes("alt")` would
   *  also fire on a list containing "alt-text" and silently skip it.
   */
  function claimedAttrs(element) {
    return new Set((element.dataset.starlingAttrs || "").split(/\s+/).filter(Boolean));
  }

  function claimAttr(element, attr) {
    const claimed = claimedAttrs(element);
    if (claimed.has(attr)) return false;
    claimed.add(attr);
    element.dataset.starlingAttrs = [...claimed].join(" ");
    return true;
  }

  /** Walk one element's children, grouping adjacent text into runs.
   *
   *  A run ends at anything that is not text or cosmetic inline markup: a
   *  link, a button, a block element, a skipped subtree. Those become their
   *  own runs, recursively, which is what keeps link text separately
   *  translatable and separately restorable.
   */
  function collectRuns(element, found) {
    let run = [];
    const flush = () => {
      if (run.length) {
        const item = runItemFor(run);
        if (item) found.push(item);
      }
      run = [];
    };

    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        // A node already collected means this run is continuing across
        // something the previous pass handled, so it has to break here --
        // otherwise the same node would be written twice.
        if (state.seen.has(child)) flush();
        else if (child.nodeValue) run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (SKIP_TAGS.has(child.tagName) || isSkippable(child)) {
        flush();
        continue;
      }
      if (FORMATTING_TAGS.has(child.tagName) && !hasStructure(child)) {
        // Cosmetic and text-only: absorb it into the sentence in progress.
        for (const node of textNodesIn(child)) {
          if (state.seen.has(node)) flush();
          else run.push(node);
        }
        continue;
      }
      flush();
      collectRuns(child, found);
    }
    flush();
  }

  /** Whether an inline element contains anything but text and more cosmetic
   *  inline markup. `<span><a href>…</a></span>` does, and must not be
   *  absorbed, or the link's text would be blanked when the run is applied. */
  function hasStructure(element) {
    for (const child of element.children) {
      if (!FORMATTING_TAGS.has(child.tagName) || hasStructure(child)) return true;
    }
    return false;
  }

  function textNodesIn(element) {
    const out = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue) out.push(node);
    }
    return out;
  }

  /** Walk `root` and register every translatable run of text, and every
   *  translatable attribute. */
  function collectFrom(root) {
    const found = [];

    if (root.nodeType === Node.ELEMENT_NODE && !isSkippable(root)) {
      collectRuns(root, found);
    }

    // Attributes. `root` itself may carry them, hence the explicit check
    // alongside querySelectorAll, which only looks at descendants.
    const selector = ATTRS.map((a) => `[${a}]`).join(",") + ",input[value]";
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
      elements.push(root);
    }
    if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));

    for (const element of elements) {
      if (isSkippable(element)) continue;
      for (const attr of ATTRS) {
        const value = element.getAttribute(attr);
        if (!value || !value.trim()) continue;
        if (!claimAttr(element, attr)) continue;
        found.push(
          addItem({ node: element, kind: "attr", attr, lead: "", trail: "", source: value.trim() }),
        );
      }
      // A button that is an <input> keeps its label in `value`, not in a child
      // text node, so the TreeWalker above never sees it. Only the button-ish
      // types: rewriting the value of a text field would replace what the user
      // typed with a translation of it.
      if (
        element.tagName === "INPUT" &&
        VALUE_INPUTS.has((element.type || "").toLowerCase()) &&
        element.value?.trim() &&
        claimAttr(element, "value")
      ) {
        found.push(
          addItem({ node: element, kind: "attr", attr: "value", lead: "", trail: "", source: element.value.trim() }),
        );
      }
    }

    return found;
  }

  /** Sort by where the text is, so the visible screen is translated first.
   *
   *  Rects are measured in one pass after collection rather than during it.
   *  Interleaving reads with the walk would force a layout per node, which on
   *  a large page is slower than the translation it is trying to prioritise.
   */
  function prioritise(items) {
    const height = window.innerHeight || 800;
    const measured = items.map((item) => {
      const element = item.kind === "run" ? item.nodes[0].parentElement : item.node;
      let top = Number.MAX_SAFE_INTEGER;
      let left = 0;
      let tier = 3;
      const rect = element?.getBoundingClientRect?.();
      if (rect && (rect.width || rect.height)) {
        top = rect.top;
        left = rect.left;
        if (rect.bottom > 0 && rect.top < height) tier = 0;       // on screen
        else if (rect.top >= height && rect.top < height * 4) tier = 1; // just below
        else tier = 2;                                             // far away
      }
      // tier 3 is what is left: zero-sized, i.e. a closed menu or a dialog
      // that has not opened. Worth translating -- an agent may open it -- but
      // last, behind everything the user can actually see.
      return { item, tier, top, left };
    });

    measured.sort((a, b) => a.tier - b.tier || a.top - b.top || a.left - b.left);
    return measured.map((m) => m.item);
  }

  /** Split into "translate now" and "translate when scrolled to".
   *
   *  Tier 0 and 1 from `prioritise` are the screen and its runway. Tier 2 is
   *  further down the page and tier 3 is inside something not currently
   *  displayed -- a closed menu, an unopened dialog. Neither is worth a
   *  minute of the user's time before they have asked to see it.
   */
  function partition(items) {
    const height = window.innerHeight || 800;
    const limit = height * (1 + RUNWAY);
    const now = [];
    const later = [];
    for (const item of items) {
      const element = item.kind === "run" ? item.nodes[0].parentElement : item.node;
      const rect = element?.getBoundingClientRect?.();
      const visible = rect && (rect.width || rect.height);
      if (visible && rect.top < limit) now.push(item);
      else later.push(item);
    }
    return { now, later };
  }

  /** Watch deferred content and report it as it comes into range.
   *
   *  rootMargin gives a screen of lead time, so text is requested before it
   *  is actually on screen and has a chance to land before the user reads it.
   *  Observing the PARENT element rather than the text node because
   *  IntersectionObserver only takes elements, and several runs commonly
   *  share one parent -- hence the element -> [items] map.
   */
  function startViewportWatch(items) {
    if (!items.length) return;
    state.viewport = new IntersectionObserver(
      (entries) => {
        const ready = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const waiting = state.deferred.get(entry.target);
          if (!waiting) continue;
          ready.push(...waiting.map((item) => item.id));
          state.deferred.delete(entry.target);
          state.viewport.unobserve(entry.target);
        }
        if (ready.length) {
          state.pending.push(...ready);
          scheduleNotify();
        }
      },
      { rootMargin: `${Math.round((window.innerHeight || 800))}px 0px` },
    );

    for (const item of items) {
      const element = item.kind === "run" ? item.nodes[0].parentElement : item.node;
      if (!element) continue;
      const list = state.deferred.get(element);
      if (list) list.push(item);
      else {
        state.deferred.set(element, [item]);
        state.viewport.observe(element);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Writing back
  // ---------------------------------------------------------------------

  function applyOne(item, translated) {
    if (!translated || translated === item.source) return false;
    try {
      if (item.kind === "run") {
        if (!item.nodes[0].isConnected) return false;
        // Everything goes into the first node. The translation is one
        // sentence in a language that reorders words, so there is no
        // defensible way to split it back across the nodes it came from.
        item.nodes[0].nodeValue = item.lead + translated + item.trail;
        for (let i = 1; i < item.nodes.length; i++) item.nodes[i].nodeValue = "";
      } else if (item.attr === "value") {
        item.node.value = translated;
      } else {
        item.node.setAttribute(item.attr, translated);
      }
      item.applied = true;
      item.translated = translated;
      return true;
    } catch {
      // A node can be removed or frozen between collection and application on
      // a live page. One lost segment is not worth failing the batch over.
      return false;
    }
  }

  function apply(updates) {
    // Our own writes are mutations. Left connected, the observer would see
    // them, queue them as new content and translate the translation.
    const observer = state.observer;
    if (observer) observer.disconnect();
    let applied = 0;
    for (const [id, text] of updates) {
      const item = state.byId.get(id);
      if (item && applyOne(item, text)) applied++;
    }
    if (observer) observer.observe(document.body, OBSERVER_OPTIONS);
    return applied;
  }

  function restore() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.viewport) {
      state.viewport.disconnect();
      state.viewport = null;
    }
    state.deferred.clear();
    state.pending.length = 0;
    let restored = 0;
    for (const item of state.items) {
      if (!item.applied) continue;
      try {
        if (item.kind === "run") {
          // Node by node from the recorded originals, not by re-splitting the
          // source: the blanked nodes have to come back with exactly the
          // whitespace they had, or the page reflows on restore.
          item.nodes.forEach((node, i) => {
            if (node.isConnected) node.nodeValue = item.originals[i];
          });
        } else if (item.attr === "value") {
          item.node.value = item.source;
        } else {
          item.node.setAttribute(item.attr, item.source);
        }
        restored++;
      } catch {
        /* the node is gone; nothing to restore */
      }
    }
    for (const element of document.querySelectorAll("[data-starling-attrs]")) {
      delete element.dataset.starlingAttrs;
    }
    state.items = [];
    state.byId.clear();
    state.seen = new WeakSet();
    state.active = false;
    state.target = null;
    document.documentElement.removeAttribute("data-starling-language");
    return restored;
  }

  // ---------------------------------------------------------------------
  // Dynamic content
  // ---------------------------------------------------------------------
  //
  // Without this, translation is a snapshot: the page is translated, then the
  // user clicks "next page" on a React site, the URL never changes, and the
  // new content arrives in English. Sites that render everything client-side
  // are most of the sites worth demonstrating this on.

  const OBSERVER_OPTIONS = { childList: true, subtree: true, characterData: false };

  function startObserver() {
    if (state.observer || !document.body) return;
    state.observer = new MutationObserver((records) => {
      const roots = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            roots.push(node);
          }
        }
      }
      if (!roots.length) return;

      const found = [];
      for (const root of roots) {
        if (root.nodeType === Node.TEXT_NODE) {
          const item = textItemFor(root);
          if (item) found.push(item);
        } else {
          found.push(...collectFrom(root));
        }
      }
      if (found.length) {
        state.pending.push(...found.map((item) => item.id));
        scheduleNotify();
      }
    });
    state.observer.observe(document.body, OBSERVER_OPTIONS);
  }

  /** Coalesce a burst of mutations into one message.
   *
   *  A single React render can fire hundreds of records. Reporting each one
   *  would mean hundreds of one-segment translation calls, which is the exact
   *  pathology the batching on the service side exists to avoid. */
  function scheduleNotify() {
    if (state.notifyTimer) return;
    state.notifyTimer = setTimeout(() => {
      state.notifyTimer = null;
      const ids = state.pending.splice(0);
      if (!ids.length || !state.active) return;
      const items = prioritise(ids.map((id) => state.byId.get(id)).filter(Boolean));
      chrome.runtime.sendMessage({
        type: "sl:new-segments",
        segments: items.map((item) => ({ id: item.id, text: item.source })),
      }).catch(() => {
        // The panel was closed. Stop watching rather than pile up work
        // nobody will collect.
        state.observer?.disconnect();
        state.observer = null;
      });
    }, 400);
  }

  // ---------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("sl:")) return undefined;

    switch (message.type) {
      case "sl:ping":
        sendResponse({ ok: true, script: "translate" });
        return false;

      case "sl:state":
        sendResponse({
          ok: true,
          active: state.active,
          target: state.target,
          total: state.items.length,
          applied: state.items.filter((i) => i.applied).length,
        });
        return false;

      case "sl:collect": {
        state.active = true;
        state.target = message.target || null;
        document.documentElement.setAttribute("data-starling-language", state.target || "");
        const items = prioritise(collectFrom(document.body));
        const { now, later } = partition(items);
        if (message.watch !== false) startObserver();
        startViewportWatch(later);
        sendResponse({
          ok: true,
          title: document.title,
          url: location.href,
          // `deferred` is reported so the panel can say "the rest arrives as
          // you scroll" rather than showing 40 of 160 and looking truncated.
          deferred: later.length,
          segments: now.map((item) => ({ id: item.id, text: item.source })),
        });
        return false;
      }

      case "sl:apply":
        sendResponse({ ok: true, applied: apply(message.updates || []) });
        return false;

      case "sl:restore":
        sendResponse({ ok: true, restored: restore() });
        return false;

      default:
        return undefined;
    }
  });

  window.__starlingTranslate = { state, restore };
})();
