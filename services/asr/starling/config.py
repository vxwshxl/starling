"""Environment-backed settings, read once at import.

Kept in one module so no other file reaches into os.environ directly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# services/asr/starling/config.py -> services/asr
SERVICE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICE_ROOT.parent.parent


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # Apple Silicon. Torch's Metal backend is "mps"; there is no CUDA here.
    device: str = _env("STARLING_DEVICE", "mps")

    asr_backend: str = _env("STARLING_ASR_BACKEND", "mlx-whisper")

    # Both of these download from the HF hub on FIRST USE, not at install.
    whisper_model: str = _env(
        "STARLING_WHISPER_MODEL", "mlx-community/whisper-large-v3-mlx"
    )
    tts_model: str = _env("STARLING_TTS_MODEL", "k2-fsa/OmniVoice")
    # Runs through MLX on the GPU. Small on purpose: it only has to rephrase
    # retrieved passages, and it shares 16 GB with the speech models.
    llm_model: str = _env("STARLING_LLM_MODEL", "mlx-community/Qwen2.5-3B-Instruct-4bit")
    # Sarvam-Translate, a Gemma-3-4B fine-tune covering all 22 scheduled
    # Indian languages -- the only model here that can write Bodo, Manipuri or
    # Manipuri. ~2.6 GB in 4-bit. See translate.py for why not IndicTrans2.
    translate_model: str = _env(
        "STARLING_TRANSLATE_MODEL", "mlx-community/sarvam-translate-mlx-4bit"
    )

    host: str = _env("STARLING_HOST", "127.0.0.1")
    port: int = _env_int("STARLING_PORT", 8000)
    lab_port: int = _env_int("STARLING_LAB_PORT", 7860)

    # OmniVoice denoising steps. Cost is linear in this and the audio is real
    # at every setting -- measured on this machine, one 5.7 s utterance:
    #   32 steps  138.6 s  (rtf 25.9)   <- the old default, unusable live
    #   16 steps   68.0 s  (rtf 11.7)
    #    8 steps   34.3 s  (rtf  6.1)   <- default
    #    4 steps   17.1 s  (rtf  3.0)
    # Peak stayed 0.500 throughout, so none of these is the silent-output
    # failure mode from the MPS notes. Drop to 4 if the demo needs the speed
    # more than the fidelity; judge that by ear, not by RMS.
    tts_num_step: int = _env_int("STARLING_TTS_STEPS", 8)

    # Where synthesis runs by default: "local" (this CPU, clones the voice,
    # ~6x real time) or "modal" (a rented GPU, ~0.55x real time, no cloning
    # and the text leaves the machine). Per-request overridable, because the
    # header toggle has to work without restarting the service.
    tts_backend: str = _env("STARLING_TTS_BACKEND", "local")
    # Public, unauthenticated, and already deployed. Kept as a default rather
    # than left blank so the toggle works out of the box; override per machine
    # with MODAL_TTS_URL. Note nothing in this repo reads a .env file -- these
    # have to be real environment variables.
    modal_tts_url: str = _env(
        "MODAL_TTS_URL",
        "https://bodookhrang--omnivoice-tts-omnivoicetts-tts.modal.run",
    )

    # Every model sees 16 kHz mono. OmniVoice hands back 24 kHz.
    # These are invariants, not tunables -- they live here to be imported,
    # not to be overridden from the environment.
    input_sample_rate: int = 16_000
    tts_sample_rate: int = 24_000


settings = Settings()
