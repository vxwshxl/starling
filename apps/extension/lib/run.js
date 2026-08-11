// The two long-running jobs: translating a page, and driving one.
//
// Both live here rather than in panel.js so the UI file stays about the UI,
// and both are written the same way: a generator of events, driven by the
// caller, cancellable at any point. Nothing here touches the DOM of the panel
// and nothing here decides what an error looks like -- it reports, the panel
// renders.

import { call, inject, send, waitForLoad } from "./tabs.js";

const TRANSLATE_SCRIPT = "content/translate.js";
const AGENT_SCRIPT = "content/agent.js";

// ---------------------------------------------------------------------------
// Page translation
// ---------------------------------------------------------------------------

/** Segments per request to the service.
 *
 *  The first chunk is deliberately small. It is the one the user is waiting
 *  on -- it is the visible screen, because the content script sorted by
 *  viewport -- and a smaller first request means the page starts changing
 *  sooner. After that, bigger chunks amortise the HTTP round trip better and
 *  nobody is watching a specific one land.
 */
const FIRST_CHUNK = 10;
const CHUNK = 30;

function chunk(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const size = out.length === 0 ? FIRST_CHUNK : CHUNK;
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Translate everything on a tab, applying results as they arrive.
 *
 *  `onEvent` is called with {type, ...}:
 *    collected  {total}                       the page has been walked
 *    progress   {done, total, counts}         a chunk landed and was applied
 *    done       {counts}                      finished, or stopped early
 */
export async function runTranslation({
  tabId,
  client,
  source = "en",
  target,
  onEvent = () => {},
  shouldStop = () => false,
}) {
  const collected = await call(tabId, TRANSLATE_SCRIPT, { type: "sl:collect", target });
  const segments = collected.segments || [];
  onEvent({
    type: "collected",
    total: segments.length,
    // Everything below the runway. Reported so the panel can say the rest is
    // coming rather than showing a total that looks like the whole page.
    deferred: collected.deferred || 0,
    title: collected.title,
  });

  const totals = { translated: 0, from_cache: 0, skipped: 0, total: 0 };
  let done = 0;

  for (const group of chunk(segments)) {
    if (shouldStop()) break;

    const response = await client.translateBatch(group.map((s) => s.text), { source, target });
    const { translations, counts } = response.result;

    // Positional alignment is the contract with /translate/batch, and it is
    // worth asserting rather than trusting: a short reply written back by
    // index would put the wrong translation on every node after the gap, and
    // the page would look translated while being nonsense.
    if (translations.length !== group.length) {
      throw new Error(
        `The service returned ${translations.length} translations for ${group.length} segments.`,
      );
    }

    const updates = group.map((segment, i) => [segment.id, translations[i]]);
    await send(tabId, { type: "sl:apply", updates });

    for (const key of Object.keys(totals)) totals[key] += counts[key] || 0;
    done += group.length;
    onEvent({ type: "progress", done, total: segments.length, counts: totals });
  }

  onEvent({ type: "done", counts: totals, stopped: shouldStop() });
  return totals;
}

/** Translate segments the page added after the initial pass.
 *
 *  Same path, no re-walk: the content script already registered these and
 *  gave them ids, so this is only the fetch-and-apply half. */
export async function translateNewSegments({
  tabId,
  client,
  segments,
  source = "en",
  target,
  onCounts = () => {},
}) {
  const applied = [];
  for (const group of chunk(segments)) {
    const response = await client.translateBatch(group.map((s) => s.text), { source, target });
    const updates = group.map((segment, i) => [segment.id, response.result.translations[i]]);
    await send(tabId, { type: "sl:apply", updates });
    onCounts(response.result.counts);
    applied.push(...updates);
  }
  return applied.length;
}

export async function restoreTranslation(tabId) {
  return call(tabId, TRANSLATE_SCRIPT, { type: "sl:restore" });
}

/** Recognise "translate this page" without waking the model.
 *
 *  The agent can choose `translate_page` itself, and for anything phrased
 *  indirectly it has to. But that costs a decide() call -- two to eight
 *  seconds of Qwen -- to conclude what a regex settles instantly, and
 *  translating the page is the single most common thing anyone will type
 *  here. Making the commonest command the slowest one would be a strange
 *  choice.
 *
 *  Returns {target} when it is confident, or null to let the model decide.
 *  Deliberately conservative: "translate" plus optionally a language we know.
 *  Anything with more going on in it ("translate this and then find the
 *  contact page") falls through to the agent, which can sequence.
 */
export function detectTranslateIntent(text, languages) {
  const clean = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (clean.length > 60) return null;
  if (!/\b(translate|translation)\b/.test(clean)) return null;
  // A verb that implies more work than translating means it is not this.
  if (/\b(and|then|after|find|search|click|buy|add|open|go to)\b/.test(clean)) return null;

  const named = languages.find(
    (l) =>
      clean.includes(l.name.toLowerCase()) ||
      clean.includes(l.native_name.toLowerCase()),
  );
  return { target: named ? named.code : null };
}

/** Match a goal against the known-task recipes, client-side.
 *
 *  Mirrors tasks.match() on the service, over the list fetched from /tasks so
 *  the keywords are not duplicated. Client-side because the place this
 *  matters most is a page Chrome will not let us script -- the new tab page
 *  -- where there is nothing to read, and paying a model call just to work
 *  out that "download my aadhaar" means going to UIDAI would be silly.
 *
 *  Token containment, not a contiguous phrase: "download my aadhaar card"
 *  has to match the keyword "download aadhaar".
 */
export function matchTask(text, taskList) {
  const words = new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean),
  );
  let best = null;
  for (const task of taskList || []) {
    for (const keyword of task.keywords) {
      const tokens = keyword.split(" ");
      if (tokens.every((t) => words.has(t))) {
        const score = tokens.length * 100 + keyword.length;
        if (!best || score > best.score) best = { score, task };
      }
    }
  }
  return best?.task ?? null;
}

/** Any site named anywhere in the message.
 *
 *  This is the general form of what the task recipes do for a handful of
 *  known flows, and it is the part that must NOT be hardcoded. "buy me a
 *  formal shoe under 1000 from amazon.in" names where the work happens just
 *  as clearly as "go to amazon.in" does; an earlier version only recognised
 *  the second, so the agent obediently tried to buy shoes on the UIDAI page
 *  it happened to be sitting on.
 *
 *  Recognising the site is only half of it -- see `sameSite` below. Naming a
 *  site you are already on must NOT trigger a navigation, or every follow-up
 *  turn reloads the page and throws away the progress made on it.
 *
 *  An explicit TLD list rather than `[a-z]{2,}`, because the loose form
 *  matches things like "e.g" and any "word.word" in ordinary prose, and a
 *  spurious navigation is far more destructive than a missed one.
 */
const TLDS =
  "com|in|org|net|gov|edu|io|co|ai|app|dev|me|info|biz|shop|store|news|xyz|" +
  "uk|us|au|ca|de|fr|jp|cn|sg|ae";
const DOMAIN = new RegExp(
  String.raw`\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS})(?:\.[a-z]{2})?)\b(\/\S*)?`,
  "i",
);

/** "go to example.com" — an explicit instruction, with or without a TLD we know. */
const EXPLICIT = /^(?:go to|open|visit|navigate to|take me to|launch)\s+(\S+)/i;

export function detectNavigation(text) {
  const clean = text.trim();
  const explicit = EXPLICIT.exec(clean);
  if (explicit) {
    const raw = explicit[1].replace(/[.,;:!?]+$/, "");
    if (/^https?:\/\//i.test(raw)) return { url: raw, host: hostOf(raw) };
    if (DOMAIN.test(raw)) return { url: `https://${raw}`, host: hostOf(`https://${raw}`) };
    return null; // "go to the contact page" is a job for the agent, not a URL
  }
  if (/^https?:\/\/\S+$/i.test(clean)) return { url: clean, host: hostOf(clean) };

  // A site named inside a longer instruction.
  const match = DOMAIN.exec(clean);
  if (!match) return null;
  const url = `https://${match[1]}${match[2] || ""}`;
  return { url, host: hostOf(url) };
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Whether two URLs are the same site, on a dot boundary.
 *
 *  The boundary matters for more than tidiness: without it `uidai.gov.in`
 *  would count `uidai.gov.in.phish.example` as the same site and skip the
 *  navigation that would have taken the user off it.
 */
export function sameSite(a, b) {
  const x = hostOf(a);
  const y = hostOf(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/** Send a tab somewhere, without needing to script the page it is on.
 *
 *  `chrome.tabs.update` needs only the "tabs" permission, so this works from
 *  the new tab page and from chrome:// pages where injection is refused --
 *  which is exactly when it is needed. */
export async function goTo(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  return url;
}

/** Type a value into one field, without the model ever seeing it.
 *
 *  Used for the identifiers the service refuses to let the model produce --
 *  an Aadhaar number, an account number. The value goes from the panel's
 *  input straight to the content script and into the page. It is never part
 *  of an /agent/act payload.
 *
 *  The page is re-indexed first and the ref must still be a text field, for
 *  the same reason the purchase confirmation re-checks its label: the user
 *  took time to type, and the page may have moved on. Typing an Aadhaar
 *  number into whatever now occupies that position is the exact accident
 *  worth spending a round trip to avoid.
 */
export async function fillSecret(tabId, ref, value) {
  await inject(tabId, AGENT_SCRIPT);
  const fresh = await send(tabId, { type: "sl:index" });
  const target = (fresh.elements || []).find((e) => e.ref === ref);
  if (!target) {
    throw new Error("That field is no longer on the page — nothing was typed.");
  }
  if (!/^input:|^(textbox|searchbox|combobox|textarea)$/.test(target.role || "")) {
    throw new Error(`${ref} is a ${target.role}, not a text field — nothing was typed.`);
  }
  const result = await send(tabId, {
    type: "sl:execute",
    action: "type",
    args: { ref, text: value, submit: false },
  });
  if (!result.ok) throw new Error(result.error || "Could not type into that field.");
  return true;
}

/** Read the page without acting on it, for answering a question about it. */
export async function readPage(tabId) {
  await inject(tabId, AGENT_SCRIPT);
  return send(tabId, { type: "sl:index" });
}

/** Is this a question about the page, rather than an instruction to act?
 *
 *  Routing matters more than it looks: a question sent to the action loop
 *  gets answered by a prompt built to emit one JSON verb, and measured on
 *  Qwen2.5-3B that prompt answers questions by clicking a plausible link.
 *  Sent to /page/ask instead, the same model writes a full answer.
 *
 *  Kept to shapes that are unambiguously questions. An imperative that
 *  happens to contain a question word ("find out how much it costs") is not
 *  one of them -- that needs the page navigated, not read -- so a leading
 *  verb disqualifies the whole thing.
 */
const ACTION_VERBS =
  /^(find|search|go|open|click|buy|add|order|book|fill|log ?in|sign|scroll|navigate|show me the|take me|put|select|choose|download|apply|submit|send|pay|check ?out)\b/;

const QUESTION_OPENERS =
  /^(what|why|how|who|whom|whose|which|when|where|is|are|was|were|do|does|did|can|could|should|would|will|explain|tell me|summar|describe|list)\b/;

export function looksLikeQuestion(text) {
  const clean = text.trim().toLowerCase();
  if (!clean) return false;
  if (ACTION_VERBS.test(clean)) return false;
  if (QUESTION_OPENERS.test(clean)) return true;
  // A trailing question mark settles anything the openers missed, including
  // questions asked in a language this regex knows nothing about.
  return /[?？]\s*$/.test(clean);
}

/** The inverse, for "show the original" / "undo the translation". */
export function detectRestoreIntent(text) {
  const clean = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (clean.length > 60) return false;
  return /\b(show|revert|restore|undo|back to)\b.*\b(original|english|untranslated)\b/.test(clean)
    || /^(undo|revert|restore)( the)? translation$/.test(clean);
}

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

/** Hard ceiling on steps.
 *
 *  Not a performance number -- each step is several seconds of local model
 *  time, so twelve steps is already a minute or two. It is a containment
 *  number: an agent that has not achieved a browsing goal in twelve actions
 *  is lost, and the useful thing to do with a lost agent is stop and show the
 *  user where it got to.
 */
export const MAX_STEPS = 12;

/** Three identical actions in a row means stuck.
 *
 *  The prompt already tells the model not to repeat a failing action, and a
 *  3B model does it anyway -- reliably, on pages where the obvious button
 *  does nothing. Cheaper to detect here than to keep paying for. */
function isStuck(history) {
  if (history.length < 3) return false;
  const [a, b, c] = history.slice(-3);
  const key = (s) => `${s.action}:${JSON.stringify(s.args)}`;
  return key(a) === key(b) && key(b) === key(c);
}

/** Drive the browser towards `goal`.
 *
 *  `onEvent` is called with {type, ...}:
 *    step      {n, url, title, elements}   a page snapshot was taken
 *    decision  {n, decision}               the model chose an action
 *    acted     {n, outcome, label, error}  the page did it, or refused
 *    finished  {reason, decision}          terminal action, cap, or stop
 */
export async function runAgent({
  goal,
  language = "en",
  tabId,
  client,
  conversation = [],
  // Set when the user has just answered a confirmation with yes. The action
  // they approved is executed immediately, without asking the model again --
  // asking again would give it the chance to change its mind about what the
  // user consented to, which is not a property you want on a Place Order
  // button.
  preapproved = null,
  maxSteps = MAX_STEPS,
  onEvent = () => {},
  shouldStop = () => false,
}) {
  const history = [];

  if (preapproved) {
    await inject(tabId, AGENT_SCRIPT);
    // Re-index before executing: the content script may have been destroyed
    // while the user was deciding, and its ref map with it.
    const fresh = await send(tabId, { type: "sl:index" });

    // ...but re-indexing RENUMBERS. A confirmation is a round trip through a
    // human, and if the page re-rendered in the meantime, the element now
    // called e12 is not the one they said yes to. Since the only actions that
    // reach this path are the ones that spend money or cannot be undone,
    // "probably still the same button" is not good enough: verify the label
    // matches what was approved, and refuse rather than guess.
    const target = (fresh.elements || []).find((e) => e.ref === preapproved.args.ref);
    const approved = (preapproved.target_label || "").trim();
    if (approved && (!target || (target.name || "").trim() !== approved)) {
      const found = target ? `"${target.name}"` : "nothing";
      const decision = {
        action: "fail",
        message:
          `The page changed while you were deciding — ${preapproved.args.ref} is now ${found}, ` +
          `not "${approved}". I have not pressed anything. Ask me again if you still want it.`,
      };
      onEvent({ type: "finished", reason: "changed", decision });
      return { history, reason: "changed", decision };
    }

    const result = await send(tabId, {
      type: "sl:execute",
      action: preapproved.action,
      args: preapproved.args,
    }).catch(() => ({ ok: true, outcome: "the page navigated" }));
    onEvent({
      type: "acted",
      n: 0,
      outcome: result.outcome || "ok",
      label: result.label || "",
      error: result.ok ? null : result.error,
    });
    history.push({
      action: preapproved.action,
      args: preapproved.args,
      label: result.label || "",
      outcome: result.ok ? result.outcome || "ok" : `failed: ${result.error}`,
    });
    await waitForLoad(tabId);
  }

  for (let n = 1; n <= maxSteps; n++) {
    if (shouldStop()) {
      onEvent({ type: "finished", reason: "stopped" });
      return { history, reason: "stopped" };
    }

    // Re-injected every step, deliberately. The previous step may well have
    // navigated, which destroys the content script and its ref map with it;
    // re-indexing a fresh document is the only correct thing to do, and
    // injection is a no-op when the script survived.
    await inject(tabId, AGENT_SCRIPT);
    const snapshot = await send(tabId, { type: "sl:index" });
    if (!snapshot.ok) throw new Error(snapshot.error || "Could not read the page.");

    onEvent({
      type: "step",
      n,
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements.length,
    });

    const response = await client.act({
      goal,
      language,
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements,
      history,
      text: snapshot.text,
      conversation,
    });
    const decision = response.result;
    onEvent({ type: "decision", n, decision, timings: response.timings });

    // The backstop firing: the model wanted to click something that spends
    // money or cannot be undone. Stop and hand the decision back so the panel
    // can put a yes/no in the chat. Resuming happens via `preapproved`.
    if (decision.needs_confirmation) {
      onEvent({ type: "finished", reason: "confirm", decision });
      return { history, reason: "confirm", decision };
    }

    if (decision.terminal) {
      onEvent({ type: "finished", reason: decision.action, decision });
      return { history, reason: decision.action, decision };
    }

    let outcome = "ok";
    let label = "";
    let error = null;
    try {
      const result = await send(tabId, {
        type: "sl:execute",
        action: decision.action,
        args: decision.args,
      });
      if (result.ok) {
        outcome = result.outcome || "ok";
        label = result.label || "";
      } else {
        outcome = `failed: ${result.error}`;
        error = result.error;
      }
    } catch (err) {
      // A navigation can kill the content script before it answers. That is
      // a successful action, not a failure, and telling the model otherwise
      // makes it undo work it actually completed.
      outcome = "the page navigated";
      error = null;
      void err;
    }

    onEvent({ type: "acted", n, outcome, label, error });
    history.push({ action: decision.action, args: decision.args, label, outcome });

    if (isStuck(history)) {
      onEvent({ type: "finished", reason: "stuck" });
      return { history, reason: "stuck" };
    }

    await waitForLoad(tabId);
  }

  onEvent({ type: "finished", reason: "cap" });
  return { history, reason: "cap" };
}
