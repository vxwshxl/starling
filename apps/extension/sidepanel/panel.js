// The side panel: a chat that can read, translate and operate the page.
//
// One input box, three outcomes, and the model picks between them:
//
//   a question   -> answered from the page text, usually in one step
//   "translate"  -> the page is rewritten in place
//   anything else-> the agent loop clicks through the site
//
// This file also runs those loops rather than delegating to the service
// worker. See background.js for why -- briefly, a worker is killed after ~30 s
// idle and the agent loop spends most of its life waiting, so a loop running
// there stops halfway with no error.

import { AbortedError, ApiError, abortAll, createClient } from "../lib/api.js";
import { TabError, activeTab, checkInjectable } from "../lib/tabs.js";
import {
  MAX_STEPS,
  detectNavigation,
  detectRestoreIntent,
  fillSecret as fillSecretIn,
  goTo,
  hideGlow,
  hostOf,
  sameSite,
  readPage,
  restoreTranslation,
  runAgent,
  runTranslation,
  searchUrl,
  showGlow,
  translateNewSegments,
} from "../lib/run.js";

const client = createClient();
const $ = (id) => document.getElementById(id);

const ui = {
  pageTitle: $("page-title"),
  statusDot: $("status-dot"),
  status: $("status"),
  combo: $("lang-combo"),
  comboButton: $("lang-button"),
  comboLabel: $("lang-label"),
  comboMenu: $("lang-menu"),
  newChat: $("new-chat"),
  thread: $("thread"),
  welcome: $("welcome"),
  input: $("input"),
  send: $("send-btn"),
  stop: $("stop-btn"),
  mic: $("mic-btn"),
  error: $("error"),
  warm: $("warm-btn"),
  free: $("free-btn"),
  cache: $("cache-btn"),
};

const state = {
  languages: [],
  tabId: null,
  blocked: null,
  busy: false,
  stopRequested: false,
  recorder: null,
  translated: false,
  /** The tab currently wearing the working glow, and the ticker keeping it
   *  alive. Held separately from `tabId` because the run belongs to the tab
   *  it started on: switching tabs mid-run must not move the ring off the
   *  page that is actually being worked on. */
  glowTab: null,
  glowTimer: null,
  glowLabel: "",
  /** {role, text} turns sent to the model so follow-ups resolve. Trimmed to
   *  the last few by agent.py; kept whole here for the transcript. */
  conversation: [],
};

// ---------------------------------------------------------------------------
// Thread rendering
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent throughout, never innerHTML: everything below is either model
  // output or page text, and both are untrusted.
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollDown() {
  ui.thread.scrollTop = ui.thread.scrollHeight;
}

function addMessage(role, text, { plain = false } = {}) {
  ui.welcome.hidden = true;
  const msg = el("div", `msg ${role}${plain ? " plain" : ""}`);
  const bubble = el("div", "bubble", text);
  msg.append(bubble);
  ui.thread.append(msg);
  scrollDown();
  return { msg, bubble };
}

/** A bot turn that starts as a live activity trace and ends as an answer. */
function startBotTurn() {
  ui.welcome.hidden = true;
  const msg = el("div", "msg bot plain");
  const trace = el("details", "trace");
  const summary = el("summary");
  const spinner = el("span", "spinner");
  const label = el("span", "", "Reading the page…");
  summary.append(spinner, label);
  const steps = el("ol", "steps");
  trace.append(summary, steps);
  msg.append(trace);
  ui.thread.append(msg);
  scrollDown();

  let count = 0;
  return {
    msg,
    trace,
    setLabel(text) {
      label.textContent = text;
      // The page's pill says the same thing as the panel's trace line, so
      // there is one story and not two. Attributed, because on a page you
      // are reading, an unlabelled "Thinking…" belongs to nobody.
      paintGlow(`Starling · ${text}`);
    },
    stopSpinner() { spinner.remove(); },
    addStep(nodes, why) {
      count++;
      const li = el("li");
      const n = el("span", "n", String(count));
      const body = el("div");
      const what = el("div", "what");
      what.append(...nodes);
      body.append(what);
      if (why) body.append(el("div", "why", why));
      li.append(n, body);
      steps.append(li);
      scrollDown();
      return li;
    },
    lastStepOutcome(text, bad) {
      const li = steps.lastElementChild;
      if (!li) return;
      if (bad) li.classList.add("bad");
      li.querySelector("div").append(el("div", "outcome", text));
    },
    /** Replace the live trace with a settled summary and attach the answer. */
    finish(summaryText, answer, answerEn, language) {
      spinner.remove();
      label.textContent = summaryText;
      if (!count) trace.hidden = true;
      if (answer) {
        const bubble = el("div", "bubble", answer);
        if (answerEn && answerEn !== answer) {
          bubble.append(el("p", "original", answerEn));
        }
        msg.append(bubble);
        msg.classList.remove("plain");
        if (language) addSpeakButton(msg, answer, language);
      }
      scrollDown();
    },
  };
}

// ---------------------------------------------------------------------------
// Speaking an answer
// ---------------------------------------------------------------------------
//
// OmniVoice, through POST /tts, in the language the answer is written in.
//
// It is a button and never automatic, and the reason is the measured cost:
// local synthesis on this machine runs about 6x real time, so a twelve-
// sentence answer -- which is now the normal length -- is minutes of CPU. The
// button says so before you press it, and the elapsed time is shown while it
// works so a long wait looks like work rather than a hang. If that is too
// slow for a demo, STARLING_TTS_BACKEND=modal is ~3 s warm; it does not clone
// the voice and the text leaves the machine, which the service flags back to
// us in `warnings` and which is surfaced here rather than buried.

const BARS = 48;

function svgIcon(paths, { size = 13, fill = "none", width = 2 } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", fill === "none" ? "currentColor" : "none");
  svg.setAttribute("stroke-width", width);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const ICON_SPEAKER = ["M11 5 6 9H2v6h4l5 4V5Z", "M15.5 8.5a5 5 0 0 1 0 7", "M19 5a9 9 0 0 1 0 14"];
const ICON_PLAY = ["M8 5.5v13l11-6.5z"];
const ICON_PAUSE = ["M8 5h3v14H8z", "M13 5h3v14h-3z"];

function clock(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Decode the clip once and reduce it to per-bar peak amplitudes.
 *
 *  Real peaks, not a decorative animation: the shape has to match the audio,
 *  because its job is to let someone see where the speech is and scrub to it.
 *  It also shows at a glance whether synthesis produced speech at all or the
 *  near-silence failure mode the CPU/MPS notes in CLAUDE.md warn about -- a
 *  flat line is the tell, and a decorative waveform would hide it.
 */
async function peaksOf(url) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    const data = buffer.getChannelData(0);
    const per = Math.floor(data.length / BARS) || 1;
    const out = [];
    let loudest = 0;
    for (let i = 0; i < BARS; i++) {
      let peak = 0;
      for (let j = i * per; j < (i + 1) * per && j < data.length; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      out.push(peak);
      if (peak > loudest) loudest = peak;
    }
    // Normalised against the clip's own peak. OmniVoice output sits around
    // 0.5, so an un-normalised waveform would be a permanently half-height
    // stub.
    return loudest > 0 ? out.map((p) => p / loudest) : out;
  } finally {
    void ctx.close();
  }
}

/** The player itself: play/pause, a scrubbable waveform, elapsed/total.
 *
 *  The same three affordances as `<audio controls>`, drawn in the app's own
 *  language. The native element renders as a wide slab of Chrome's own chrome
 *  -- its greys, its radius, its volume slider -- which in a 380px monochrome
 *  panel looks like a foreign object. Ported from the web app's AudioPlayer
 *  so the extension and the site show the same thing.
 */
function audioPlayer(src) {
  const wrap = el("div", "player");
  const audio = new Audio(src);
  audio.preload = "metadata";

  const button = el("button", "play");
  button.type = "button";
  button.setAttribute("aria-label", "Play");
  button.append(svgIcon(ICON_PLAY, { size: 14, fill: "currentColor" }));

  const wave = el("div", "wave");
  wave.setAttribute("role", "slider");
  wave.tabIndex = 0;
  wave.setAttribute("aria-label", "Seek");

  const time = el("span", "time", "0:00/0:00");
  wrap.append(button, wave, time);

  let bars = [];
  let total = 0;

  const paint = () => {
    const progress = total > 0 ? audio.currentTime / total : 0;
    bars.forEach((bar, i) => {
      bar.classList.toggle("on", i / BARS <= progress);
    });
    time.textContent = `${clock(audio.currentTime)}/${clock(total)}`;
  };

  peaksOf(src)
    .then((peaks) => {
      wave.replaceChildren();
      bars = peaks.map((p) => {
        const bar = el("span", "bar");
        bar.style.height = `${Math.max(9, p * 100)}%`;
        wave.append(bar);
        return bar;
      });
      paint();
    })
    .catch(() => {
      // Decoding is a nicety; playback still works without the waveform.
      wave.append(el("span", "wave-fallback", "audio ready"));
    });

  const setIcon = (playing) => {
    button.replaceChildren(
      svgIcon(playing ? ICON_PAUSE : ICON_PLAY, { size: 14, fill: "currentColor" }),
    );
    button.setAttribute("aria-label", playing ? "Pause" : "Play");
  };

  button.addEventListener("click", () => {
    if (audio.paused) audio.play().catch(() => setIcon(false));
    else audio.pause();
  });
  audio.addEventListener("play", () => setIcon(true));
  audio.addEventListener("pause", () => setIcon(false));
  audio.addEventListener("ended", () => setIcon(false));
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("loadedmetadata", () => {
    total = audio.duration;
    paint();
  });

  const seekTo = (clientX) => {
    if (!total) return;
    const box = wave.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(total, ((clientX - box.left) / box.width) * total));
  };
  wave.addEventListener("click", (event) => seekTo(event.clientX));
  wave.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") audio.currentTime = Math.min(total, audio.currentTime + 5);
    if (event.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  return { wrap, audio };
}

// ---------------------------------------------------------------------------
// Speaking an answer
// ---------------------------------------------------------------------------
//
// OmniVoice through POST /tts, on Modal rather than on this CPU. Same model,
// rented GPU: local synthesis measured 31-37 s for one answer, and answers
// are now 6-12 sentences, so on-device is minutes and unusable from a panel.
//
// The trade is real and is printed, not buried: Modal does not clone the
// speaker's voice and the text leaves the machine. The service returns both
// caveats in `warnings` and they are shown under the player.

/** Attach a Speak control that becomes a player once synthesis finishes. */
function addSpeakButton(container, text, language) {
  if (!text || !text.trim()) return;

  const row = el("div", "speak-row");
  const button = el("button", "speak");
  button.type = "button";
  const caption = el("span", "", "Speak");
  const elapsed = el("span", "speak-ms", "");
  button.append(svgIcon(ICON_SPEAKER), caption, elapsed);
  row.append(button);
  container.append(row);

  let ticker = null;

  button.addEventListener("click", async () => {
    button.disabled = true;
    const started = Date.now();
    caption.textContent = "Synthesising";
    // The elapsed counter is the whole reason a 25-second wait is tolerable:
    // without it a silent button is indistinguishable from a hung one.
    ticker = setInterval(() => {
      elapsed.textContent = `${Date.now() - started} ms`;
    }, 100);

    try {
      const { result } = await client.speak(text, language, { backend: "modal" });
      clearInterval(ticker);
      caption.textContent = "Speak";
      elapsed.textContent = `${Date.now() - started} ms`;

      const { wrap, audio } = audioPlayer(client.audioUrl(result.audio_path));
      container.append(wrap);
      if (result.warnings?.length) {
        container.append(el("p", "speak-note", result.warnings.join(" ")));
      }
      // Pressing Speak is a request to hear it, so it plays.
      audio.play().catch(() => {
        /* autoplay policy can refuse; the play button is right there */
      });
      button.remove();
      scrollDown();
    } catch (err) {
      clearInterval(ticker);
      caption.textContent = "Speak";
      elapsed.textContent = "";
      button.disabled = false;
      showError(err);
    }
  });
}

function describeAction(decision) {
  const { action, args } = decision;
  const code = (t) => el("code", "", t);
  const txt = (t) => document.createTextNode(t);
  switch (action) {
    case "click": return [txt("click "), code(args.ref)];
    case "type": return [txt(`type “${args.text}” into `), code(args.ref)];
    case "select": return [txt(`choose “${args.value}” in `), code(args.ref)];
    case "scroll": return [txt(`scroll ${args.direction}`)];
    case "navigate": return [txt(`go to ${args.url}`)];
    case "back": return [txt("go back")];
    default: return [txt(action)];
  }
}

function showError(err) {
  if (err instanceof AbortedError) return; // the user pressed Stop
  const message =
    err instanceof ApiError || err instanceof TabError
      ? err.message
      : `${err?.name || "Error"}: ${err?.message || err}`;
  ui.error.textContent = message;
  ui.error.hidden = false;
  console.error("[starling]", err);
}

const clearError = () => { ui.error.hidden = true; };

// ---------------------------------------------------------------------------
// Status and settings
// ---------------------------------------------------------------------------

function setStatus(kind, title) {
  ui.statusDot.className = `dot ${kind}`;
  ui.status.title = title;
}

// ---------------------------------------------------------------------------
// The working glow
// ---------------------------------------------------------------------------
//
// While a run is going, the page it is going on wears a ring. The panel is a
// narrow strip and the interesting half of the screen is the other one, so
// the state that matters -- "this is being worked on, and this is what it is
// doing" -- is put where the user is already looking.
//
// The page cannot be trusted to take the ring off by itself: closing the side
// panel kills this file without a word to any content script. So glow.js
// removes the ring if it stops hearing from us, and this ticker is what it
// hears. It doubles as the repaint after a navigation, since the agent's
// whole job is to destroy the document the ring was drawn on.

const GLOW_PING_MS = 6000;

function paintGlow(label) {
  if (label) state.glowLabel = label;
  if (!state.busy || state.glowTab == null) return;
  void showGlow(state.glowTab, state.glowLabel);
}

function startGlow(label) {
  state.glowTab = state.tabId;
  state.glowLabel = label || "Starling is working on this page";
  paintGlow();
  clearInterval(state.glowTimer);
  state.glowTimer = setInterval(() => paintGlow(), GLOW_PING_MS);
}

function stopGlow() {
  clearInterval(state.glowTimer);
  state.glowTimer = null;
  const tab = state.glowTab;
  state.glowTab = null;
  void hideGlow(tab);
}

function setBusy(busy) {
  state.busy = busy;
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  if (busy) startGlow();
  else stopGlow();
  // The input deliberately stays enabled. Disabling it meant that noticing
  // the agent going the wrong way and wanting to redirect it left you with
  // nothing to do but watch. Sending while it works interrupts and starts the
  // new instruction -- which is what every chat client does and what people
  // try first.
}

async function refreshTab() {
  try {
    const tab = await activeTab();
    state.tabId = tab.id;
    try {
      checkInjectable(tab.url);
      state.blocked = null;
      ui.pageTitle.textContent = tab.title || tab.url || "No page";
    } catch (err) {
      // Not an error worth a red box -- switching to a settings tab is a
      // normal thing to do. Just say why nothing will work here.
      state.blocked = err.message;
      ui.pageTitle.textContent = err.message;
    }
  } catch {
    state.tabId = null;
    state.blocked = "No active tab.";
  }
}

async function refreshHealth() {
  setStatus("busy", "checking…");
  try {
    const health = await client.health();
    const models = health.models || {};
    const resident = Object.entries(models)
      .filter(([, v]) => v && typeof v === "object" && v.loaded)
      .map(([name]) => name);
    setStatus(
      "ok",
      resident.length ? `Ready · warm: ${resident.join(", ")}` : "Ready · no models loaded yet",
    );
  } catch (err) {
    setStatus("bad", "Offline — start the service with `pnpm dev:api`");
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// The language picker
// ---------------------------------------------------------------------------
//
// Hand-built rather than a <select>, because a native select renders as an
// opaque OS menu that ignores the panel's tokens entirely -- on macOS it stays
// a light popup in dark mode, and it was the one control here that looked
// like it belonged to a different application. `target` replaces what used to
// be `target.value`.

const target = {
  code: "as",
  get value() { return this.code; },
  set value(code) {
    this.code = code;
    const language = state.languages.find((l) => l.code === code);
    ui.comboLabel.textContent = language ? language.native_name : code;
    ui.comboButton.title = language ? `Your language: ${language.name}` : "Your language";
    for (const option of ui.comboMenu.children) {
      option.setAttribute("aria-selected", String(option.dataset.code === code));
    }
  },
};

function closeCombo() {
  ui.combo.dataset.open = "false";
  ui.comboButton.setAttribute("aria-expanded", "false");
  ui.comboMenu.hidden = true;
}

function openCombo() {
  ui.combo.dataset.open = "true";
  ui.comboButton.setAttribute("aria-expanded", "true");
  ui.comboMenu.hidden = false;
  ui.comboMenu.querySelector('[aria-selected="true"]')?.focus();
}

ui.comboButton.addEventListener("click", () => {
  if (ui.comboMenu.hidden) openCombo();
  else closeCombo();
});

// A menu that only closes via its own button is a menu people get stuck in.
document.addEventListener("click", (event) => {
  if (!ui.combo.contains(event.target)) closeCombo();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || ui.comboMenu.hidden) return;
  closeCombo();
  ui.comboButton.focus();
});

async function loadLanguages() {
  const { languages } = await client.languages();
  state.languages = languages;

  ui.comboMenu.replaceChildren();
  for (const language of languages) {
    const option = el("button", "combo-option");
    option.type = "button";
    option.role = "option";
    option.dataset.code = language.code;

    const tick = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    tick.setAttribute("class", "tick");
    tick.setAttribute("viewBox", "0 0 24 24");
    tick.setAttribute("width", "12");
    tick.setAttribute("height", "12");
    tick.setAttribute("fill", "none");
    tick.setAttribute("stroke", "currentColor");
    tick.setAttribute("stroke-width", "3");
    tick.setAttribute("stroke-linecap", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m5 13 4 4L19 7");
    tick.append(path);

    option.append(tick, el("span", "native", language.native_name));
    // Every row is "endonym, then English name" -- except English, where the
    // two are the same word and the row would read "English English".
    if (language.name !== language.native_name) {
      option.append(el("span", "latin", language.name));
    }
    option.addEventListener("click", () => {
      target.value = language.code;
      chrome.storage.local.set({ target: language.code });
      closeCombo();
      ui.comboButton.focus();
    });
    ui.comboMenu.append(option);
  }

  const stored = await chrome.storage.local.get({ target: "as" });
  target.value = languages.some((l) => l.code === stored.target) ? stored.target : languages[0]?.code;
}

// ---------------------------------------------------------------------------
// The three things a message can turn into
// ---------------------------------------------------------------------------

async function doTranslate(turn, target) {
  // English is the pivot, and page translation runs English -> your language
  // with the source assumed, not detected. Asking for English is therefore
  // asking for the page you are already looking at: the service would return
  // every segment unchanged and the card would report a confident 100% having
  // done nothing at all. Say so instead.
  if (target === "en") {
    turn.finish(
      "Nothing to translate",
      "You are set to English, and this page is read as English already, so " +
        "there is nothing to translate. Pick Assamese, Bodo, Bengali, " +
        "Manipuri or Nepali and ask again — or keep English and ask me about " +
        "the page instead, which is the fast path: no translation either way.",
    );
    return;
  }

  const language = state.languages.find((l) => l.code === target);
  turn.setLabel(`Translating into ${language ? language.name : target}…`);

  const card = el("div", "progress-card");
  const top = el("div", "top");
  const heading = el("span", "", "Reading the page…");
  const pct = el("b", "", "0%");
  top.append(heading, pct);
  const bar = el("div", "bar");
  const fill = el("div", "fill");
  bar.append(fill);
  const counts = el("div", "counts");
  card.append(top, bar, counts);
  turn.msg.append(card);
  scrollDown();

  let deferred = 0;
  await runTranslation({
    tabId: state.tabId,
    client,
    source: "en",
    target,
    shouldStop: () => state.stopRequested,
    onEvent(event) {
      if (event.type === "collected") {
        deferred = event.deferred;
        heading.textContent = deferred
          ? `${event.total} on screen, ${deferred} as you scroll`
          : `${event.total} segments`;
      } else if (event.type === "progress") {
        const p = Math.round((event.done / Math.max(event.total, 1)) * 100);
        fill.style.width = `${p}%`;
        pct.textContent = `${p}%`;
        paintGlow(`Starling · translating this page — ${p}%`);
        counts.replaceChildren(
          el("span", "", `translated `), el("b", "", String(event.counts.translated)),
          el("span", "", ` · cached `), el("b", "", String(event.counts.from_cache)),
          el("span", "", ` · skipped `), el("b", "", String(event.counts.skipped)),
        );
      } else if (event.type === "done") {
        state.translated = true;
        fill.style.width = "100%";
        pct.textContent = event.stopped ? "stopped" : "100%";
        // Keep the card addressable so scroll-triggered work can keep the
        // running total honest instead of leaving it frozen at the first pass.
        state.liveCard = {
          counts,
          heading,
          totals: { ...event.counts },
          deferred,
        };
      }
    },
  });

  const undo = el("button", "undo", "Show the original");
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    try {
      await restoreTranslation(state.tabId);
      state.translated = false;
      undo.textContent = "Original restored";
    } catch (err) {
      showError(err);
      undo.disabled = false;
    }
  });
  card.append(undo);

  turn.finish(
    `Translated into ${language ? language.name : target}`,
    null,
  );
}

/** Anything shaped like an identifier, blanked before it is stored.
 *
 *  The same rule as agent.redact() on the service, applied on this side too,
 *  because the conversation array is assembled here and is what gets sent
 *  back to the model on every subsequent turn. A number that reaches it is a
 *  number the model sees for the rest of the session. */
const redact = (text) =>
  (text || "")
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[redacted]")
    .replace(/\b\d{9,19}\b/g, "[redacted]");

/** Collect a value the model must never see, and type it into the page.
 *
 *  This is the whole privacy design for the Aadhaar flow. The service refuses
 *  to let the model produce a value for a field it recognises as an
 *  identifier -- it returns `ask` with needs="secret" and the ref instead --
 *  and the value the user types here goes straight to the content script.
 *  It is never sent to /agent/act, never written to the transcript, never
 *  logged, and is dropped from memory as soon as it has been typed.
 */
function askSecret(decision, goal, resume) {
  const box = el("div", "confirm secret");
  box.append(el("p", "", decision.message || "I need a value for this field."));

  const form = el("form", "secret-form");
  const input = document.createElement("input");
  input.type = "password";
  input.className = "secret-input";
  input.autocomplete = "off";
  input.placeholder = "Type it here";
  input.setAttribute("aria-label", "Value to type into the page");

  const submit = el("button", "yes", "Fill it in");
  submit.type = "submit";
  const cancel = el("button", "", "Cancel");
  cancel.type = "button";
  form.append(input, submit, cancel);
  box.append(form);
  box.append(el("p", "secret-note", "Typed straight into the page. Not sent to the model, not kept in this chat."));

  const settle = (text) => {
    form.remove();
    box.append(el("p", "original", text));
    scrollDown();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    if (!value) return;
    submit.disabled = cancel.disabled = true;
    try {
      await fillSecretIn(state.tabId, decision.args.ref, value);
      settle("Filled in.");
      // What the model is told. Deliberately not the value.
      state.conversation.push({ role: "assistant", text: "The user supplied that value; it is now in the field." });
      resume(true);
    } catch (err) {
      settle("Could not fill that field.");
      showError(err);
      resume(false);
    }
  });
  cancel.addEventListener("click", () => {
    settle("Cancelled.");
    resume(false);
  });

  ui.thread.append(box);
  input.focus();
  scrollDown();
}

/** A captcha or an OTP: the user does it in the page, then says go on. */
function askHuman(decision, resume) {
  const box = el("div", "confirm");
  box.append(el("p", "", decision.message || "Please do this step in the page yourself."));
  const row = el("div", "row");
  const go = el("button", "yes", "Done — carry on");
  const stop = el("button", "", "Stop here");
  row.append(go, stop);
  box.append(row);

  const settle = (text) => {
    go.disabled = stop.disabled = true;
    box.append(el("p", "original", text));
    scrollDown();
  };
  go.addEventListener("click", () => {
    settle("Carrying on.");
    state.conversation.push({ role: "assistant", text: "The user completed that step in the page." });
    resume(true);
  });
  stop.addEventListener("click", () => {
    settle("Stopped.");
    resume(false);
  });

  ui.thread.append(box);
  scrollDown();
}

/** Render a confirmation and resume the run if the user says yes. */
function askConfirmation(decision, resume) {
  const box = el("div", "confirm");
  box.append(el("p", "", decision.message || "Shall I go ahead?"));
  const row = el("div", "row");
  const yes = el("button", "yes", "Yes, do it");
  const no = el("button", "", "No");
  row.append(yes, no);
  box.append(row);

  const settle = (text) => {
    yes.disabled = no.disabled = true;
    box.append(el("p", "original", text));
    scrollDown();
  };
  yes.addEventListener("click", () => {
    settle("You approved this.");
    resume(true);
  });
  no.addEventListener("click", () => {
    settle("Cancelled.");
    state.conversation.push({ role: "assistant", text: "The user declined that action." });
    resume(false);
  });

  ui.thread.append(box);
  scrollDown();
}


/** Ask the service what this request is, then do that.
 *
 *  The single dispatch point. It replaced a pile of regexes that each got one
 *  phrasing right and the next one wrong -- most visibly, "size is 7 from
 *  flipkart under 1000 rupees" produced a chatty list of instructions for
 *  using Flipkart instead of opening it, because a domain matcher sees no
 *  domain in "flipkart".
 *
 *  Deciding what someone meant is the one thing the model is reliably better
 *  at than a pattern, so it decides. Measured at about a second, and it
 *  returns the goal already translated, which the step after it would
 *  otherwise have paid for again.
 */
async function followRoute(text, turn) {
  turn.setLabel("Working out what you need…");
  const tab = await activeTab();
  const { result: plan } = await client.route({
    text,
    url: state.blocked ? "" : tab.url || "",
    title: state.blocked ? "" : tab.title || "",
    language: target.value,
  });

  // Somewhere else to be? Go there first, then work there.
  if (plan.site && !sameSite(plan.site_url, tab.url || "")) {
    turn.setLabel(`Opening ${plan.site}…`);
    await goTo(state.tabId, plan.site_url);
    await refreshTab();
    if (state.blocked) {
      turn.finish("Could not open that", state.blocked);
      return;
    }
    await doAgent(text, turn, { goalEn: plan.goal_en });
    return;
  }

  if (plan.intent === "translate") {
    if (state.blocked) {
      // "Translate this page" on a page that does not exist is a real dead
      // end and says so. Anything else routed here is a misroute -- the
      // router reaches for "translate" whenever a language is mentioned, and
      // "show me how Assamese culture looks" is a thing to go and find, not a
      // page to rewrite. Searching is the useful reading of it.
      if (/\b(this|current)\s+(page|site|tab)\b/i.test(plan.goal_en || text)) {
        turn.finish(
          "Nothing to translate",
          "Chrome does not allow extensions to read this page, so there is nothing here to translate. Open an ordinary site and ask again.",
        );
        return;
      }
      await searchThenAct(text, plan, turn);
      return;
    }
    await doTranslate(turn, target.value);
    return;
  }

  if (plan.intent === "answer") {
    // A page we can read answers from the page; anything else falls back to
    // Starling's own knowledge, which is what /chat is.
    if (!state.blocked) {
      await doAsk(text, turn);
      return;
    }
    turn.setLabel("Answering…");
    const { result } = await client.chat(text, target.value);
    turn.finish("Answered", result.text, result.text_en, target.value);
    state.conversation.push({ role: "assistant", text: redact(result.text_en || result.text) });
    return;
  }

  // "act", with no particular site. On a real page that means "here". On a
  // blocked one there is no "here", so go and find a starting point instead
  // of telling the user to do it themselves.
  if (state.blocked) {
    await searchThenAct(text, plan, turn);
    return;
  }
  await doAgent(text, turn, { goalEn: plan.goal_en });
}


/** Start from a search, then work the results like any other page.
 *
 *  This is what makes a fresh tab usable: the agent has no page to read, so
 *  it gives itself one. The search runs in the user's pivot language rather
 *  than their own, because `goal_en` is what the rest of the cascade already
 *  speaks and English results are what the page agent can then read.
 */
async function searchThenAct(text, plan, turn) {
  const query = (plan.goal_en || text).trim();
  turn.setLabel("Searching the web…");
  turn.addStep(`Search the web for “${query}”`, "no page here to start from");
  await goTo(state.tabId, searchUrl(query));
  await refreshTab();

  if (state.blocked) {
    turn.finish("Could not open a page", state.blocked);
    return;
  }
  await doAgent(text, turn, { goalEn: plan.goal_en });
}


/** Answer a question about the page, without touching it. */
async function doAsk(question, turn) {
  turn.setLabel("Reading the page…");
  const page = await readPage(state.tabId);
  if (!page.text || page.text.trim().length < 40) {
    // Nothing worth reading. Fall through to the agent, which can go and
    // look for the answer rather than inventing one from an empty page.
    return doAgent(question, turn);
  }

  turn.setLabel("Writing an answer…");
  const { result } = await client.ask({
    question,
    text: page.text,
    url: page.url,
    title: page.title,
    language: target.value,
  });
  turn.finish("Read the page", result.message, result.message_en, target.value);
  state.conversation.push({ role: "assistant", text: result.message_en || result.message });
}

async function doAgent(goal, turn, { preapproved = null, goalEn = "" } = {}) {
  turn.setLabel("Thinking…");
  let stepCount = 0;

  const result = await runAgent({
    goal,
    language: target.value,
    tabId: state.tabId,
    client,
    conversation: state.conversation,
    goalEn,
    preapproved,
    shouldStop: () => state.stopRequested,
    onEvent(event) {
      if (event.type === "step") {
        turn.setLabel(`Looking at ${event.title || "the page"}…`);
      } else if (event.type === "decision") {
        const d = event.decision;
        if (!d.terminal && !d.needs_confirmation) {
          stepCount++;
          turn.addStep(describeAction(d), d.why);
        }
      } else if (event.type === "acted") {
        turn.lastStepOutcome(event.error || `→ ${event.label || event.outcome}`, !!event.error);
      }
    },
  });

  const summary = stepCount === 1 ? "1 action" : `${stepCount} actions`;

  // The page said this needs a yes. Stop here; the confirmation resumes with
  // the approved action executed directly, never re-decided.
  if (result.reason === "confirm") {
    turn.finish(summary, null);
    askConfirmation(result.decision, async (approved) => {
      if (!approved) return;
      const next = startBotTurn();
      setBusy(true);
      try {
        await doAgent(goal, next, { preapproved: result.decision, goalEn });
      } catch (err) {
        next.finish("Stopped", null);
        showError(err);
      } finally {
        setBusy(false);
      }
    });
    return;
  }

  if (result.reason === "translate_page") {
    await doTranslate(turn, target.value);
    return;
  }

  const decision = result.decision;

  // The service withheld a field from the model: an identifier it must not
  // produce, or a captcha/OTP that needs a person. Both pause here and
  // continue the same goal once the user has dealt with it.
  if (decision?.needs === "secret" || decision?.needs === "human") {
    turn.finish(summary, null);
    const carryOn = async (ok) => {
      if (!ok) return;
      const next = startBotTurn();
      setBusy(true);
      try {
        await doAgent(goal, next, { goalEn });
      } catch (err) {
        next.finish("Stopped", null);
        showError(err);
      } finally {
        setBusy(false);
      }
    };
    if (decision.needs === "secret") askSecret(decision, goal, carryOn);
    else askHuman(decision, carryOn);
    return;
  }

  if (decision?.message) {
    turn.finish(summary, decision.message, decision.message_en, target.value);
    state.conversation.push({
      role: "assistant",
      text: redact(decision.message_en || decision.message),
    });
    if (decision.action === "ask") ui.input.focus();
  } else if (result.reason === "cap") {
    turn.finish(summary, `I stopped after ${MAX_STEPS} steps without finishing. Tell me the next step and I will carry on.`);
  } else if (result.reason === "stuck") {
    turn.finish(summary, "I kept trying the same thing, so I stopped. Could you say it differently?");
  } else if (result.reason === "stopped") {
    turn.finish(summary, "Stopped.");
  } else if (result.reason === "changed") {
    turn.finish(summary, "The page changed while you were deciding, so I did not press anything.");
  } else {
    turn.finish(summary, "Done.");
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function send() {
  const text = ui.input.value.trim();
  if (!text) return;

  // Interrupt rather than ignore. The loop unwinds on the aborted fetch;
  // a short wait lets its `finally` run so two runs never overlap.
  if (state.busy) {
    stopRun();
    for (let i = 0; i < 40 && state.busy; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  clearError();
  await refreshTab();

  addMessage("user", text);
  // Redacted before storing: if someone pastes their Aadhaar number into the
  // chat rather than into the masked field, it must not then ride along in
  // every subsequent prompt for the rest of the session.
  state.conversation.push({ role: "user", text: redact(text) });
  ui.input.value = "";
  ui.input.style.height = "auto";

  state.stopRequested = false;
  setBusy(true);
  const turn = startBotTurn();

  try {
    // Chrome forbids scripting some pages. That is not a reason to refuse:
    // followRoute() navigates away or answers from Starling's own knowledge.
    // Two fast paths that need no model, because they are unambiguous and
    // common: undoing a translation, and an explicit URL or "go to X".
    if (detectRestoreIntent(text)) {
      await restoreTranslation(state.tabId);
      state.translated = false;
      turn.finish("Restored", "Put the original page back.");
      return;
    }
    const explicit = detectNavigation(text);
    if (explicit && !sameSite(explicit.url, (await activeTab()).url)) {
      turn.setLabel(`Opening ${hostOf(explicit.url)}…`);
      await goTo(state.tabId, explicit.url);
      await refreshTab();
      await doAgent(text, turn);
      return;
    }

    // Everything else is decided by the model, not by pattern matching.
    // A regex cannot tell that "size is 7 from flipkart under 1000" means
    // open flipkart.com -- it sees no domain, because people write brand
    // names, not hostnames. See ROUTER_PROMPT in agent.py.
    await followRoute(text, turn);
  } catch (err) {
    turn.finish("Stopped", err instanceof AbortedError ? "Stopped." : null);
    showError(err);
  } finally {
    setBusy(false);
    refreshHealth();
  }
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

async function toggleMic() {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }
  clearError();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // Almost always NotAllowedError, and almost never because the user said
    // no -- a side panel is not a tab, so Chrome has nowhere to anchor the
    // permission prompt and rejects the call without ever showing one. The
    // fix is to ask from a real tab; the grant is stored against the
    // extension's origin, so doing it once there fixes it here.
    const turn = addMessage(
      "bot",
      err?.name === "NotFoundError"
        ? "I cannot find a microphone on this machine. You can type instead."
        : "Chrome will not open the microphone prompt inside a side panel. Let me ask from a normal tab — it only needs doing once.",
      { plain: true },
    );
    if (err?.name !== "NotFoundError") {
      const open = el("button", "undo", "Allow the microphone");
      open.addEventListener("click", () =>
        chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }),
      );
      turn.bubble.append(document.createElement("br"), open);
    }
    scrollDown();
    return;
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  state.recorder = recorder;
  ui.mic.classList.add("recording");
  ui.input.placeholder = "Listening… press the microphone again to stop.";

  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    state.recorder = null;
    ui.mic.classList.remove("recording");
    ui.input.placeholder = "Transcribing…";
    ui.mic.disabled = true;
    try {
      const response = await client.transcribe(
        new Blob(chunks, { type: "audio/webm" }),
        target.value,
      );
      ui.input.value = response.result.text || "";
      ui.input.focus();
    } catch (err) {
      showError(err);
    } finally {
      ui.mic.disabled = false;
      ui.input.placeholder = "Ask anything, or say what to do…";
    }
  };
  recorder.start();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ui.send.addEventListener("click", send);
function stopRun() {
  state.stopRequested = true;
  // The flag alone is only read between steps, and a step is mostly one long
  // fetch. Aborting it makes Stop take effect now rather than in eight
  // seconds' time.
  abortAll();
}
ui.stop.addEventListener("click", stopRun);
ui.mic.addEventListener("click", toggleMic);
ui.status.addEventListener("click", refreshHealth);

ui.input.addEventListener("keydown", (event) => {
  // Enter sends, Shift+Enter is a newline -- the convention every chat client
  // uses, and the one people will try without being told.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
ui.input.addEventListener("input", () => {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 132)}px`;
});

for (const button of document.querySelectorAll("#suggestions button")) {
  button.addEventListener("click", () => {
    ui.input.value = button.textContent.trim();
    send();
  });
}

ui.newChat.addEventListener("click", () => {
  state.conversation = [];
  ui.thread.replaceChildren(ui.welcome);
  ui.welcome.hidden = false;
  clearError();
});

ui.warm.addEventListener("click", async () => {
  clearError();
  setStatus("busy", "loading models…");
  ui.warm.disabled = true;
  const note = addMessage("bot", "Loading the models. This takes a minute the first time.", { plain: true });
  try {
    // "all" rather than one: an answer needs the LLM, a translation needs the
    // translator, and the microphone needs ASR. Warming one still leaves two
    // multi-second loads inside the first real request.
    await client.load("all", target.value);
    note.bubble.textContent = "Models are warm.";
  } catch (err) {
    note.bubble.textContent = "Could not load the models.";
    showError(err);
  } finally {
    ui.warm.disabled = false;
    refreshHealth();
  }
});

ui.free.addEventListener("click", async () => {
  clearError();
  try {
    await client.unload("all");
    addMessage("bot", "Freed the model memory.", { plain: true });
  } catch (err) {
    showError(err);
  }
  refreshHealth();
});

ui.cache.addEventListener("click", async () => {
  clearError();
  try {
    const { cleared } = await client.clearCache();
    addMessage("bot", `Cleared ${cleared} cached translations.`, { plain: true });
  } catch (err) {
    showError(err);
  }
});

// Content the page rendered after the first translation pass -- infinite
// scroll, a SPA route change, a tab that renders on click. Handled here
// because only this side can reach the service.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "sl:new-segments") return;
  if (!state.translated || sender.tab?.id !== state.tabId) return;

  const card = state.liveCard;
  if (card) card.heading.textContent = `translating ${message.segments.length} more…`;

  translateNewSegments({
    tabId: state.tabId,
    client,
    segments: message.segments,
    source: "en",
    target: target.value,
    onCounts(counts) {
      if (!card) return;
      for (const key of Object.keys(card.totals)) card.totals[key] += counts[key] || 0;
      card.deferred = Math.max(0, card.deferred - message.segments.length);
      card.heading.textContent = card.deferred
        ? `${card.deferred} more as you scroll`
        : "whole page translated";
      card.counts.replaceChildren(
        el("span", "", "translated "), el("b", "", String(card.totals.translated)),
        el("span", "", " · cached "), el("b", "", String(card.totals.from_cache)),
        el("span", "", " · skipped "), el("b", "", String(card.totals.skipped)),
      );
    },
  }).catch(showError);
});

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  // A load destroys the content script and the ring with it. The ticker would
  // put it back within a few seconds; doing it here as well means the gap is
  // a frame rather than a pause, which matters because navigating IS what the
  // agent spends most of its time doing.
  if (tabId === state.glowTab) paintGlow();
  if (tabId === state.tabId) {
    state.translated = false; // a reload discards the translated DOM
    refreshTab();
  }
});

// Closing the side panel is the one way a run ends without setBusy(false).
// Best effort only -- the panel may be gone before the message lands, which
// is exactly why glow.js has a watchdog rather than trusting this.
window.addEventListener("pagehide", () => {
  if (state.glowTab != null) void hideGlow(state.glowTab);
});

async function boot() {
  await refreshTab();
  await refreshHealth();
  try {
    await loadLanguages();
  } catch (err) {
    showError(err);
  }

  // The context menu opens the panel and leaves its request in storage,
  // because at the moment it fires there is no panel listening for a message.
  const { pendingRequest } = await chrome.storage.session.get("pendingRequest");
  if (pendingRequest?.kind === "translate" && Date.now() - pendingRequest.at < 10_000) {
    await chrome.storage.session.remove("pendingRequest");
    ui.input.value = "Translate this page";
    send();
  }
  ui.input.focus();
}

boot();
