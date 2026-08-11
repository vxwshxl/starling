"""The cascaded speech pipeline.

Phase 1 implements the two ends of it:

    VAD -> [ASR] -> translate -> RAG+LLM -> translate -> [TTS]
            ^^^                                          ^^^
        transcribe()                                synthesize()
        \_______________________ roundtrip() _______________________/

roundtrip() currently wires ASR straight into TTS with no translation or LLM in
between, so the assistant simply repeats what it heard, in the speaker's own
cloned voice. That is deliberate: it proves the audio path, the voice cloning
and the timing instrumentation before any language model is involved.

Every function returns (result, timings).
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import soundfile as sf

from . import languages, models
from .audio import probe_duration, to_wav_16k
from .timing import Timings

logger = logging.getLogger("starling.pipeline")

# OmniVoice warns above 20 s of reference audio and recommends 3-10 s. Voice
# cloning quality drops and memory use climbs past that, so we trim rather than
# let a rambling recording degrade the clone.
MAX_REFERENCE_SECONDS = 15.0


@dataclass
class TranscriptionResult:
    text: str
    language: str
    asr_code: str
    asr_native: bool
    duration_s: float | None = None
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "language": self.language,
            "asr_code": self.asr_code,
            "asr_native": self.asr_native,
            "duration_s": self.duration_s,
            "warnings": self.warnings,
        }


@dataclass
class SynthesisResult:
    audio_path: Path
    sample_rate: int
    language: str
    tts_code: str
    tts_native: bool
    text: str
    cloned: bool
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "audio_path": str(self.audio_path),
            "sample_rate": self.sample_rate,
            "language": self.language,
            "tts_code": self.tts_code,
            "tts_native": self.tts_native,
            "text": self.text,
            "cloned": self.cloned,
            "warnings": self.warnings,
        }


def _workdir() -> Path:
    d = Path(tempfile.gettempdir()) / "starling"
    d.mkdir(parents=True, exist_ok=True)
    return d


def transcribe(
    audio_path: str | Path,
    language_code: str,
    timings: Timings | None = None,
) -> tuple[TranscriptionResult, Timings]:
    """Speech -> text, in the source language."""
    timings = timings or Timings()
    lang = languages.get(language_code)
    audio_path = Path(audio_path)

    with timings.stage("normalize"):
        wav = to_wav_16k(audio_path, _workdir() / f"{audio_path.stem}.16k.wav")
        duration = probe_duration(wav)

    with timings.stage("asr_load"):
        backend = models.get_asr(language_code)

    with timings.stage("asr"):
        raw = backend.transcribe(wav, languages.asr_code_for(language_code))

    result = TranscriptionResult(
        text=raw["text"],
        language=lang.code,
        asr_code=lang.asr_code or "",
        asr_native=lang.asr_native,
        duration_s=duration,
        warnings=lang.warnings(),
    )
    logger.info("transcribed %s chars of %s", len(result.text), lang.name)
    return result, timings


def synthesize(
    text: str,
    language_code: str,
    reference_audio: str | Path | None = None,
    reference_text: str | None = None,
    timings: Timings | None = None,
    num_step: int = 32,
    guidance_scale: float = 2.0,
    speed: float = 1.0,
) -> tuple[SynthesisResult, Timings]:
    """Text -> speech, optionally cloning the voice in `reference_audio`.

    Passing `reference_text` matters: without it OmniVoice loads its own
    Whisper to transcribe the reference, costing gigabytes we do not have. In
    roundtrip() we already know what the speaker said, so we always supply it.
    """
    timings = timings or Timings()
    lang = languages.get(language_code)
    tts_code = languages.tts_code_for(language_code)

    if not text.strip():
        raise ValueError("Cannot synthesise empty text.")

    if reference_audio is not None and not (reference_text or "").strip():
        # Refuse rather than let OmniVoice quietly load a second Whisper to
        # transcribe the reference for us. That costs gigabytes we do not have
        # and presents as a twenty-minute hang with no error -- which is
        # exactly how it was found. Callers always know what the speaker said:
        # roundtrip() has just transcribed it, and the lab has a field for it.
        raise ValueError(
            "reference_audio requires reference_text. Without it OmniVoice "
            "loads its own Whisper to transcribe the reference, which stalls "
            "for a long time and consumes several GB."
        )

    ref_wav: Path | None = None
    if reference_audio is not None:
        with timings.stage("ref_normalize"):
            reference_audio = Path(reference_audio)
            ref_wav = to_wav_16k(
                reference_audio, _workdir() / f"{reference_audio.stem}.ref16k.wav"
            )
            ref_duration = probe_duration(ref_wav)
            if ref_duration and ref_duration > MAX_REFERENCE_SECONDS:
                logger.warning(
                    "Reference audio is %.1fs; OmniVoice prefers 3-10s. "
                    "Passing it through unmodified, expect a slower generate().",
                    ref_duration,
                )

    with timings.stage("tts_load"):
        model = models.get_tts()

    with timings.stage("tts"):
        audios = model.generate(
            text=text,
            language=tts_code,
            ref_audio=str(ref_wav) if ref_wav else None,
            ref_text=reference_text,
            num_step=num_step,
            guidance_scale=guidance_scale,
            speed=speed,
        )

    # OmniVoice returns a list of 1-D float arrays. Its rate is 24 kHz, NOT the
    # 16 kHz we feed in -- ask the model rather than assuming either.
    sample_rate = int(model.sampling_rate)
    out_path = _workdir() / f"tts_{abs(hash((text, language_code)))}.wav"

    with timings.stage("write"):
        sf.write(str(out_path), audios[0], sample_rate)

    warnings = lang.warnings()
    if ref_wav is not None and reference_text is None:
        warnings.append(
            "No reference text supplied, so OmniVoice loaded a second Whisper "
            "to transcribe the reference audio. Slower and far heavier on RAM."
        )

    result = SynthesisResult(
        audio_path=out_path,
        sample_rate=sample_rate,
        language=lang.code,
        tts_code=tts_code,
        tts_native=lang.tts_native,
        text=text,
        cloned=ref_wav is not None,
        warnings=warnings,
    )
    logger.info("synthesised %.1fs of audio at %d Hz", len(audios[0]) / sample_rate, sample_rate)
    return result, timings


def roundtrip(
    audio_path: str | Path,
    language_code: str,
    timings: Timings | None = None,
) -> tuple[dict[str, Any], Timings]:
    """Speak -> hear it back in your own cloned voice.

    Phase 1 has no translation, no RAG and no LLM, so the text is echoed
    unchanged. The seam where those will slot in is marked below.
    """
    timings = timings or Timings()

    transcription, timings = transcribe(audio_path, language_code, timings)

    if not transcription.text.strip():
        raise ValueError(
            "ASR returned no text, so there is nothing to speak. Check that the "
            "recording actually contains speech and is not silent."
        )

    # --- PHASE 2 SEAM ------------------------------------------------------
    # translate(source -> en) -> RAG retrieve -> LLM answer -> translate(en -> source)
    # Until that exists the assistant simply repeats the user back to them,
    # which is enough to prove audio, cloning and timings end to end.
    response_text = transcription.text
    # -----------------------------------------------------------------------

    synthesis, timings = synthesize(
        text=response_text,
        language_code=language_code,
        reference_audio=audio_path,
        # The transcript we just produced IS the reference transcript, so
        # OmniVoice never needs to load its own ASR.
        reference_text=transcription.text,
        timings=timings,
    )

    payload = {
        "transcription": transcription.as_dict(),
        "response_text": response_text,
        "synthesis": synthesis.as_dict(),
    }
    return payload, timings
