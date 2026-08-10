import type { LanguageInfo } from "@/lib/api";

export type Stage = "asr" | "tts";

/**
 * How well a stage actually covers a language.
 *
 * The API sends one boolean per stage, which collapses two very different
 * situations: "we point Whisper at Assamese and hope" (Bodo) versus "nothing
 * can do this at all" (Mizo ASR). The distinction matters a lot to anyone
 * reading this page, so it is recovered from the warning prose.
 */
export type CoverageLevel = "native" | "fallback" | "unavailable";

/**
 * Warning strings are built by Language.warnings() in
 * services/asr/starling/languages.py. This function is coupled to that prose,
 * which is why it fails soft: an unrecognised warning is reported as a
 * fallback rather than throwing or silently claiming native support.
 */
export function coverageOf(lang: LanguageInfo, stage: Stage): CoverageLevel {
  if (stage === "asr" ? lang.asr_native : lang.tts_native) return "native";

  const unavailable = stage === "asr" ? "Transcription is" : "Synthesis is";
  if (lang.warnings.some((w) => w.includes(`${unavailable} unavailable`))) {
    return "unavailable";
  }
  return "fallback";
}

export const COVERAGE_LABEL: Record<CoverageLevel, string> = {
  native: "native",
  fallback: "fallback",
  unavailable: "none",
};

export const COVERAGE_BADGE: Record<
  CoverageLevel,
  "success" | "warning" | "destructive"
> = {
  native: "success",
  fallback: "warning",
  unavailable: "destructive",
};

/** True when any stage of any language is running on something it should not. */
export function hasAnyCaveat(languages: LanguageInfo[]): boolean {
  return languages.some((lang) => lang.warnings.length > 0);
}
