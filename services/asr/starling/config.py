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

    host: str = _env("STARLING_HOST", "127.0.0.1")
    port: int = _env_int("STARLING_PORT", 8000)
    lab_port: int = _env_int("STARLING_LAB_PORT", 7860)

    # Every model sees 16 kHz mono. OmniVoice hands back 24 kHz.
    # These are invariants, not tunables -- they live here to be imported,
    # not to be overridden from the environment.
    input_sample_rate: int = 16_000
    tts_sample_rate: int = 24_000


settings = Settings()
