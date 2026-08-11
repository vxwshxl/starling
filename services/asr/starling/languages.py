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

    asr_backend: str | None = None
    """Which ASR backend recognises this language, or None for the configured
    default. Set per language because no single recogniser covers them all:
    Whisper has no Bodo, IndicConformer has no Sylheti."""

    translate_name: str | None = None
    """English name Sarvam-Translate is addressed by, or None if it cannot
    translate this language.

    A third code alongside asr_code and tts_code, and for the same reason: the
    translator names languages its own way. It takes a plain English word in
    the prompt ("Translate the text below to Bodo.") rather than an ISO code,
    and it recognises the 22 scheduled languages under their official English
    names -- so Sylheti, which is not scheduled, has to travel as Bengali just
    as it already does for TTS."""

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
        script="Beng",
        script_name="Bengali-Assamese",
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
        translate_name="Bengali",
        translate_native=False,
        priority=3,
        notes=(
            "Handled as a Bengali dialect. Whisper's 'bn' is standard Bengali, "
            "so heavily dialectal Sylheti speech will degrade. OmniVoice has no "
            "Sylheti either; output is Bengali-accented."
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
    "sat": Language(
        code="sat",
        name="Santali",
        native_name="ᱥᱟᱱᱛᱟᱲᱤ",
        iso="sat",
        script="Olck",
        script_name="Ol Chiki",
        asr_code="sat",
        asr_native=True,
        asr_backend="indic-conformer",
        tts_code="sat",
        tts_native=True,
        translate_name="Santali",
        priority=6,
        notes=(
            "Scheduled language, written in Ol Chiki. Spoken in the Assam tea "
            "belt as well as Jharkhand and Odisha. Both halves native."
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
