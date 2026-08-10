"""Swappable ASR backends.

The pipeline talks to `ASRBackend` and never imports mlx_whisper directly,
which is what let the Bodo recogniser land as a new class here plus a line in
`build_backend`, with nothing in pipeline.py, main.py or lab.py changing.

Two backends now co-exist, chosen per language via `Language.asr_backend`:

  mlx-whisper      Assamese and Bengali. 100 languages, no Bodo at any size.
  indic-conformer  Bodo. AI4Bharat's IndicConformer, ONNX, one repo per
                   language, run through onnxruntime.
"""

from __future__ import annotations

import gc
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


#: AI4Bharat's IndicConformer, exported to ONNX by OpenVoiceOS and republished
#: MIT. The upstream `ai4bharat/*` repos are gated behind a Hugging Face terms
#: click; these carry the same weights (see each card's `base_model`) and are
#: not, which is why they are what we point at.
#:
#: One repo per language -- unlike Whisper there is no single multilingual
#: checkpoint here, so a backend instance is bound to one language.
INDIC_CONFORMER_REPOS: dict[str, str] = {
    "as": "OpenVoiceOS/ai4bharat-indicconformer-as-onnx",
    "bn": "OpenVoiceOS/ai4bharat-indicconformer-bn-onnx",
    "brx": "OpenVoiceOS/ai4bharat-indicconformer-brx-onnx",
}


class IndicConformerBackend:
    """AI4Bharat IndicConformer (NeMo conformer-CTC) via onnxruntime.

    This is the backend that makes Bodo real: Whisper has no `brx` at any model
    size, so before this existed Bodo audio was recognised as Assamese and the
    transcript was fiction.

    Running through onnxruntime rather than torch is a deliberate second win.
    torch's MPS backend segfaults loading OmniVoice in fp16 and silently emits
    near-silence in fp32 on this machine; ONNX never touches that code path,
    and onnxruntime picks up CoreML on Apple Silicon by itself.

    Verified against the installed package (onnx-asr 0.12.0):
        onnx_asr.load_model(repo) -> TextResultsAsrAdapter
        adapter.recognize(path_or_ndarray, *, sample_rate=16000) -> str
    """

    name = "indic-conformer"

    def __init__(self, language_code: str) -> None:
        try:
            self.model_repo = INDIC_CONFORMER_REPOS[language_code]
        except KeyError:
            known = ", ".join(sorted(INDIC_CONFORMER_REPOS))
            raise ValueError(
                f"No IndicConformer ONNX export configured for {language_code!r}. "
                f"Known: {known}"
            ) from None
        self.language_code = language_code
        self._model: Any | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        if self._model is not None:
            return
        import onnx_asr

        logger.info(
            "Loading IndicConformer %s for %r -- first run downloads ~590 MB "
            "from the HF hub.",
            self.model_repo,
            self.language_code,
        )
        self._model = onnx_asr.load_model(self.model_repo)
        logger.info("IndicConformer ready: %s", self.model_repo)

    def unload(self) -> None:
        self._model = None
        gc.collect()
        logger.info("IndicConformer unloaded: %s", self.model_repo)

    def transcribe(self, wav_path: Path, language_code: str) -> dict[str, Any]:
        self.load()
        if language_code != self.language_code:
            # Each instance owns exactly one language's weights, so a mismatch
            # means the router handed us the wrong backend. Fail loudly rather
            # than transcribe with the wrong model and return plausible noise.
            raise ValueError(
                f"{self.name} instance is bound to {self.language_code!r} but was "
                f"asked for {language_code!r}"
            )
        assert self._model is not None
        # 16 kHz is guaranteed by audio.to_wav_16k() at the pipeline boundary,
        # but state it rather than rely on the library's default.
        text = self._model.recognize(str(wav_path), sample_rate=16_000)
        return {
            "text": (text or "").strip(),
            "language": self.language_code,
            "segments": [],
        }


def build_backend(
    kind: str | None = None, language_code: str | None = None
) -> ASRBackend:
    """Construct a backend. `language_code` is the ASR code, not Starling's key.

    Only the per-language backends need it; MLXWhisperBackend serves every
    language from one checkpoint and ignores it.
    """
    kind = kind or settings.asr_backend
    if kind == "mlx-whisper":
        return MLXWhisperBackend()
    if kind == "indic-conformer":
        if language_code is None:
            raise ValueError(
                "indic-conformer ships one model per language, so build_backend "
                "needs a language_code"
            )
        return IndicConformerBackend(language_code)
    raise ValueError(f"Unknown ASR backend {kind!r}")
