"""Swappable ASR backends.

The pipeline talks to `ASRBackend` and never imports mlx_whisper directly, so
the planned phase-2 swap to ai4bharat/indic-conformer-600m-multilingual (which
covers Assamese and Bodo properly) is a new class here plus one line in
`build_backend`. Nothing in pipeline.py, main.py or lab.py changes.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol

from .config import settings

logger = logging.getLogger("starling.asr")


class ASRBackend(Protocol):
    """What the pipeline requires of any speech recogniser."""

    name: str

    def load(self) -> None:
        """Bring weights into memory. Idempotent."""

    def unload(self) -> None:
        """Drop weights. Idempotent."""

    @property
    def loaded(self) -> bool: ...

    def transcribe(self, wav_path: Path, language_code: str) -> dict[str, Any]:
        """Transcribe 16 kHz mono WAV. Returns at least {"text": str}."""


class MLXWhisperBackend:
    """Whisper via mlx-whisper, running natively on Apple Silicon.

    mlx-whisper is MLX-based, not torch-based, so it ignores `settings.device`
    entirely -- MLX targets the GPU through Metal on its own and has no device
    argument. That is why `device` never appears in this class. The torch
    device setting still matters for OmniVoice.

    Verified against the installed package: `mlx_whisper.transcribe(audio, *,
    path_or_hf_repo=..., **decode_options)` where `language` is one of the
    decode_options. It caches the loaded model internally in
    `transcribe.ModelHolder`, keyed on the repo path.
    """

    name = "mlx-whisper"

    def __init__(self, model_repo: str | None = None) -> None:
        self.model_repo = model_repo or settings.whisper_model
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        if self._loaded:
            return
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder

        logger.info(
            "Loading Whisper weights %s -- first run downloads ~3 GB from the "
            "HF hub and will take several minutes.",
            self.model_repo,
        )
        # fp16 halves the memory footprint and is what the MLX conversions are
        # published in; this machine has 16 GB shared between CPU and GPU.
        ModelHolder.get_model(self.model_repo, mx.float16)
        self._loaded = True
        logger.info("Whisper ready: %s", self.model_repo)

    def unload(self) -> None:
        from mlx_whisper.transcribe import ModelHolder

        ModelHolder.model = None
        ModelHolder.model_path = None
        self._loaded = False

        import gc

        gc.collect()
        try:
            import mlx.core as mx

            mx.clear_cache()
        except Exception:  # pragma: no cover - best-effort cache release
            pass
        logger.info("Whisper unloaded")

    def transcribe(self, wav_path: Path, language_code: str) -> dict[str, Any]:
        import mlx_whisper

        self.load()
        result = mlx_whisper.transcribe(
            str(wav_path),
            path_or_hf_repo=self.model_repo,
            language=language_code,
            # Deterministic first pass, then fall back up the temperature
            # ladder only if the decode looks degenerate. This is Whisper's
            # standard anti-repetition-loop behaviour and matters on
            # low-resource languages, where looping is common.
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
            condition_on_previous_text=False,
            verbose=None,
        )
        return {
            "text": (result.get("text") or "").strip(),
            "language": result.get("language"),
            "segments": result.get("segments", []),
        }


def build_backend(kind: str | None = None) -> ASRBackend:
    kind = kind or settings.asr_backend
    if kind == "mlx-whisper":
        return MLXWhisperBackend()
    if kind == "indic-conformer":
        raise NotImplementedError(
            "The indic-conformer backend is a phase-2 item and is not built yet. "
            "Set STARLING_ASR_BACKEND=mlx-whisper."
        )
    raise ValueError(f"Unknown ASR backend {kind!r}")
