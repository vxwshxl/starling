// The Starling service, as seen from the extension.
//
// Everything here talks to http://127.0.0.1:8000 and nowhere else. That is the
// whole privacy claim of this extension, and it is enforced twice: the
// manifest's connect-src allows only loopback, so a mistake here fails at the
// CSP rather than quietly reaching the internet.
//
// NOTE the service must allow chrome-extension:// as a CORS origin. A fetch
// from an extension page carries its own extension origin, not a loopback one,
// so without that widening in main.py every call here fails preflight -- and
// it surfaces as a bare "Failed to fetch" with nothing pointing at CORS.

export const DEFAULT_BASE = "http://127.0.0.1:8000";

/** Thrown for anything the service could not do. Carries the stage so the
 *  panel can say "the model is not loaded" rather than "error". */
export class ApiError extends Error {
  constructor(message, { status = 0, offline = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.offline = offline;
  }
}

async function request(base, path, { method = "GET", body, timeoutMs } = {}) {
  const controller = new AbortController();
  // No timeout by default, deliberately. A first translation pays a ~2.6 GB
  // model load and a first agent step pays ~1.8 GB more; any timeout short
  // enough to be useful for a hung request is short enough to kill a cold
  // start, and killing a cold start looks exactly like the service being
  // broken. Callers that genuinely need a deadline pass one.
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError(`The service did not answer in time (${path}).`, {
        offline: true,
      });
    }
    throw new ApiError(
      `Cannot reach the Starling service at ${base}. Start it with \`pnpm dev:api\`.`,
      { offline: true },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    // The service returns its real error text in `detail` -- see _fail() in
    // main.py. Surfacing it beats "500", because the usual causes (a model
    // that will not load, an unsupported language) are all self-explanatory
    // in that string.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data && data.detail) detail = data.detail;
    } catch {
      /* a non-JSON error body is still just the status */
    }
    throw new ApiError(detail, { status: response.status });
  }
  return response.json();
}

export function createClient(base = DEFAULT_BASE) {
  return {
    base,

    /** Liveness plus what is resident. Never loads a model, so it is safe to
     *  poll. Given a short timeout because an unreachable service should be
     *  reported in a moment, not eventually. */
    health: () => request(base, "/health", { timeoutMs: 4000 }),

    languages: () => request(base, "/languages", { timeoutMs: 8000 }),

    /** Warm models deliberately. `target` is asr | tts | llm | translate | all. */
    load: (target, language) =>
      fetch(`${base}/models/${target}/load`, {
        method: "POST",
        body: new URLSearchParams({ language: language || "as" }),
      }).then((r) => r.json()),

    unload: (target = "all") =>
      fetch(`${base}/models/${target}/unload`, { method: "POST" }).then((r) => r.json()),

    /** Page segments in, translations out, positionally aligned. */
    translateBatch: (segments, { source = "en", target, useCache = true }) =>
      request(base, "/translate/batch", {
        method: "POST",
        body: { segments, source, target, use_cache: useCache },
      }),

    translateOne: (text, { source = "en", target }) =>
      request(base, "/translate", { method: "POST", body: { text, source, target } }),

    cacheStatus: () => request(base, "/translate/cache", { timeoutMs: 4000 }),
    clearCache: () => request(base, "/translate/cache/clear", { method: "POST" }),

    /** One browsing action from one page snapshot. The loop is the caller's. */
    act: (payload) => request(base, "/agent/act", { method: "POST", body: payload }),

    /** A long answer about the page, with no action considered. */
    ask: (payload) => request(base, "/page/ask", { method: "POST", body: payload }),

    /** The known-task recipes, so the panel can match them without a model. */
    tasks: () => request(base, "/tasks", { timeoutMs: 8000 }),

    /** Starling's own answering path, for when there is no page to read.
     *
     *  Reuses POST /chat -- the same retrieval-and-generate cascade the web
     *  app uses, with small talk and both translation legs already handled.
     *  On a page Chrome forbids scripting, this is the only thing that can
     *  answer at all, and it answers rather well. */
    async chat(question, language) {
      const form = new URLSearchParams({ question, language });
      const response = await fetch(`${base}/chat`, { method: "POST", body: form });
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          detail = (await response.json()).detail || detail;
        } catch {
          /* keep the status */
        }
        throw new ApiError(detail, { status: response.status });
      }
      return response.json();
    },

    /** Text -> speech, via OmniVoice. Multipart, not JSON.
     *
     *  No reference audio is sent, so this is OmniVoice's default voice
     *  rather than a clone of the user's. Cloning needs a recording of the
     *  speaker plus its transcript, and the panel only has one when the user
     *  actually spoke -- see the note at the call site.
     *
     *  Returns the result object; `audio_path` is a filename to fetch from
     *  /audio/{name}. */
    async speak(text, language, { backend } = {}) {
      const form = new FormData();
      form.append("text", text);
      form.append("language", language);
      if (backend) form.append("backend", backend);
      const response = await fetch(`${base}/tts`, { method: "POST", body: form });
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          detail = (await response.json()).detail || detail;
        } catch {
          /* keep the status */
        }
        throw new ApiError(detail, { status: response.status });
      }
      return response.json();
    },

    audioUrl: (name) => `${base}/audio/${name}`,

    /** Speech in the user's own language -> text. Multipart, not JSON. */
    async transcribe(blob, language) {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      form.append("language", language);
      const response = await fetch(`${base}/asr`, { method: "POST", body: form });
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          detail = (await response.json()).detail || detail;
        } catch {
          /* keep the status */
        }
        throw new ApiError(detail, { status: response.status });
      }
      return response.json();
    },
  };
}
