"""Audio normalisation at the process boundary.

INVARIANT: anything entering a model is 16 kHz, mono, 16-bit PCM WAV. Browser
recordings arrive as webm/opus, phones send m4a, Gradio hands over whatever the
user dropped in. All of it goes through to_wav_16k() first.

The one exception is OmniVoice's OUTPUT, which is 24 kHz. Never round-trip that
through here assuming 16 kHz -- write it with the model's own sampling_rate.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

from .config import settings

logger = logging.getLogger("starling.audio")


class AudioError(RuntimeError):
    """Raised when ffmpeg cannot decode or convert the input."""


def ensure_ffmpeg() -> str:
    """Locate ffmpeg, failing with an actionable message rather than a stack trace."""
    binary = shutil.which("ffmpeg")
    if binary is None:
        raise AudioError(
            "ffmpeg not found on PATH. Install it with:  brew install ffmpeg"
        )
    return binary


def to_wav_16k(
    src: str | Path,
    dest: str | Path,
    sample_rate: int | None = None,
) -> Path:
    """Convert any ffmpeg-readable audio to mono 16-bit PCM WAV at 16 kHz.

    Returns the destination path. Raises AudioError with ffmpeg's own stderr
    attached, because "conversion failed" alone is useless when debugging a
    codec the browser picked.
    """
    binary = ensure_ffmpeg()
    rate = sample_rate or settings.input_sample_rate
    src, dest = Path(src), Path(dest)

    if not src.exists():
        raise AudioError(f"Input audio does not exist: {src}")

    dest.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        binary,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", str(src),
        "-ac", "1",            # mono
        "-ar", str(rate),      # 16 kHz
        "-sample_fmt", "s16",  # 16-bit PCM
        "-f", "wav",
        str(dest),
    ]

    logger.debug("ffmpeg: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)

    if proc.returncode != 0:
        raise AudioError(
            f"ffmpeg failed converting {src.name} (exit {proc.returncode}).\n"
            f"stderr:\n{proc.stderr.strip()}"
        )
    if not dest.exists() or dest.stat().st_size == 0:
        raise AudioError(f"ffmpeg produced no output for {src.name}")

    return dest


def probe_duration(src: str | Path) -> float | None:
    """Duration in seconds via ffprobe, or None if it cannot be determined.

    Used only for logging and UI hints, so it never raises -- a missing
    duration must not fail a transcription.
    """
    binary = shutil.which("ffprobe")
    if binary is None:
        return None
    proc = subprocess.run(
        [
            binary,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(src),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None
