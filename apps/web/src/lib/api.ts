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
    tts: { model: string; loaded: boolean; sample_rate: number };
  };
};

/** One entry of Health.models.asr.resident. */
export type ResidentModel = { backend: string; model: string };

export type ModelTarget = "asr" | "tts";

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

export function unloadModel(target: ModelTarget | "all") {
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

export type ChatResult = {
  text: string;
  /** False when nothing matched and a fixed refusal was returned. */
  grounded: boolean;
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
  signal?: AbortSignal,
): Promise<{ url: string; sampleRate: number; warnings: string[] }> {
  const form = new FormData();
  form.set("text", text);
  form.set("language", language);
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
      warnings: string[];
    };
  };
  const name = data.result.audio_path.split("/").pop();
  if (!name) throw new Error("Synthesis returned no audio file");
  return {
    url: `${API_BASE}/audio/${encodeURIComponent(name)}`,
    sampleRate: data.result.sample_rate,
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

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", signal });
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
  return err instanceof Error ? err.message : String(err);
}
