"""Lazy singleton model loaders.

INVARIANT: models load ONCE at first use and stay resident. Never load per
request -- Whisper large-v3 is ~3 GB and OmniVoice brings its own stack, on a
machine with 16 GB shared between CPU and GPU.

Because that budget is tight, everything here is also explicitly unloadable.
`unload_all()` exists so the lab UI can free one model to make room for the
other when both will not fit at once.
"""

from __future__ import annotations

import gc
import logging
import threading
from typing import Any

from .asr_backends import ASRBackend, build_backend
from .config import settings

logger = logging.getLogger("starling.models")

# Loading is not thread-safe and FastAPI serves requests concurrently, so the
# first two callers must not both start a multi-GB load.
_asr_lock = threading.Lock()
_tts_lock = threading.Lock()

_asr: ASRBackend | None = None
_tts: Any | None = None


def get_asr() -> ASRBackend:
    """The ASR backend, constructed and loaded on first call."""
    global _asr
    if _asr is None:
        with _asr_lock:
            if _asr is None:
                _asr = build_backend()
    _asr.load()
    return _asr


def get_tts() -> Any:
    """The OmniVoice model, loaded on first call.

    Verified against the installed package:
        OmniVoice.from_pretrained(repo, device_map=..., dtype=torch.float16)
        model.generate(text=..., language=..., ref_audio=..., ref_text=...)
        model.sampling_rate  -> the real output rate; do not hardcode 24000

    Note `load_asr=False`. OmniVoice can auto-transcribe reference audio using
    its OWN bundled Whisper, but we always pass `ref_text` ourselves, so
    letting it load a second recogniser would waste gigabytes for nothing.
    """
    global _tts
    if _tts is not None:
        return _tts

    with _tts_lock:
        if _tts is not None:
            return _tts

        import torch
        from omnivoice import OmniVoice

        device = settings.device
        logger.info(
            "Loading OmniVoice %s on %s -- first run downloads the checkpoint "
            "plus the higgs-audio-v2 audio tokenizer and will take a while.",
            settings.tts_model,
            device,
        )
        model = OmniVoice.from_pretrained(
            settings.tts_model,
            device_map=device,
            dtype=torch.float16,
            load_asr=False,
        )
        _tts = model
        logger.info(
            "OmniVoice ready. Output sampling rate: %s Hz", model.sampling_rate
        )
        return _tts


def tts_sample_rate() -> int:
    """OmniVoice's true output rate, asked of the model rather than assumed.

    Falls back to the configured 24 kHz only when the model is not yet loaded,
    so callers can size a UI before paying the load cost.
    """
    if _tts is not None and getattr(_tts, "sampling_rate", None):
        return int(_tts.sampling_rate)
    return settings.tts_sample_rate


def status() -> dict[str, Any]:
    """What is currently resident. Cheap: never triggers a load."""
    return {
        "asr": {
            "backend": settings.asr_backend,
            "model": settings.whisper_model,
            "loaded": _asr is not None and _asr.loaded,
        },
        "tts": {
            "model": settings.tts_model,
            "loaded": _tts is not None,
            "sample_rate": tts_sample_rate(),
        },
        "device": settings.device,
    }


def unload_all() -> dict[str, bool]:
    """Free both models. Returns what was actually resident beforehand."""
    global _asr, _tts

    freed = {"asr": False, "tts": False}

    if _asr is not None and _asr.loaded:
        _asr.unload()
        freed["asr"] = True

    if _tts is not None:
        del _tts
        _tts = None
        freed["tts"] = True

    gc.collect()
    try:
        import torch

        if settings.device == "mps":
            torch.mps.empty_cache()
    except Exception:  # pragma: no cover - best effort
        pass

    logger.info("unload_all freed: %s", freed)
    return freed
