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
  onEvent({ type: "collected", total: segments.length, title: collected.title });

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
export async function translateNewSegments({ tabId, client, segments, source = "en", target }) {
  const applied = [];
  for (const group of chunk(segments)) {
    const response = await client.translateBatch(group.map((s) => s.text), { source, target });
    const updates = group.map((segment, i) => [segment.id, response.result.translations[i]]);
    await send(tabId, { type: "sl:apply", updates });
    applied.push(...updates);
  }
  return applied.length;
}

export async function restoreTranslation(tabId) {
  return call(tabId, TRANSLATE_SCRIPT, { type: "sl:restore" });
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
  maxSteps = MAX_STEPS,
  onEvent = () => {},
  shouldStop = () => false,
}) {
  const history = [];

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
    });
    const decision = response.result;
    onEvent({ type: "decision", n, decision, timings: response.timings });

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
