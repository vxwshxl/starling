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

from . import languages, llm, translate
from .asr_backends import ASRBackend, build_backend
from .config import settings

logger = logging.getLogger("starling.models")

# Loading is not thread-safe and FastAPI serves requests concurrently, so the
# first two callers must not both start a multi-GB load.
_asr_lock = threading.Lock()
_tts_lock = threading.Lock()

# Keyed by (backend kind, language slot). More than one ASR backend can be
# resident because no single recogniser covers every language: Whisper serves
# Assamese and Bengali, IndicConformer serves Bodo. Each entry still obeys the
# load-once invariant -- this is a registry, not per-request loading.
_asr: dict[tuple[str, str], ASRBackend] = {}
_tts: Any | None = None

#: Backends that ship one checkpoint per language, so the registry key has to
#: include the language. Whisper is multilingual and shares a single entry.
_PER_LANGUAGE_BACKENDS = frozenset({"indic-conformer"})


def get_asr(language_code: str | None = None) -> ASRBackend:
    """The ASR backend for a language, constructed and loaded on first call.

    `language_code` is Starling's key (e.g. "brx"), not the backend's code.
    """
    code = language_code or languages.DEFAULT_LANGUAGE
    kind = languages.asr_backend_for(code) or settings.asr_backend
    asr_code = languages.asr_code_for(code)
    key = (kind, asr_code if kind in _PER_LANGUAGE_BACKENDS else "*")

    with _asr_lock:
        backend = _asr.get(key)
        if backend is None:
            backend = build_backend(kind, asr_code)
            _asr[key] = backend
    backend.load()
    return backend


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
    resident = [
        {"backend": b.name, "model": getattr(b, "model_repo", "?")}
        for b in _asr.values()
        if b.loaded
    ]
    return {
        "asr": {
            # The configured default, i.e. what serves any language that does
            # not name its own backend. `resident` is the honest full picture,
            # since Bodo pulls in a second recogniser alongside this one.
            "backend": settings.asr_backend,
            "model": settings.whisper_model,
            "loaded": bool(resident),
            "resident": resident,
        },
        "tts": {
            "model": settings.tts_model,
            "loaded": _tts is not None,
            "sample_rate": tts_sample_rate(),
            "num_step": settings.tts_num_step,
            # Which engine synthesis runs on unless a request overrides it,
            # and whether the remote one is reachable at all. The UI toggle
            # needs both to avoid offering a mode that cannot work.
            "backend": settings.tts_backend,
            "modal_configured": bool(settings.modal_tts_url),
        },
        # These two live in their own modules because they are pure mlx-lm and
        # share none of the loader machinery above. They are reported here so
        # /health has one honest answer to "what is holding memory".
        "llm": {"model": settings.llm_model, "loaded": llm.loaded()},
        "translate": {
            "model": settings.translate_model,
            "loaded": translate.loaded(),
        },
        "device": settings.device,
    }


def load(target: str, language_code: str | None = None) -> dict[str, Any]:
    """Warm a model on demand, so the UI can pay the load cost deliberately.

    Without this the first real request absorbs several seconds of loading and
    looks like a hang. Returns the post-load status.
    """
    if target == "asr":
        get_asr(language_code)
    elif target == "tts":
        get_tts()
    elif target == "llm":
        llm.load()
    elif target == "translate":
        translate.load()
    elif target == "all":
        # The order the pipeline needs them in, so a "Start" button warms the
        # cheap end first and the user sees progress rather than one long wait.
        get_asr(language_code)
        llm.load()
        translate.load()
        get_tts()
    else:
        raise ValueError(
            f"Unknown target {target!r}. Use 'asr', 'tts', 'llm', 'translate' or 'all'."
        )
    return status()


def unload(target: str = "all") -> dict[str, bool]:
    """Free models. `target` is 'asr', 'tts' or 'all'.

    Returns what was actually resident beforehand, so a caller can tell the
    difference between freeing memory and doing nothing.
    """
    global _asr, _tts

    if target not in ("asr", "tts", "llm", "translate", "all"):
        raise ValueError(
            f"Unknown target {target!r}. Use 'asr', 'tts', 'llm', 'translate' or 'all'."
        )

    freed = {"asr": False, "tts": False, "llm": False, "translate": False}

    if target in ("asr", "all"):
        for backend in _asr.values():
            if backend.loaded:
                backend.unload()
                freed["asr"] = True
        _asr.clear()

    if target in ("tts", "all") and _tts is not None:
        del _tts
        _tts = None
        freed["tts"] = True

    if target in ("llm", "all"):
        freed["llm"] = llm.unload()

    if target in ("translate", "all"):
        freed["translate"] = translate.unload()

    gc.collect()
    try:
        import torch

        if settings.device == "mps":
            torch.mps.empty_cache()
    except Exception:  # pragma: no cover - best effort
        pass

    logger.info("unload(%s) freed: %s", target, freed)
    return freed


def unload_all() -> dict[str, bool]:
    """Free everything. Kept as the name lab.py and POST /unload already use."""
    return unload("all")
