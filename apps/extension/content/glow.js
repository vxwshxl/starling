// The page saying, in the page, that Starling is working on it.
//
// The panel is a 380px strip beside a full browser window, and while a run is
// going the interesting half of the screen is the other one -- the agent is
// clicking through the site, or the paragraphs are turning into Assamese one
// chunk at a time. A spinner in the panel does not tell you WHICH page that
// is happening to, and with several tabs open and the panel shared between
// them that is the question people actually have. So the page itself gets a
// ring while the run lasts, and loses it the moment the run ends.
//
// Three properties this has to have, and each one is a rule below:
//
//   1. It can never intercept a click. `pointer-events:none` on the host and
//      on everything inside it, !important, because the page's own stylesheet
//      is not ours to trust.
//   2. Neither Starling half may see it. The host carries `data-starling-ui`,
//      which is the marker content/translate.js and content/agent.js both
//      skip on -- otherwise the walker translates our own label and the
//      element index offers the agent its own decoration to click.
//   3. It must not outlive the panel. A side panel can be closed mid-run and
//      nothing tells the page about it, so the ring would sit there for ever.
//      Hence the watchdog: the panel re-asserts the glow every few seconds
//      and this script removes it if the assertions stop.

(() => {
  if (window.__starlingGlow) return;

  const HOST_ID = "starling-glow";
  const STYLE_ID = "starling-glow-style";
  const OWN_MARKER = "data-starling-ui";

  /** How long a glow survives without being re-asserted by the panel.
   *
   *  Sized against the panel's ping interval (a few seconds) with room for a
   *  slow model call in between, and against the failure it exists for: a
   *  closed panel should not leave a ring on somebody's page for longer than
   *  it takes to wonder whether the extension is broken. */
  const TTL_MS = 20000;

  const CSS = `
@property --starling-glow-angle {
  syntax: "<angle>"; initial-value: 0deg; inherits: false;
}
#${HOST_ID} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483646 !important;   /* one below the agent's action ring */
  pointer-events: none !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: none !important;
  opacity: 0;
  transition: opacity .2s ease;
  contain: layout style size;
}
#${HOST_ID}[data-on="true"] { opacity: 1; }
#${HOST_ID} * { pointer-events: none !important; box-sizing: border-box !important; }

/* The steady part: a soft inner wash that says "something owns this page". */
#${HOST_ID} .sl-ring {
  position: absolute; inset: 0; border-radius: 14px;
  box-shadow:
    inset 0 0 0 2px rgba(108, 140, 255, .72),
    inset 0 0 34px 4px rgba(108, 140, 255, .3),
    inset 0 0 110px 12px rgba(90, 69, 173, .16);
  animation: sl-glow-breathe 2.6s ease-in-out infinite;
}

/* The moving part: a bright arc travelling round the edge, so a run that is
   waiting on a model still looks alive rather than frozen. Drawn as a conic
   gradient with the middle masked out, which is the only way to get a
   gradient that follows a rounded border. */
#${HOST_ID} .sl-sweep {
  position: absolute; inset: 0; border-radius: 14px; padding: 2px;
  background: conic-gradient(
    from var(--starling-glow-angle),
    rgba(108, 140, 255, 0) 0deg,
    rgba(108, 140, 255, .35) 45deg,
    rgba(126, 160, 255, .95) 95deg,
    rgba(181, 139, 255, .95) 130deg,
    rgba(108, 140, 255, 0) 190deg,
    rgba(108, 140, 255, 0) 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: sl-glow-spin 3.6s linear infinite;
}

/* What it is doing, on the page it is doing it to. */
#${HOST_ID} .sl-pill {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 9px;
  max-width: min(560px, 84vw);
  font: 500 12.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .01em;
  color: #eaeeff;
  background: rgba(14, 15, 24, .88);
  border: 1px solid rgba(140, 162, 255, .34);
  border-radius: 999px;
  padding: 7px 15px 7px 12px;
  box-shadow: 0 14px 40px -14px rgba(0, 0, 0, .8), 0 0 22px -6px rgba(108, 140, 255, .5);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${HOST_ID} .sl-dot {
  flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
  background: #7ea0ff; animation: sl-glow-pulse 1.7s ease-out infinite;
}

@keyframes sl-glow-spin { to { --starling-glow-angle: 360deg; } }
@keyframes sl-glow-breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
@keyframes sl-glow-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(126, 160, 255, .55); }
  70%  { box-shadow: 0 0 0 8px rgba(126, 160, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(126, 160, 255, 0); }
}

/* Someone who has asked the OS for less motion is not asking for a pulsing
   border on every page they visit. The ring stays -- it is the information --
   and everything that moves stops. */
@media (prefers-reduced-motion: reduce) {
  #${HOST_ID} .sl-ring,
  #${HOST_ID} .sl-sweep,
  #${HOST_ID} .sl-dot { animation: none !important; }
  #${HOST_ID} .sl-ring { opacity: 1; }
  #${HOST_ID} .sl-sweep { opacity: .85; }
}
`;

  let host = null;
  let caption = null;
  let watchdog = null;
  let removal = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWN_MARKER, "");
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /** Build the overlay, or return the one already up.
   *
   *  Attached to <html> rather than <body>: both of Starling's own DOM walkers
   *  start at document.body, so living outside it means they cannot reach this
   *  even if the marker attribute were ever dropped, and a page script that
   *  rewrites document.body wholesale cannot take the ring with it.
   */
  function ensureHost() {
    const existing = document.getElementById(HOST_ID);
    if (existing) return existing;

    const node = document.createElement("div");
    node.id = HOST_ID;
    node.setAttribute(OWN_MARKER, "");
    node.setAttribute("aria-hidden", "true");
    // Belt and braces for other translation tools, Chrome's own included.
    node.setAttribute("translate", "no");
    node.className = "notranslate";

    const ring = document.createElement("div");
    ring.className = "sl-ring";
    const sweep = document.createElement("div");
    sweep.className = "sl-sweep";

    const pill = document.createElement("div");
    pill.className = "sl-pill";
    const dot = document.createElement("span");
    dot.className = "sl-dot";
    caption = document.createElement("span");
    pill.append(dot, caption);

    node.append(ring, sweep, pill);
    document.documentElement.appendChild(node);
    return node;
  }

  function show(label) {
    clearTimeout(removal);
    removal = null;
    ensureStyle();
    host = ensureHost();
    if (caption) caption.textContent = label || "Starling is working on this page";
    // A frame between insertion and the flag, or the opacity transition has
    // nothing to transition from and the ring appears with a snap.
    requestAnimationFrame(() => host?.setAttribute("data-on", "true"));

    clearTimeout(watchdog);
    watchdog = setTimeout(() => hide(), TTL_MS);
    return true;
  }

  function hide() {
    clearTimeout(watchdog);
    watchdog = null;
    const node = document.getElementById(HOST_ID);
    if (!node) return false;
    node.removeAttribute("data-on");
    clearTimeout(removal);
    // Removed rather than left hidden: an invisible fixed element on every
    // page the panel has ever touched is exactly the kind of litter that
    // turns up later as a mysterious layout bug on somebody's site.
    removal = setTimeout(() => node.remove(), 250);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "sl:glow") return undefined;
    try {
      sendResponse({ ok: true, showing: message.on ? show(message.label) : hide() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });

  window.__starlingGlow = { show, hide };
})();
