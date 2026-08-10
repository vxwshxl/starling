"""Smoke check: everything except the model weights.

Deliberately does NOT download or load any model, so it stays fast and can run
before the multi-GB first-use download. It verifies imports resolve, ffmpeg
works on a real generated file, the language config is coherent, and the
language codes we configured actually exist in the installed libraries.

    uv run python -m starling.smoke
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

PASS, FAIL = "  ok  ", " FAIL "
failures: list[str] = []


def check(label: str, fn) -> None:
    try:
        detail = fn()
        print(f"[{PASS}] {label}{f' -- {detail}' if detail else ''}")
    except Exception as exc:  # noqa: BLE001
        print(f"[{FAIL}] {label} -- {type(exc).__name__}: {exc}")
        failures.append(label)


def _imports() -> str:
    from . import audio, config, languages, models, pipeline  # noqa: F401
    from . import asr_backends, timing  # noqa: F401

    return "all starling modules import"


def _ffmpeg_roundtrip() -> str:
    from .audio import ensure_ffmpeg, probe_duration, to_wav_16k

    ensure_ffmpeg()
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "tone.wav"
        # A 1-second 44.1 kHz stereo tone, i.e. deliberately the wrong shape.
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
             "-ac", "2", str(src)],
            check=True, capture_output=True,
        )
        out = to_wav_16k(src, Path(d) / "out.wav")

        import soundfile as sf

        info = sf.info(str(out))
        assert info.samplerate == 16000, f"expected 16000 Hz, got {info.samplerate}"
        assert info.channels == 1, f"expected mono, got {info.channels} channels"
        duration = probe_duration(out)
        return f"44.1k stereo -> {info.samplerate} Hz mono, {duration:.2f}s"


def _language_config() -> str:
    from . import languages

    enabled = languages.enabled()
    assert enabled, "no languages enabled"
    assert languages.DEFAULT_LANGUAGE in languages.LANGUAGES
    for lang in languages.LANGUAGES.values():
        assert lang.code and lang.name and lang.iso and lang.script
        if lang.asr_native:
            assert lang.asr_code, f"{lang.code} claims native ASR but has no code"
        if lang.tts_native:
            assert lang.tts_code, f"{lang.code} claims native TTS but has no code"
    return f"{len(enabled)} enabled of {len(languages.LANGUAGES)}: " + ", ".join(
        lang.code for lang in enabled
    )


def _codes_exist_in_libraries() -> str:
    """The whole point of the two-code design: verify against reality.

    Each language's asr_code is checked against ITS OWN backend, not against
    Whisper globally -- Bodo's "brx" is a real IndicConformer language and
    deliberately not a Whisper one.
    """
    from mlx_whisper.tokenizer import LANGUAGES as WHISPER_LANGS
    from omnivoice.utils.lang_map import LANG_IDS as OMNI_LANGS

    from . import languages
    from .asr_backends import INDIC_CONFORMER_REPOS
    from .config import settings

    notes: list[str] = []
    for lang in languages.LANGUAGES.values():
        backend = lang.asr_backend or settings.asr_backend
        if lang.asr_code:
            if backend == "mlx-whisper" and lang.asr_code not in WHISPER_LANGS:
                raise AssertionError(
                    f"{lang.code}: asr_code {lang.asr_code!r} is not a Whisper language"
                )
            if backend == "indic-conformer" and lang.asr_code not in INDIC_CONFORMER_REPOS:
                raise AssertionError(
                    f"{lang.code}: asr_code {lang.asr_code!r} has no IndicConformer "
                    "ONNX export configured"
                )
        if lang.tts_code and lang.tts_code not in OMNI_LANGS:
            raise AssertionError(
                f"{lang.code}: tts_code {lang.tts_code!r} is not an OmniVoice language"
            )
        if lang.asr_code and not lang.asr_native:
            notes.append(f"{lang.code}->asr:{lang.asr_code}")
        if lang.tts_code and not lang.tts_native:
            notes.append(f"{lang.code}->tts:{lang.tts_code}")
    fallbacks = f"; fallbacks: {', '.join(notes)}" if notes else ""
    return f"whisper {len(WHISPER_LANGS)} langs, omnivoice {len(OMNI_LANGS)} langs{fallbacks}"


def _model_apis_present() -> str:
    """Confirm the functions we call actually exist, without loading weights."""
    import inspect

    import mlx_whisper
    from omnivoice import OmniVoice

    assert callable(mlx_whisper.transcribe)
    sig = inspect.signature(mlx_whisper.transcribe)
    assert "path_or_hf_repo" in sig.parameters

    assert hasattr(OmniVoice, "from_pretrained")
    gen = inspect.signature(OmniVoice.generate)
    for param in ("text", "language", "ref_audio", "ref_text"):
        assert param in gen.parameters, f"OmniVoice.generate has no {param!r}"

    import onnx_asr

    assert callable(onnx_asr.load_model)
    rec = inspect.signature(onnx_asr.load_model)
    assert "model" in rec.parameters, "onnx_asr.load_model has no 'model' parameter"

    return (
        "mlx_whisper.transcribe, OmniVoice.generate and onnx_asr.load_model "
        "signatures match our call sites"
    )


def _fastapi_app() -> str:
    from .main import app

    routes = sorted(
        r.path for r in app.routes if getattr(r, "methods", None)
    )
    for expected in ("/health", "/asr", "/tts", "/roundtrip"):
        assert expected in routes, f"missing route {expected}"
    return ", ".join(routes)


def main() -> int:
    print("Starling smoke check (no model weights are loaded)\n")
    check("starling imports", _imports)
    check("ffmpeg 16 kHz mono conversion", _ffmpeg_roundtrip)
    check("language config coherent", _language_config)
    check("configured codes exist in libraries", _codes_exist_in_libraries)
    check("model APIs match our call sites", _model_apis_present)
    check("fastapi routes registered", _fastapi_app)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All checks passed. Models will download on first real use.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
