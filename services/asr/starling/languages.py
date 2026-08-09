"""The single source of truth for which languages Starling supports.

INVARIANT: no language code is ever hardcoded in pipeline logic. Every stage
asks this module. Adding a language means editing this file and nothing else.

ASR and TTS do NOT cover the same languages, so each language carries a
separate code and a separate "is this real?" flag for each stage. Verified
against the installed packages, not assumed:

  ASR  mlx_whisper.tokenizer.LANGUAGES -- 100 languages. Has `as` and `bn`.
       Has NO code for Bodo, Khasi or Mizo.
  TTS  omnivoice.utils.lang_map.LANG_IDS -- 646 languages. Has `as`, `bn`,
       AND `brx` (Bodo) and `lus` (Mizo). Has NO Khasi, no Sylheti.

So Bodo is asymmetric: we cannot recognise it but we CAN speak it natively.
Bodo is Tibeto-Burman, not Indo-Aryan, so pointing Whisper at Assamese for it
is a genuine hack that will produce mangled transcripts. It is wired up so the
demo path exists end to end, and flagged loudly in the lab UI so nobody
mistakes fallback output for real recognition. The fix is the phase-2 swap to
ai4bharat/indic-conformer-600m-multilingual, which covers Assamese and Bodo
properly. When that lands, `asr_native` flips to True and nothing else in the
codebase changes.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str
    """Starling's internal key. Stable; used in API payloads and the UI."""

    name: str
    """English name, shown in dropdowns."""

    native_name: str
    """Endonym, in its own script."""

    iso: str
    """ISO 639 code as specified in the project brief."""

    script: str
    """ISO 15924 script code. Beng = Bengali-Assamese, Deva = Devanagari."""

    script_name: str

    asr_code: str | None
    """Language code passed to the ASR backend, or None if nothing fits."""

    asr_native: bool
    """True when asr_code really is this language. False means fallback."""

    tts_code: str | None
    """Language code passed to OmniVoice, or None if it cannot speak this."""

    tts_native: bool
    """True when tts_code really is this language. False means fallback."""

    priority: int
    """Brief's priority order. 1 is highest."""

    enabled: bool = True
    """False keeps a language configured but out of the UI and API."""

    notes: str = ""

    @property
    def label(self) -> str:
        """Human-facing label for dropdowns."""
        return f"{self.name} ({self.native_name})"

    @property
    def needs_asr_warning(self) -> bool:
        return self.asr_code is None or not self.asr_native

    @property
    def needs_tts_warning(self) -> bool:
        return self.tts_code is None or not self.tts_native

    def warnings(self) -> list[str]:
        """Human-readable caveats to surface in the UI. Empty when all is well."""
        out: list[str] = []
        if self.asr_code is None:
            out.append(f"No ASR backend covers {self.name}. Transcription is unavailable.")
        elif not self.asr_native:
            out.append(
                f"ASR FALLBACK: Whisper has no {self.name} model, so audio is being "
                f"recognised as '{self.asr_code}'. Transcripts will be unreliable."
            )
        if self.tts_code is None:
            out.append(f"OmniVoice cannot speak {self.name}. Synthesis is unavailable.")
        elif not self.tts_native:
            out.append(
                f"TTS FALLBACK: OmniVoice has no {self.name} voice, synthesising as "
                f"'{self.tts_code}'. Pronunciation will be approximate."
            )
        return out


LANGUAGES: dict[str, Language] = {
    "as": Language(
        code="as",
        name="Assamese",
        native_name="অসমীয়া",
        iso="as",
        script="Beng",
        script_name="Bengali-Assamese",
        asr_code="as",
        asr_native=True,
        tts_code="as",
        tts_native=True,
        priority=1,
    ),
    "brx": Language(
        code="brx",
        name="Bodo",
        native_name="बर'",
        iso="brx",
        script="Deva",
        script_name="Devanagari",
        # Whisper has no Bodo. Assamese is the least-bad regional stand-in,
        # and it at least shares the Brahmaputra valley's loan vocabulary.
        asr_code="as",
        asr_native=False,
        # OmniVoice DOES have Bodo natively (brx is in LANG_IDS), so the
        # speaking half of the pipeline is genuine even though the listening
        # half is a stand-in.
        tts_code="brx",
        tts_native=True,
        priority=2,
        notes=(
            "Bodo is written in DEVANAGARI, not Bengali script. Whisper has no "
            "Bodo code, so ASR falls back to Assamese and transcripts will be "
            "poor; fixed by the indic-conformer swap. TTS is native."
        ),
    ),
    "syl": Language(
        code="syl",
        name="Sylheti / Barak Valley Bengali",
        native_name="সিলেটি",
        # The brief treats this as a Bengali dialect variant, so iso is "bn".
        # (ISO 639-3 does assign Sylheti its own code, "syl", but no model we
        # use recognises it, and the brief's framing is the operative one.)
        iso="bn",
        script="Beng",
        script_name="Bengali-Assamese",
        asr_code="bn",
        asr_native=True,
        # OmniVoice has no Sylheti; standard Bengali is the closest voice.
        tts_code="bn",
        tts_native=False,
        priority=3,
        notes=(
            "Handled as a Bengali dialect. Whisper's 'bn' is standard Bengali, "
            "so heavily dialectal Sylheti speech will degrade. OmniVoice has no "
            "Sylheti either; output is Bengali-accented."
        ),
    ),
    "kha": Language(
        code="kha",
        name="Khasi",
        native_name="Ka Ktien Khasi",
        iso="kha",
        script="Latn",
        script_name="Latin",
        asr_code=None,
        asr_native=False,
        tts_code=None,
        tts_native=False,
        priority=4,
        enabled=False,  # stretch goal, off until a backend can actually do it
        notes=(
            "Stretch goal, currently unreachable: neither Whisper nor OmniVoice "
            "covers Khasi. If you want a hill language for the demo, use Mizo "
            "below -- OmniVoice can at least speak it."
        ),
    ),
    "lus": Language(
        code="lus",
        name="Mizo",
        native_name="Mizo ṭawng",
        iso="lus",
        script="Latn",
        script_name="Latin",
        # Whisper has no Mizo. Mizo uses Latin script, so there is no
        # remotely honest ASR stand-in -- we leave it None rather than
        # pretend some other language will do.
        asr_code=None,
        asr_native=False,
        tts_code="lus",  # present in OmniVoice LANG_IDS as "lushai"
        tts_native=True,
        priority=4,
        enabled=False,  # stretch goal: TTS-only until an ASR backend covers it
        notes=(
            "Stretch goal. OmniVoice speaks Mizo natively, but no ASR backend "
            "recognises it, so only the TTS half of the pipeline works today."
        ),
    ),
}

DEFAULT_LANGUAGE = "as"


def get(code: str) -> Language:
    """Look up a language, raising a useful error rather than a KeyError."""
    try:
        return LANGUAGES[code]
    except KeyError:
        known = ", ".join(sorted(LANGUAGES))
        raise ValueError(f"Unknown language {code!r}. Known codes: {known}") from None


def enabled() -> list[Language]:
    """Enabled languages, in the brief's priority order."""
    return sorted(
        (lang for lang in LANGUAGES.values() if lang.enabled),
        key=lambda lang: lang.priority,
    )


def choices() -> list[tuple[str, str]]:
    """(label, code) pairs for a Gradio dropdown."""
    return [(lang.label, lang.code) for lang in enabled()]


def asr_code_for(code: str) -> str:
    """The code to hand the ASR backend, or raise if nothing fits."""
    lang = get(code)
    if lang.asr_code is None:
        raise ValueError(
            f"{lang.name} has no ASR support in the current backend. {lang.notes}"
        )
    return lang.asr_code


def tts_code_for(code: str) -> str:
    """The code to hand OmniVoice, or raise if it cannot speak this language."""
    lang = get(code)
    if lang.tts_code is None:
        raise ValueError(
            f"OmniVoice cannot synthesise {lang.name}. {lang.notes}"
        )
    return lang.tts_code
