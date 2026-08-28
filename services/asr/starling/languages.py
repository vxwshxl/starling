"""The single source of truth for which languages Starling supports.

INVARIANT: no language code is ever hardcoded in pipeline logic. Every stage
asks this module. Adding a language means editing this file and nothing else.

ASR and TTS do NOT cover the same languages, so each language carries a
separate code and a separate "is this real?" flag for each stage. Verified
against the installed packages, not assumed:

  ASR  mlx_whisper.tokenizer.LANGUAGES -- 100 languages. Has `as` and `bn`.
       Has NO code for Bodo, Khasi or Mizo, which is why Bodo, Manipuri and
       Nepali run on IndicConformer instead (see `asr_backend`).
  TTS  omnivoice.utils.lang_map.LANG_IDS -- 646 languages. Has `as`, `bn`,
       AND `brx` (Bodo) and `lus` (Mizo). Has NO Khasi.

**Every enabled language is native in all three stages.** There is no fallback
anywhere in the list any more, and that is the bar for adding one: if a
language would have to borrow another's recogniser, voice or translation, it
does not go in the picker. An earlier list carried Sylheti, which was Bengali
in everything but the label -- Bengali's ASR, Bengali's voice, Bengali's
translation, and three warnings saying so. Bengali itself is in the list now,
which is the honest version of the same capability.

English is in the list too, and it is not one of the five: it is the pivot.
Choosing it does not add a translation direction, it removes both of them --
the question arrives in the language the knowledge base, the answering model
and the page agent already reason in, so `translate.to_english` and
`translate.from_english` return their input untouched and Sarvam is never
loaded. That makes it the fast path and the control: when a Bodo answer looks
wrong, asking the same thing in English is how you tell a bad answer apart
from a bad translation.

The machinery for fallbacks survives regardless -- `asr_native`,
`tts_native`, `translate_native` and `warnings()` all still work -- because
the next language somebody wants will probably need it, and a half-supported
language that announces itself is far better than one that does not.
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

    asr_backend: str | None = None
    """Which ASR backend recognises this language, or None for the configured
    default. Set per language because no single recogniser covers them all:
    Whisper has no Bodo, Manipuri or Nepali; IndicConformer has one
    checkpoint per language rather than a multilingual one."""

    translate_name: str | None = None
    """English name Sarvam-Translate is addressed by, or None if it cannot
    translate this language.

    A third code alongside asr_code and tts_code, and for the same reason: the
    translator names languages its own way. It takes a plain English word in
    the prompt ("Translate the text below to Bodo.") rather than an ISO code,
    and it recognises the 22 scheduled languages under their official English
    names. Every language enabled here is scheduled, so every one is covered;
    an unscheduled language would need `translate_native=False` and a
    stand-in, which is the arrangement this list no longer has."""

    translate_native: bool = True
    """False when translate_name is a stand-in rather than the real language."""

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
        # Assamese and Bengali share one script. ISO 15924 gives it a single
        # code, `Beng`, and the two languages differ only in a couple of
        # letters -- but "Bengali-Assamese" in an Assamese speaker's language
        # picker reads as being told their script belongs to someone else. So
        # `script` stays the true ISO code and `script_name` follows the
        # language. Do not "correct" one to match the other; they are
        # answering different questions.
        script="Beng",
        script_name="Assamese",
        asr_code="as",
        asr_native=True,
        tts_code="as",
        tts_native=True,
        translate_name="Assamese",
        priority=1,
    ),
    "brx": Language(
        code="brx",
        name="Bodo",
        native_name="बर'",
        iso="brx",
        script="Deva",
        script_name="Devanagari",
        # Whisper has no Bodo at any model size, so this runs on AI4Bharat's
        # IndicConformer instead -- genuinely trained on Bodo, not a regional
        # stand-in. Before this it was recognised as Assamese and transcripts
        # were fiction.
        asr_code="brx",
        asr_native=True,
        asr_backend="indic-conformer",
        # OmniVoice DOES have Bodo natively (brx is in LANG_IDS), so the
        # speaking half of the pipeline is genuine too.
        tts_code="brx",
        tts_native=True,
        translate_name="Bodo",
        priority=2,
        notes=(
            "Bodo is written in DEVANAGARI, not Bengali script. Both halves are "
            "now native: ASR via IndicConformer (ONNX), TTS via OmniVoice. "
            "Whisper is not involved and cannot be -- it has no Bodo code."
        ),
    ),
    "bn": Language(
        code="bn",
        name="Bengali",
        native_name="বাংলা",
        iso="bn",
        # Same script as Assamese; see the note on that entry for why the
        # display name differs while the ISO code does not.
        script="Beng",
        script_name="Bengali",
        asr_code="bn",
        asr_native=True,
        tts_code="bn",
        tts_native=True,
        translate_name="Bengali",
        priority=3,
        notes=(
            "Native in all three stages, with no fallback anywhere: Whisper "
            "has 'bn', OmniVoice has 'bn', and Bengali is a scheduled language "
            "so Sarvam-Translate covers it. This entry replaced a Sylheti one "
            "that was Bengali in everything but the label -- it borrowed "
            "Bengali's ASR, voice and translation and warned about all three. "
            "Naming the thing we actually run is more honest than shipping a "
            "language the models do not have."
        ),
    ),
    "mni": Language(
        code="mni",
        name="Manipuri (Meitei)",
        native_name="ꯃꯤꯇꯩꯂꯣꯟ",
        iso="mni",
        # Manipuri is written in BOTH Bengali script and Meetei Mayek. The
        # IndicConformer export emits Meetei Mayek -- verified by running audio
        # through it and inspecting the Unicode block, not assumed.
        script="Mtei",
        script_name="Meetei Mayek",
        asr_code="mni",
        asr_native=True,
        asr_backend="indic-conformer",
        tts_code="mni",
        tts_native=True,
        translate_name="Manipuri",
        priority=4,
        notes=(
            "Scheduled language and official in Manipur. Both halves native. "
            "Script caveat: ASR emits Meetei Mayek, so anything feeding TTS or "
            "translation must agree on that script rather than Bengali."
        ),
    ),
    "ne": Language(
        code="ne",
        name="Nepali",
        native_name="नेपाली",
        iso="ne",
        script="Deva",
        script_name="Devanagari",
        asr_code="ne",
        asr_native=True,
        asr_backend="indic-conformer",
        # OmniVoice codes Nepali as "npi", not "ne". Nepali was nearly written
        # off as unreachable on the strength of the wrong code.
        tts_code="npi",
        tts_native=True,
        translate_name="Nepali",
        priority=5,
        notes=(
            "Widely spoken in Sikkim and the Darjeeling/Dooars belt. ASR code "
            "is 'ne' but OmniVoice's code is 'npi' -- the two-code design earns "
            "its keep here."
        ),
    ),
    "en": Language(
        code="en",
        name="English",
        native_name="English",
        iso="en",
        script="Latn",
        script_name="Latin",
        # Native in both speech stages, verified the same way as every other
        # entry: "en" is in mlx_whisper.tokenizer.LANGUAGES and in
        # omnivoice.utils.lang_map.LANG_IDS.
        asr_code="en",
        asr_native=True,
        tts_code="en",
        tts_native=True,
        # Sarvam can write English, but nothing ever asks it to: English is
        # the pivot, so translate.to_english() and translate.from_english()
        # both return the text unchanged for this code and the translator is
        # never loaded. The name is filled in anyway so `translatable("en")`
        # answers truthfully rather than by omission.
        translate_name="English",
        priority=6,  # last in the picker: the Indic languages are the point
        notes=(
            "English is the cascade's pivot, so choosing it does not add a "
            "language -- it removes two stages. The question is already in "
            "the language the knowledge base, the answering model and the "
            "page agent all reason in, so both translation legs drop out and "
            "an answer costs seconds rather than tens of seconds, with no "
            "translation to be wrong. It is in the picker because a working "
            "English path is how you tell a bad answer apart from a bad "
            "translation, and because plenty of people in the Northeast read "
            "English and would rather have the fast, exact reply."
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


def asr_backend_for(code: str) -> str | None:
    """Which ASR backend this language needs, or None for the configured default.

    Returning None rather than reading settings keeps this module free of the
    config import; models.py resolves the default.
    """
    return get(code).asr_backend


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


def translate_name_for(code: str) -> str:
    """The name to hand Sarvam-Translate, or raise if it cannot translate this."""
    lang = get(code)
    if lang.translate_name is None:
        raise ValueError(
            f"Sarvam-Translate does not cover {lang.name}. {lang.notes}"
        )
    return lang.translate_name


def translatable(code: str) -> bool:
    """Whether answers can be written in this language at all."""
    return get(code).translate_name is not None
