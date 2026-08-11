/**
 * Client for the Python speech service.
 *
 * Types here mirror services/asr/starling/main.py. That service owns the
 * shapes; if an endpoint changes there, change it here too.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_STARLING_API ?? "http://127.0.0.1:8000";

/**
 * The Gradio lab. Not part of this app -- a separate process started with
 * `pnpm lab` -- so it is only ever linked to, never fetched. Its liveness
 * cannot be probed from here: Gradio does not send CORS headers for this
 * origin, so a fetch would fail even when the lab is running fine.
 */
export const LAB_URL =
  process.env.NEXT_PUBLIC_STARLING_LAB ?? "http://127.0.0.1:7860";

/** GET /health -- cheap liveness probe. Never loads a model. */
export type Health = {
  status: string;
  service: string;
  version: string;
  /** Enabled language codes, in the brief's priority order. */
  languages: string[];
  models: {
    device: string;
    asr: { backend: string; model: string; loaded: boolean };
    /**
     * `sample_rate` is OmniVoice's real output rate once loaded, and the
     * configured default before that. It is 24 kHz, not the 16 kHz the rest
     * of the pipeline runs at.
     */
    tts: {
      model: string;
      loaded: boolean;
      sample_rate: number;
      /** OmniVoice denoising steps. Cost is linear in this. */
      num_step?: number;
      /** Which engine synthesis uses unless a request overrides it. */
      backend?: TTSBackend;
      /** False when MODAL_TTS_URL is unset, so the cloud toggle cannot work. */
      modal_configured?: boolean;
    };
    /** Both are mlx-lm and load outside the ASR/TTS loader machinery. */
    llm?: { model: string; loaded: boolean };
    translate?: { model: string; loaded: boolean };
  };
};

/** One entry of Health.models.asr.resident. */
export type ResidentModel = { backend: string; model: string };

export type ModelTarget = "asr" | "tts" | "llm" | "translate" | "all";

/**
 * Where speech is synthesised.
 *
 *   local  OmniVoice on this CPU. Clones the speaker's voice, stays offline,
 *          and runs at ~6x real time -- half a minute for a short answer.
 *   modal  A serverless GPU. ~0.55x real time, so roughly ten times faster,
 *          but it cannot clone and the text leaves the machine.
 */
export type TTSBackend = "local" | "modal";

async function post<T>(path: string, body?: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    // The service reports failures as {"detail": "..."}; surface that rather
    // than a bare status code, since these are usually model-load errors.
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/** Warm a model deliberately, instead of the first request absorbing the cost. */
export function loadModel(target: ModelTarget, language: string) {
  const form = new FormData();
  form.set("language", language);
  return post<{ models: Health["models"] }>(`/models/${target}/load`, form);
}

export function unloadModel(target: ModelTarget) {
  return post<{ freed: Record<string, boolean>; models: Health["models"] }>(
    `/models/${target}/unload`,
  );
}

/** A passage the answer was built from. Empty list means the answer was refused. */
export type Source = {
  id: string;
  title: string;
  sector: string;
  score: number;
};

/**
 * Where the reply came from. `grounded` cannot carry this on its own: a
 * greeting and a general-knowledge answer are both ungrounded, and only one of
 * them needs a "nothing behind this" caveat.
 *
 *   answer      built from retrieved passages, carries `sources`
 *   general     the model's own knowledge, nothing behind it
 *   small_talk  fixed text, no model involved
 */
export type ChatKind = "answer" | "general" | "small_talk";

export type ChatResult = {
  /** The answer in the language it was asked in. This is what gets spoken. */
  text: string;
  /** The same answer before the return translation, for checking against. */
  text_en: string;
  /** False when the text did not come from retrieved passages. */
  grounded: boolean;
  kind: ChatKind;
  language: string;
  warnings: string[];
  sources: Source[];
};

export type Timings = Record<string, number>;

/** POST /chat -- retrieval-grounded answer from the offline knowledge base. */
export async function askChat(
  question: string,
  language: string,
  signal?: AbortSignal,
): Promise<{ result: ChatResult; timings: Timings }> {
  const form = new FormData();
  form.set("question", question);
  form.set("language", language);
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    body: form,
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

/** POST /asr -- transcribe a recording in the given language. */
export async function transcribe(
  audio: Blob,
  language: string,
  signal?: AbortSignal,
): Promise<{ result: { text: string; warnings: string[] }; timings: Timings }> {
  const form = new FormData();
  // The service normalises whatever it is handed to 16 kHz mono WAV, so the
  // browser's native recording format is fine to send as-is.
  form.set("audio", audio, "recording.webm");
  form.set("language", language);
  const res = await fetch(`${API_BASE}/asr`, {
    method: "POST",
    body: form,
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

/**
 * POST /tts -- returns a playable URL for the generated WAV.
 *
 * The service replies with `audio_path`, a path on its own filesystem, and
 * serves the file separately from GET /audio/{name}. So the basename is the
 * handle, not the path.
 */
export async function synthesize(
  text: string,
  language: string,
  backend: TTSBackend = "local",
  signal?: AbortSignal,
): Promise<{
  url: string;
  sampleRate: number;
  backend: string;
  warnings: string[];
}> {
  const form = new FormData();
  form.set("text", text);
  form.set("language", language);
  form.set("backend", backend);
  const res = await fetch(`${API_BASE}/tts`, {
    method: "POST",
    body: form,
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  const data = (await res.json()) as {
    result: {
      audio_path: string;
      sample_rate: number;
      backend: string;
      warnings: string[];
    };
  };
  const name = data.result.audio_path.split("/").pop();
  if (!name) throw new Error("Synthesis returned no audio file");
  return {
    url: `${API_BASE}/audio/${encodeURIComponent(name)}`,
    sampleRate: data.result.sample_rate,
    backend: data.result.backend,
    warnings: data.result.warnings ?? [],
  };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: string };
    if (j.detail) return j.detail;
  } catch {
    /* non-JSON body; fall through to the status */
  }
  return `HTTP ${res.status}`;
}

/** One entry from GET /languages. */
export type LanguageInfo = {
  code: string;
  name: string;
  native_name: string;
  iso: string;
  script: string;
  script_name: string;
  /** False means the stage runs on a stand-in language and will degrade. */
  asr_native: boolean;
  tts_native: boolean;
  /** Human-readable caveats. Empty when the language is fully covered. */
  warnings: string[];
};

export type LanguagesResponse = {
  default: string;
  languages: LanguageInfo[];
};

/**
 * Ceiling on the cheap GETs.
 *
 * Neither /health nor /languages touches a model, so either one taking this
 * long means the service is wedged -- or, far more often in practice, that
 * MLX is mid-generation and holding the GIL, starving the thread that would
 * serve them. Without a deadline those requests hang indefinitely and the UI
 * sits on a loading skeleton forever with nothing to retry.
 */
const GET_TIMEOUT_MS = 12_000;

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(GET_TIMEOUT_MS);
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const getHealth = (signal?: AbortSignal) =>
  getJSON<Health>("/health", signal);

export const getLanguages = (signal?: AbortSignal) =>
  getJSON<LanguagesResponse>("/languages", signal);

/**
 * fetch() rejects with a bare "Failed to fetch" when the service is simply
 * not running, which is the single most likely case in local dev and tells
 * the reader nothing. Translate it.
 */
export function describeError(err: unknown): string {
  if (err instanceof TypeError) return `No response from ${API_BASE}`;
  if (err instanceof DOMException && err.name === "TimeoutError") {
    // Almost always the service being busy generating rather than dead --
    // saying "timed out" invites a retry, "no response" invites a restart.
    return "The speech service did not answer in time. It may be busy.";
  }
  return err instanceof Error ? err.message : String(err);
}
