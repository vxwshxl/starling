// The side panel: all of the extension's actual behaviour.
//
// This runs the long jobs itself rather than delegating to the service worker.
// See background.js for why -- briefly, a worker is killed after ~30 seconds
// idle and the agent loop spends most of its life waiting, so a loop running
// there stops halfway through with no error.

import { ApiError, createClient } from "../lib/api.js";
import { TabError, activeTab, checkInjectable } from "../lib/tabs.js";
import {
  MAX_STEPS,
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
  statusText: $("status-text"),
  status: $("status"),
  source: $("source-language"),
  target: $("target-language"),
  caveat: $("language-caveat"),
  translateBtn: $("translate-btn"),
  restoreBtn: $("restore-btn"),
  progress: $("translate-progress"),
  fill: $("translate-fill"),
  translateStatus: $("translate-status"),
  translateStop: $("translate-stop"),
  counts: $("translate-counts"),
  countTranslated: $("count-translated"),
  countCache: $("count-cache"),
  countSkipped: $("count-skipped"),
  watch: $("watch-toggle"),
  goal: $("goal"),
  mic: $("mic-btn"),
  agentBtn: $("agent-btn"),
  agentStop: $("agent-stop"),
  agentLog: $("agent-log"),
  answer: $("agent-answer"),
  answerText: $("agent-answer-text"),
  answerEn: $("agent-answer-en"),
  error: $("error"),
  warm: $("warm-btn"),
  free: $("free-btn"),
  cache: $("cache-btn"),
  cacheSize: $("cache-size"),
  resident: $("resident"),
};

const state = {
  languages: [],
  tabId: null,
  translating: false,
  translated: false,
  agentRunning: false,
  stopTranslate: false,
  stopAgent: false,
  recorder: null,
  // Why the action buttons are off, if they are. Two independent reasons --
  // the tab cannot be scripted, and the language pair is not supported -- and
  // they are tracked separately because each is cleared by a different event.
  // Setting `disabled` directly from both places meant whichever ran last
  // won, so switching to a chrome:// page and back re-enabled the buttons on
  // a page they could not possibly work on.
  blockedReason: null,
  pairUnsupported: false,
};

function updateButtons() {
  const blocked = Boolean(state.blockedReason);
  ui.translateBtn.disabled = blocked || state.pairUnsupported || state.translating;
  ui.agentBtn.disabled = blocked || state.agentRunning;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function showError(err) {
  const message =
    err instanceof ApiError || err instanceof TabError
      ? err.message
      : `${err?.name || "Error"}: ${err?.message || err}`;
  ui.error.textContent = message;
  ui.error.hidden = false;
  console.error("[starling]", err);
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = "";
}

function setStatus(kind, text) {
  ui.statusDot.className = `dot ${kind}`;
  ui.statusText.textContent = text;
}

async function settings() {
  const stored = await chrome.storage.local.get({
    source: "en",
    target: "as",
    watch: true,
  });
  return stored;
}

function saveSettings() {
  return chrome.storage.local.set({
    source: ui.source.value,
    target: ui.target.value,
    watch: ui.watch.checked,
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function refreshTab() {
  try {
    const tab = await activeTab();
    state.tabId = tab.id;
    try {
      checkInjectable(tab.url);
      state.blockedReason = null;
      ui.pageTitle.textContent = tab.title || tab.url || "No page";
    } catch (err) {
      // Not an error worth a red box -- switching to a settings tab is a
      // normal thing to do. Just say why the buttons are off.
      state.blockedReason = err.message;
      ui.pageTitle.textContent = err.message;
    }
  } catch {
    state.tabId = null;
    state.blockedReason = "No active tab.";
  }
  updateButtons();
}

async function refreshHealth() {
  setStatus("busy", "checking");
  try {
    const health = await client.health();
    const models = health.models || {};
    const resident = Object.entries(models)
      .filter(([, value]) => value && typeof value === "object" && value.loaded)
      .map(([name]) => name);
    setStatus("ok", resident.length ? `${resident.length} model(s) warm` : "ready");
    ui.resident.textContent = resident.length
      ? `Resident: ${resident.join(", ")} · device ${models.device || "?"}`
      : "No models loaded yet. The first request pays the load cost.";
  } catch (err) {
    setStatus("bad", "offline");
    ui.resident.textContent = "";
    showError(err);
    return;
  }

  try {
    const { entries } = await client.cacheStatus();
    ui.cacheSize.textContent = entries ? `(${entries})` : "";
  } catch {
    /* the cache count is decoration; a failure here is not worth reporting */
  }
}

async function loadLanguages() {
  const { languages } = await client.languages();
  state.languages = languages;

  const stored = await settings();

  // Target: the six the service actually supports. Source: those plus
  // English, which is what almost every page in scope is written in.
  ui.target.innerHTML = "";
  ui.source.innerHTML = '<option value="en">English</option>';
  for (const language of languages) {
    const label = `${language.name} (${language.native_name})`;
    ui.target.append(new Option(label, language.code));
    ui.source.append(new Option(label, language.code));
  }
  ui.target.value = stored.target;
  ui.source.value = stored.source;
  ui.watch.checked = stored.watch;
  updateCaveat();
}

/** Say when the pair on screen is not a real translation pair.
 *
 *  Two separate cases and they are not interchangeable. Sylheti travels as
 *  Bengali because it is not a scheduled language, which degrades quality;
 *  Indic->Indic is refused outright because Sarvam's open checkpoint only does
 *  English on one side. Surfacing them here is cheaper than a 500 from the
 *  service after the user has waited for a model to load. */
function updateCaveat() {
  const source = ui.source.value;
  const target = ui.target.value;
  const notes = [];

  if (source !== "en" && target !== "en") {
    notes.push(
      "Sarvam-Translate only goes to and from English, so this pair will be refused. Set one side to English.",
    );
  }
  for (const code of [source, target]) {
    const language = state.languages.find((l) => l.code === code);
    if (language && language.native_name && !language.asr_native) {
      // Only relevant to the microphone, so it is worded that way.
      notes.push(`Speech input for ${language.name} is a fallback and will be unreliable.`);
    }
  }
  ui.caveat.textContent = notes.join(" ");
  ui.caveat.hidden = notes.length === 0;
  state.pairUnsupported = source !== "en" && target !== "en";
  updateButtons();
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function setTranslateBusy(busy) {
  state.translating = busy;
  ui.progress.hidden = !busy;
  ui.translateBtn.textContent = busy ? "Translating…" : "Translate this page";
  updateButtons();
}

function renderCounts(counts) {
  ui.counts.hidden = false;
  ui.countTranslated.textContent = counts.translated ?? 0;
  ui.countCache.textContent = counts.from_cache ?? 0;
  ui.countSkipped.textContent = counts.skipped ?? 0;
}

async function doTranslate() {
  clearError();
  await refreshTab();
  if (state.tabId == null) return showError(new TabError("No page to translate."));

  state.stopTranslate = false;
  setTranslateBusy(true);
  ui.fill.style.width = "0%";
  ui.translateStatus.textContent = "reading the page…";

  try {
    await runTranslation({
      tabId: state.tabId,
      client,
      source: ui.source.value,
      target: ui.target.value,
      shouldStop: () => state.stopTranslate,
      onEvent(event) {
        if (event.type === "collected") {
          ui.translateStatus.textContent = `${event.total} segments`;
        } else if (event.type === "progress") {
          const pct = Math.round((event.done / Math.max(event.total, 1)) * 100);
          ui.fill.style.width = `${pct}%`;
          ui.translateStatus.textContent = `${event.done} / ${event.total}`;
          renderCounts(event.counts);
        } else if (event.type === "done") {
          renderCounts(event.counts);
          state.translated = true;
          ui.restoreBtn.hidden = false;
        }
      },
    });
    setStatus("ok", "translated");
  } catch (err) {
    showError(err);
  } finally {
    setTranslateBusy(false);
    refreshHealth();
  }
}

async function doRestore() {
  clearError();
  try {
    await restoreTranslation(state.tabId);
    state.translated = false;
    ui.restoreBtn.hidden = true;
    ui.counts.hidden = true;
    ui.fill.style.width = "0%";
  } catch (err) {
    showError(err);
  }
}

// The content script reports content the page added after the first pass --
// infinite scroll, a tab that renders on click, a SPA route change. Handled
// here rather than in the content script because only this side can fetch.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "sl:new-segments") return;
  // `translating` as well as `translated`: a page that renders as it loads
  // fires mutations during the very first pass, and dropping those would
  // leave the content that arrived latest permanently in English -- with no
  // way to get it back, because the content script has already marked those
  // nodes as seen and will not report them a second time.
  if (!ui.watch.checked || !(state.translated || state.translating)) return;
  if (sender.tab?.id !== state.tabId) return;

  translateNewSegments({
    tabId: state.tabId,
    client,
    segments: message.segments,
    source: ui.source.value,
    target: ui.target.value,
  }).catch(showError);
});

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

function logRow(n, className, what, why, outcome) {
  const li = document.createElement("li");
  li.className = className;
  const index = document.createElement("span");
  index.className = "n";
  index.textContent = n ? `${n}` : "";
  const body = document.createElement("div");

  const line = document.createElement("div");
  line.className = "what";
  line.append(...what);
  body.append(line);

  if (why) {
    const reason = document.createElement("div");
    reason.className = "why";
    reason.textContent = why;
    body.append(reason);
  }
  if (outcome) {
    const result = document.createElement("div");
    result.className = "outcome";
    result.textContent = outcome;
    body.append(result);
  }
  li.append(index, body);
  ui.agentLog.append(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

function describe(decision) {
  const { action, args } = decision;
  const code = (text) => {
    const el = document.createElement("code");
    el.textContent = text;
    return el;
  };
  switch (action) {
    case "click": return [document.createTextNode("click "), code(args.ref)];
    case "type": return [document.createTextNode(`type “${args.text}” into `), code(args.ref)];
    case "select": return [document.createTextNode(`choose “${args.value}” in `), code(args.ref)];
    case "scroll": return [document.createTextNode(`scroll ${args.direction}`)];
    case "navigate": return [document.createTextNode(`go to ${args.url}`)];
    case "back": return [document.createTextNode("go back")];
    default: return [document.createTextNode(action)];
  }
}

function setAgentBusy(busy) {
  state.agentRunning = busy;
  ui.agentBtn.textContent = busy ? "Working…" : "Go";
  ui.agentStop.hidden = !busy;
  ui.goal.disabled = busy;
  updateButtons();
}

async function doAgent() {
  const goal = ui.goal.value.trim();
  if (!goal) return ui.goal.focus();

  clearError();
  await refreshTab();
  if (state.tabId == null) return showError(new TabError("No page to work on."));

  ui.agentLog.innerHTML = "";
  ui.answer.hidden = true;
  state.stopAgent = false;
  setAgentBusy(true);

  // The goal is in the user's language, so it is translated on the way in and
  // any closing message on the way out. Both legs happen in agent.py -- see
  // the English-pivot note there.
  const language = ui.source.value === "en" ? ui.target.value : ui.source.value;
  let thinking = null;

  try {
    await runAgent({
      goal,
      language,
      tabId: state.tabId,
      client,
      shouldStop: () => state.stopAgent,
      onEvent(event) {
        if (event.type === "step") {
          thinking = logRow(
            event.n,
            "thinking",
            [document.createTextNode(`thinking… (${event.elements} elements)`)],
            event.title,
          );
        } else if (event.type === "decision") {
          thinking?.remove();
          thinking = null;
          const { decision } = event;
          if (!decision.terminal) {
            logRow(event.n, "", describe(decision), decision.why);
          }
        } else if (event.type === "acted") {
          const last = ui.agentLog.lastElementChild;
          if (last) {
            if (event.error) last.classList.add("bad");
            const result = document.createElement("div");
            result.className = "outcome";
            result.textContent = event.error ? event.error : `→ ${event.label || event.outcome}`;
            last.querySelector("div").append(result);
          }
        } else if (event.type === "finished") {
          thinking?.remove();
          const { decision, reason } = event;
          if (decision?.message) {
            ui.answerText.textContent = decision.message;
            // The English is shown underneath whenever it differs, because a
            // user who reads some English can check the translation, and a
            // demo audience can follow what the model actually said.
            ui.answerEn.textContent =
              decision.message_en && decision.message_en !== decision.message
                ? decision.message_en
                : "";
            ui.answerEn.hidden = !ui.answerEn.textContent;
            ui.answer.hidden = false;
          } else if (reason === "cap") {
            logRow(null, "bad", [
              document.createTextNode(`Stopped after ${MAX_STEPS} steps without finishing.`),
            ]);
          } else if (reason === "stuck") {
            logRow(null, "bad", [
              document.createTextNode("Stopped: the same action was repeated three times."),
            ]);
          } else if (reason === "stopped") {
            logRow(null, "", [document.createTextNode("Stopped.")]);
          }
        }
      },
    });
  } catch (err) {
    showError(err);
  } finally {
    setAgentBusy(false);
    refreshHealth();
  }
}

// ---------------------------------------------------------------------------
// Voice input
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
  } catch {
    // A side panel can prompt for the microphone, but a denied or absent
    // device is common enough that it needs a real instruction rather than a
    // DOMException. Typing is always available.
    return showError(
      new Error(
        "No microphone access. Allow it for this extension in Chrome's site settings, or type the instruction instead.",
      ),
    );
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  state.recorder = recorder;
  ui.mic.classList.add("recording");
  ui.goal.placeholder = "Listening… press the microphone again to stop.";

  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    state.recorder = null;
    ui.mic.classList.remove("recording");
    ui.goal.placeholder = "Transcribing…";
    ui.mic.disabled = true;
    try {
      // ASR runs in the language the user is speaking, which is the non-English
      // side of the pair -- the same code the answer will come back in.
      const language = ui.source.value === "en" ? ui.target.value : ui.source.value;
      const response = await client.transcribe(new Blob(chunks, { type: "audio/webm" }), language);
      ui.goal.value = response.result.text || "";
    } catch (err) {
      showError(err);
    } finally {
      ui.mic.disabled = false;
      ui.goal.placeholder = "Tell me what to do on this page…";
    }
  };
  recorder.start();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll('[role="tab"]')) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      document.getElementById(other.dataset.panel).hidden = !selected;
    }
  });
}

ui.translateBtn.addEventListener("click", doTranslate);
ui.restoreBtn.addEventListener("click", doRestore);
ui.translateStop.addEventListener("click", () => { state.stopTranslate = true; });
ui.agentBtn.addEventListener("click", doAgent);
ui.agentStop.addEventListener("click", () => { state.stopAgent = true; });
ui.mic.addEventListener("click", toggleMic);
ui.status.addEventListener("click", refreshHealth);

ui.goal.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) doAgent();
});

for (const button of document.querySelectorAll("#examples button")) {
  button.addEventListener("click", () => {
    ui.goal.value = button.textContent.trim();
    ui.goal.focus();
  });
}

for (const control of [ui.source, ui.target]) {
  control.addEventListener("change", () => {
    updateCaveat();
    saveSettings();
  });
}
ui.watch.addEventListener("change", saveSettings);

ui.warm.addEventListener("click", async () => {
  clearError();
  setStatus("busy", "loading models");
  ui.warm.disabled = true;
  try {
    // "all" rather than one: translation needs the translator, the agent needs
    // the LLM, and the microphone needs ASR. Warming one still leaves two
    // multi-second loads inside the first real action.
    await client.load("all", ui.target.value);
  } catch (err) {
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
  } catch (err) {
    showError(err);
  }
  refreshHealth();
});

ui.cache.addEventListener("click", async () => {
  clearError();
  try {
    const { cleared } = await client.clearCache();
    ui.cacheSize.textContent = "";
    setStatus("ok", `cleared ${cleared}`);
  } catch (err) {
    showError(err);
  }
});

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === "complete") {
    // A reload discards the translated DOM along with everything else.
    state.translated = false;
    ui.restoreBtn.hidden = true;
    refreshTab();
  }
});

async function boot() {
  await refreshTab();
  await refreshHealth();
  try {
    await loadLanguages();
  } catch (err) {
    showError(err);
  }

  // The context menu opens the panel and leaves its request here, because at
  // the moment it fires there is no panel listening to message.
  const { pendingRequest } = await chrome.storage.session.get("pendingRequest");
  if (pendingRequest?.kind === "translate" && Date.now() - pendingRequest.at < 10_000) {
    await chrome.storage.session.remove("pendingRequest");
    doTranslate();
  }
}

boot();
