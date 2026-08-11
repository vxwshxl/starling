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

import { ApiError, createClient } from "../lib/api.js";
import { TabError, activeTab, checkInjectable } from "../lib/tabs.js";
import {
  MAX_STEPS,
  detectNavigation,
  detectRestoreIntent,
  detectTranslateIntent,
  fillSecret as fillSecretIn,
  goTo,
  hostOf,
  matchTask,
  sameSite,
  looksLikeQuestion,
  readPage,
  restoreTranslation,
  runAgent,
  runTranslation,
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
  tasks: [],
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
    setLabel(text) { label.textContent = text; },
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

const SPEAKER_PATH =
  "M11 5 6 9H2v6h4l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M19 5a9 9 0 0 1 0 14";

function speakerIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of SPEAKER_PATH.trim().split(" M")) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d.startsWith("M") ? d : `M${d}`);
    svg.append(path);
  }
  return svg;
}

/** Attach a "Listen" control to a finished answer. */
function addSpeakButton(container, text, language) {
  if (!text || !text.trim()) return;

  const row = el("div", "speak-row");
  const button = el("button", "speak");
  button.type = "button";
  const caption = el("span", "", "Listen");
  button.append(speakerIcon(), caption);
  const note = el("span", "speak-note", "");
  row.append(button, note);

  let audio = null;
  let ticker = null;

  const reset = (label) => {
    clearInterval(ticker);
    caption.textContent = label;
    button.disabled = false;
  };

  button.addEventListener("click", async () => {
    // Second press stops playback rather than queueing another synthesis.
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      reset("Listen");
      return;
    }
    if (audio) {
      audio.play();
      reset("Stop");
      return;
    }

    button.disabled = true;
    note.textContent = "";
    const started = Date.now();
    caption.textContent = "Synthesising…";
    ticker = setInterval(() => {
      caption.textContent = `Synthesising… ${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);

    try {
      const { result } = await client.speak(text, language);
      audio = new Audio(client.audioUrl(result.audio_path));
      audio.addEventListener("ended", () => reset("Listen again"));
      await audio.play();
      reset("Stop");
      // The service attaches a caveat when synthesis was not local -- that
      // the voice is not cloned and the text left the machine. Both of
      // Starling's headline claims are false in that mode, so it is shown,
      // not swallowed.
      if (result.warnings?.length) note.textContent = result.warnings.join(" ");
    } catch (err) {
      reset("Listen");
      showError(err);
    }
  });

  container.append(row);
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

function setBusy(busy) {
  state.busy = busy;
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  ui.input.disabled = busy;
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

    option.append(tick, el("span", "native", language.native_name), el("span", "latin", language.name));
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

/** Where, if anywhere, this instruction needs to happen.
 *
 *  One rule for every case, rather than a special path per known site. In
 *  order of how specific the signal is:
 *
 *    1. a recipe from tasks.py -- "download my aadhaar" names no URL, so the
 *       destination has to come from somewhere, and a guessed government URL
 *       is how people land on lookalike sites;
 *    2. any site named in the message -- "buy me a formal shoe under 1000
 *       from amazon.in", "go to flipkart.com". This is the general case and
 *       the reason none of it is hardcoded per site.
 *
 *  Returns null when the instruction is about wherever we already are, which
 *  is the common case and must stay cheap: no model call, no navigation, no
 *  losing the state built up on the current page.
 */
function destinationFor(text, currentUrl) {
  const task = matchTask(text, state.tasks);
  const target_ = task ? { url: task.url, label: task.name } : null;
  const mentioned = target_ || detectNavigation(text);
  if (!mentioned) return null;
  // Already there. Navigating anyway would reload the page and discard
  // whatever the last few turns achieved on it -- and every follow-up like
  // "now add it to the cart" mentions nothing, so this is the guard that
  // keeps a multi-turn task on one page.
  if (sameSite(mentioned.url, currentUrl)) return null;
  return { url: mentioned.url, label: mentioned.label || hostOf(mentioned.url) };
}

/** What to do when Chrome will not let us script the current tab.
 *
 *  The new tab page, chrome://, the Web Store, PDFs. This used to be a dead
 *  end -- every message got "Chrome does not allow extensions to run on this
 *  page" -- which is true and useless, and it is exactly where somebody
 *  starts a task from. The restriction is real and cannot be worked around,
 *  but almost nothing here actually needs the page:
 *
 *    a known task     navigate to its official URL, then carry on normally
 *    "go to X"        navigate there, then carry on normally
 *    anything else    answer it with POST /chat, which needs no page at all
 *
 *  Only translating and questions *about this page* are genuinely impossible,
 *  and those say so.
 */
async function doBlockedPage(text, turn) {
  // Navigation first, and it costs no model call.
  const nav = destinationFor(text, "about:blank");

  if (nav) {
    turn.setLabel(`Opening ${nav.label}…`);
    await goTo(state.tabId, nav.url);
    await refreshTab();
    if (state.blocked) {
      turn.finish("Could not open that", state.blocked);
      return;
    }
    // On a real page now, so the ordinary agent loop takes over with the
    // original goal intact.
    turn.setLabel("Opened. Working…");
    await doAgent(text, turn);
    return;
  }

  if (detectTranslateIntent(text, state.languages) || looksLikeQuestion(text)) {
    // A question could still be a general one rather than a page one, so it
    // is answered rather than refused -- but say why the page was not read.
    turn.setLabel("Answering…");
    const { result } = await client.chat(text, target.value);
    turn.finish("Answered", result.text, result.text_en, target.value);
    state.conversation.push({ role: "assistant", text: redact(result.text_en || result.text) });
    if (!state.blocked) return;
    ui.thread.append(
      el("p", "hint", "Chrome does not allow extensions to read this page, so that was answered without it. Open an ordinary site to ask about a page or translate it."),
    );
    scrollDown();
    return;
  }

  turn.setLabel("Answering…");
  const { result } = await client.chat(text, target.value);
  turn.finish("Answered", result.text, result.text_en, target.value);
  state.conversation.push({ role: "assistant", text: redact(result.text_en || result.text) });
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

async function doAgent(goal, turn, { preapproved = null } = {}) {
  turn.setLabel("Thinking…");
  let stepCount = 0;

  const result = await runAgent({
    goal,
    language: target.value,
    tabId: state.tabId,
    client,
    conversation: state.conversation,
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
        await doAgent(goal, next, { preapproved: result.decision });
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
        await doAgent(goal, next);
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
  if (!text || state.busy) return;

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
    // Chrome forbids scripting some pages. That is not a reason to refuse --
    // navigating away and general answering both still work. See
    // doBlockedPage().
    if (state.blocked) {
      await doBlockedPage(text, turn);
      return;
    }

    // If the instruction names somewhere else -- a recipe, or just a domain
    // mentioned in passing -- go there first. See destinationFor().
    const dest = destinationFor(text, (await activeTab()).url);
    if (dest) {
      turn.setLabel(`Opening ${dest.label}…`);
      await goTo(state.tabId, dest.url);
      await refreshTab();
      await doAgent(text, turn);
      return;
    }

    // Fast paths first. Both are the commonest things anyone types here and
    // both are settled by a regex, so paying two to eight seconds of Qwen to
    // reach the same conclusion would make the most common command the
    // slowest one. Anything ambiguous falls through to the agent.
    if (detectRestoreIntent(text)) {
      await restoreTranslation(state.tabId);
      state.translated = false;
      turn.finish("Restored", "Put the original page back.");
      return;
    }
    const translate = detectTranslateIntent(text, state.languages);
    if (translate) {
      const wanted = translate.target || target.value;
      if (translate.target) target.value = wanted;
      await doTranslate(turn, wanted);
      return;
    }
    // A question is read, not acted on. Routing it here rather than into the
    // agent loop is what makes answers long and accurate -- see
    // looksLikeQuestion() and PAGE_QA_PROMPT.
    if (looksLikeQuestion(text)) {
      await doAsk(text, turn);
      return;
    }
    await doAgent(text, turn);
  } catch (err) {
    turn.finish("Stopped", null);
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
ui.stop.addEventListener("click", () => { state.stopRequested = true; });
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
  if (tabId === state.tabId && info.status === "complete") {
    state.translated = false; // a reload discards the translated DOM
    refreshTab();
  }
});

async function boot() {
  await refreshTab();
  await refreshHealth();
  try {
    await loadLanguages();
    state.tasks = (await client.tasks()).tasks || [];
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
