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
