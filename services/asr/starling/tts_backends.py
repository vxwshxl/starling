"""Where speech gets synthesised: on this laptop, or on a rented GPU.

Same shape as asr_backends.py, and for the same reason -- no single backend is
right for every situation, so the choice is named and routed rather than baked
into the pipeline.

    local   OmniVoice in this process, on the CPU. Clones the speaker's voice.
            Roughly 6x real time: half a minute for a three-sentence answer.
    modal   A GPU behind an HTTPS endpoint. Roughly 0.55x real time, so about
            ten times faster -- but it cannot clone, and the audio leaves the
            machine.

That second trade is not a detail to bury. Starling's two claims are "in your
own voice" and "nothing leaves this machine", and the fast path gives up both.
`ModalBackend.warnings()` says so on every request, and the UI repeats it.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Protocol

import numpy as np

from .audio import ensure_ffmpeg
from .config import settings

logger = logging.getLogger("starling.tts")

#: How long to wait on the remote GPU. Generous because a cold Modal container
#: has to pull the image and load the checkpoint before it can answer; warm
#: calls come back in a few seconds.
MODAL_TIMEOUT_S = 300


class TTSError(RuntimeError):
    """Synthesis failed in a way the caller should surface, not swallow."""


class TTSBackend(Protocol):
    name: str

    @property
    def clones(self) -> bool:
        """Whether this backend can speak in the reference speaker's voice."""
        ...

    @property
    def offline(self) -> bool:
        """False when audio leaves this machine."""
        ...

    def warnings(self) -> list[str]:
        """Caveats to attach to every result from this backend."""
        ...

    def synthesize(
        self,
        text: str,
        tts_code: str,
        ref_wav: Path | None,
        ref_text: str | None,
        num_step: int,
    ) -> tuple[np.ndarray, int]:
        """Return (mono float samples, sample rate)."""
        ...


class LocalOmniVoiceBackend:
    """OmniVoice in-process. The one that can clone a voice."""

    name = "local"
    clones = True
    offline = True

    def warnings(self) -> list[str]:
        return []

    def synthesize(
        self,
        text: str,
        tts_code: str,
        ref_wav: Path | None,
        ref_text: str | None,
        num_step: int,
    ) -> tuple[np.ndarray, int]:
        from . import models

        model = models.get_tts()
        audios = model.generate(
            text=text,
            language=tts_code,
            ref_audio=str(ref_wav) if ref_wav else None,
            ref_text=ref_text,
            num_step=num_step,
            guidance_scale=2.0,
            speed=1.0,
        )
        # 24 kHz, not the 16 kHz the rest of the pipeline runs at. Ask the
        # model rather than assuming either.
        return np.asarray(audios[0], dtype=np.float32), int(model.sampling_rate)


class ModalBackend:
    """OmniVoice on a serverless GPU, reached over HTTPS.

    The endpoint's contract, established by probing it rather than from
    documentation: POST JSON, `text` is required and is the ONLY field that
    changes the output. `language`, `ref_audio` and `num_step` are all accepted
    and all ignored -- verified by sending each and getting back byte-identical
    response lengths. It replies with audio/mpeg, so the MP3 is transcoded to
    samples here and the rest of the pipeline never learns the difference.
    """

    name = "modal"
    clones = False
    offline = False

    def __init__(self, url: str) -> None:
        if not url:
            raise TTSError(
                "Modal TTS is selected but no endpoint is configured. Set "
                "MODAL_TTS_URL, or switch back to on-device synthesis."
            )
        self.url = url

    def warnings(self) -> list[str]:
        return [
            "Spoken on a cloud GPU: this text left the machine, and the reply "
            "is in a generic voice rather than a clone of yours. Switch to "
            "on-device synthesis for a private, cloned voice."
        ]

    def synthesize(
        self,
        text: str,
        tts_code: str,
        ref_wav: Path | None,
        ref_text: str | None,
        num_step: int,
    ) -> tuple[np.ndarray, int]:
        import requests
        import soundfile as sf

        try:
            response = requests.post(
                self.url,
                json={"text": text},
                timeout=MODAL_TIMEOUT_S,
            )
        except requests.RequestException as exc:
            raise TTSError(
                f"Could not reach the Modal TTS endpoint: {exc}. Switch to "
                "on-device synthesis to keep working offline."
            ) from exc

        if response.status_code != 200:
            raise TTSError(
                f"Modal TTS returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
        if not response.content:
            raise TTSError("Modal TTS returned an empty body.")

        with tempfile.TemporaryDirectory(prefix="starling-modal-") as tmp:
            encoded = Path(tmp) / "reply.mp3"
            decoded = Path(tmp) / "reply.wav"
            encoded.write_bytes(response.content)
            _transcode(encoded, decoded)
            samples, rate = sf.read(str(decoded), dtype="float32", always_2d=False)

        if samples.ndim > 1:  # defensive; ffmpeg was asked for mono
            samples = samples.mean(axis=1)
        return np.asarray(samples, dtype=np.float32), int(rate)


def _transcode(src: Path, dest: Path) -> None:
    """MP3 -> mono WAV, keeping the source sample rate.

    Deliberately NOT audio.to_wav_16k(): that exists to normalise model INPUT
    to 16 kHz, and this is model output. Downsampling a finished reply to
    16 kHz would throw away the top of the voice for no reason.
    """
    import subprocess

    cmd = [
        ensure_ffmpeg(),
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-ac", "1",
        "-f", "wav",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise TTSError(
            f"Could not decode the audio Modal returned (ffmpeg exit "
            f"{proc.returncode}).\nstderr:\n{proc.stderr.strip()}"
        )


BACKENDS = ("local", "modal")


def build(kind: str | None = None) -> TTSBackend:
    """Resolve a backend name to an instance. None means the configured default."""
    kind = (kind or settings.tts_backend).lower()
    if kind == "local":
        return LocalOmniVoiceBackend()
    if kind == "modal":
        return ModalBackend(settings.modal_tts_url)
    raise ValueError(
        f"Unknown TTS backend {kind!r}. Use one of: {', '.join(BACKENDS)}."
    )
