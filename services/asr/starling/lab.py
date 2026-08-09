"""Gradio debug UI -- the primary surface for poking at the pipeline by hand.

Three tabs, matching the three pipeline entry points: ASR alone, TTS alone, and
the full round trip. Every tab shows per-stage wall-clock timings, the language
caveats for whatever you picked, and the complete traceback when something
blows up rather than a swallowed "error".

Run it:  uv run python -m starling.lab
"""

from __future__ import annotations

import logging
import traceback
from typing import Any

import gradio as gr

from . import languages, models, pipeline
from .config import settings
from .timing import Timings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
)
logger = logging.getLogger("starling.lab")

LANG_CHOICES = languages.choices()
DEFAULT_LANG = languages.DEFAULT_LANGUAGE

CSS = """
.starling-banner { border-left: 4px solid #d97706; padding: 8px 14px;
                   background: rgba(217,119,6,0.08); border-radius: 6px; }
.starling-ok     { border-left: 4px solid #16a34a; padding: 8px 14px;
                   background: rgba(22,163,74,0.08); border-radius: 6px; }
.starling-timing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                   font-size: 0.9em; }
"""


# --------------------------------------------------------------------------
# formatting helpers
# --------------------------------------------------------------------------

def _timings_md(timings: Timings | None) -> str:
    if timings is None or not timings.stages:
        return ""
    rows = "\n".join(
        f"| {name} | {ms:,.1f} ms |" for name, ms in timings.stages.items()
    )
    total = sum(timings.stages.values())
    return (
        "| stage | wall clock |\n|---|---|\n"
        f"{rows}\n| **total** | **{total:,.1f} ms** |"
    )


def _warning_md(warnings: list[str]) -> str:
    if not warnings:
        return '<div class="starling-ok">No language caveats. Both stages are native.</div>'
    items = "\n".join(f"- {w}" for w in warnings)
    return f'<div class="starling-banner">\n\n**Heads up**\n\n{items}\n\n</div>'


def _lang_caveats(code: str) -> str:
    """Live preview of a language's caveats, before you run anything."""
    try:
        lang = languages.get(code)
    except ValueError as exc:
        return f"**{exc}**"
    bits = [
        f"**{lang.name}** · `{lang.iso}` · {lang.script_name} script",
        f"ASR code `{lang.asr_code or '—'}` "
        f"({'native' if lang.asr_native else 'FALLBACK'})  ·  "
        f"TTS code `{lang.tts_code or '—'}` "
        f"({'native' if lang.tts_native else 'FALLBACK'})",
    ]
    return "  \n".join(bits) + "\n\n" + _warning_md(lang.warnings())


def _error_md(exc: Exception) -> tuple[str, str]:
    """Returns (short banner, full traceback) -- both are shown."""
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    banner = f'<div class="starling-banner">\n\n**{type(exc).__name__}**: {exc}\n\n</div>'
    return banner, tb


def _status_md() -> str:
    st = models.status()
    return (
        f"**device** `{st['device']}`  ·  "
        f"**ASR** `{st['asr']['model']}` "
        f"({'loaded' if st['asr']['loaded'] else 'not loaded'})  ·  "
        f"**TTS** `{st['tts']['model']}` "
        f"({'loaded' if st['tts']['loaded'] else 'not loaded'}, "
        f"{st['tts']['sample_rate']} Hz out)"
    )


# --------------------------------------------------------------------------
# tab handlers
# --------------------------------------------------------------------------

def run_asr(audio_path: str | None, lang_code: str) -> tuple[str, str, str, str, str]:
    """-> transcript, warnings, timings, error banner, traceback"""
    if not audio_path:
        return "", "", "", "**Record or upload some audio first.**", ""
    try:
        result, timings = pipeline.transcribe(audio_path, lang_code)
        return (
            result.text or "(ASR returned nothing — is the recording silent?)",
            _warning_md(result.warnings),
            _timings_md(timings),
            "",
            "",
        )
    except Exception as exc:  # noqa: BLE001 - the lab must show everything
        banner, tb = _error_md(exc)
        return "", "", "", banner, tb


def run_tts(
    text: str,
    lang_code: str,
    ref_audio: str | None,
    ref_text: str,
    num_step: int,
    guidance_scale: float,
    speed: float,
) -> tuple[Any, str, str, str, str]:
    """-> audio, warnings, timings, error banner, traceback"""
    if not text.strip():
        return None, "", "", "**Enter some text to speak.**", ""
    try:
        result, timings = pipeline.synthesize(
            text=text,
            language_code=lang_code,
            reference_audio=ref_audio,
            reference_text=ref_text.strip() or None,
            num_step=int(num_step),
            guidance_scale=float(guidance_scale),
            speed=float(speed),
        )
        return (
            str(result.audio_path),
            _warning_md(result.warnings),
            _timings_md(timings),
            "",
            "",
        )
    except Exception as exc:  # noqa: BLE001
        banner, tb = _error_md(exc)
        return None, "", "", banner, tb


def run_roundtrip(
    audio_path: str | None, lang_code: str
) -> tuple[str, Any, str, str, str, str]:
    """-> transcript, audio, warnings, timings, error banner, traceback"""
    if not audio_path:
        return "", None, "", "", "**Record or upload some audio first.**", ""
    try:
        payload, timings = pipeline.roundtrip(audio_path, lang_code)
        warnings = (
            payload["transcription"]["warnings"] + payload["synthesis"]["warnings"]
        )
        return (
            payload["transcription"]["text"],
            payload["synthesis"]["audio_path"],
            _warning_md(list(dict.fromkeys(warnings))),
            _timings_md(timings),
            "",
            "",
        )
    except Exception as exc:  # noqa: BLE001
        banner, tb = _error_md(exc)
        return "", None, "", "", banner, tb


def do_unload() -> str:
    freed = models.unload_all()
    return f"Freed: {freed}\n\n{_status_md()}"


# --------------------------------------------------------------------------
# UI
# --------------------------------------------------------------------------

def build() -> gr.Blocks:
    # Gradio 6 moved `css` off the Blocks constructor and onto launch().
    with gr.Blocks(title="Starling lab") as demo:
        gr.Markdown(
            "# Starling lab\n"
            "Speech-to-speech for Northeast Indian languages. "
            "The first run of each model downloads several GB of weights and "
            "will sit there looking frozen for a few minutes — watch the terminal."
        )

        with gr.Row():
            status = gr.Markdown(_status_md())
        with gr.Row():
            refresh_btn = gr.Button("Refresh status", size="sm", scale=0)
            unload_btn = gr.Button("Unload models (free RAM)", size="sm", scale=0)

        refresh_btn.click(lambda: _status_md(), outputs=status)
        unload_btn.click(do_unload, outputs=status)

        # ---------------- ASR ----------------
        with gr.Tab("1 · ASR"):
            gr.Markdown("Speech in, text out. Nothing else runs.")
            with gr.Row():
                with gr.Column():
                    asr_lang = gr.Dropdown(
                        choices=LANG_CHOICES,
                        value=DEFAULT_LANG,
                        label="Language",
                    )
                    asr_caveats = gr.Markdown(_lang_caveats(DEFAULT_LANG))
                    asr_audio = gr.Audio(
                        sources=["microphone", "upload"],
                        type="filepath",
                        label="Input audio (any format; normalised to 16 kHz mono)",
                    )
                    asr_btn = gr.Button("Transcribe", variant="primary")
                with gr.Column():
                    asr_text = gr.Textbox(
                        label="Transcript", lines=6
                    )
                    asr_warn = gr.Markdown()
                    asr_time = gr.Markdown(elem_classes="starling-timing")
                    asr_err = gr.Markdown()
                    with gr.Accordion("Traceback", open=False):
                        asr_tb = gr.Code(label="", lines=18)

            asr_lang.change(_lang_caveats, inputs=asr_lang, outputs=asr_caveats)
            asr_btn.click(
                run_asr,
                inputs=[asr_audio, asr_lang],
                outputs=[asr_text, asr_warn, asr_time, asr_err, asr_tb],
            ).then(lambda: _status_md(), outputs=status)

        # ---------------- TTS ----------------
        with gr.Tab("2 · TTS"):
            gr.Markdown(
                "Text in, speech out. Supply reference audio to clone a voice.\n\n"
                "**Supply the reference transcript too.** Without it OmniVoice "
                "loads its own Whisper just to transcribe your reference, which "
                "costs several GB of RAM on top of everything else."
            )
            with gr.Row():
                with gr.Column():
                    tts_lang = gr.Dropdown(
                        choices=LANG_CHOICES, value=DEFAULT_LANG, label="Language"
                    )
                    tts_caveats = gr.Markdown(_lang_caveats(DEFAULT_LANG))
                    tts_text = gr.Textbox(
                        label="Text to speak", lines=4,
                        placeholder="Type in the target language's own script.",
                    )
                    tts_ref = gr.Audio(
                        sources=["microphone", "upload"],
                        type="filepath",
                        label="Reference voice (optional, 3–10 s works best)",
                    )
                    tts_ref_text = gr.Textbox(
                        label="Reference transcript (what the reference audio says)",
                        lines=2,
                    )
                    with gr.Accordion("Generation settings", open=False):
                        tts_steps = gr.Slider(
                            8, 64, value=32, step=1,
                            label="num_step (higher = better, slower)",
                        )
                        tts_guidance = gr.Slider(
                            1.0, 5.0, value=2.0, step=0.1, label="guidance_scale"
                        )
                        tts_speed = gr.Slider(
                            0.5, 1.5, value=1.0, step=0.05, label="speed"
                        )
                    tts_btn = gr.Button("Synthesise", variant="primary")
                with gr.Column():
                    tts_out = gr.Audio(label="Output (24 kHz)", type="filepath")
                    tts_warn = gr.Markdown()
                    tts_time = gr.Markdown(elem_classes="starling-timing")
                    tts_err = gr.Markdown()
                    with gr.Accordion("Traceback", open=False):
                        tts_tb = gr.Code(label="", lines=18)

            tts_lang.change(_lang_caveats, inputs=tts_lang, outputs=tts_caveats)
            tts_btn.click(
                run_tts,
                inputs=[
                    tts_text, tts_lang, tts_ref, tts_ref_text,
                    tts_steps, tts_guidance, tts_speed,
                ],
                outputs=[tts_out, tts_warn, tts_time, tts_err, tts_tb],
            ).then(lambda: _status_md(), outputs=status)

        # ---------------- Round trip ----------------
        with gr.Tab("3 · Round trip"):
            gr.Markdown(
                "Speak, and hear yourself repeated back in your own cloned voice.\n\n"
                "Phase 1 has no translation, no retrieval and no LLM, so the text "
                "comes back unchanged. This tab exists to prove the audio path, "
                "the voice cloning and the timings before any of that lands."
            )
            with gr.Row():
                with gr.Column():
                    rt_lang = gr.Dropdown(
                        choices=LANG_CHOICES, value=DEFAULT_LANG, label="Language"
                    )
                    rt_caveats = gr.Markdown(_lang_caveats(DEFAULT_LANG))
                    rt_audio = gr.Audio(
                        sources=["microphone", "upload"],
                        type="filepath",
                        label="Speak here",
                    )
                    rt_btn = gr.Button("Run round trip", variant="primary")
                with gr.Column():
                    rt_text = gr.Textbox(
                        label="What Starling heard", lines=4
                    )
                    rt_out = gr.Audio(label="Your cloned voice (24 kHz)", type="filepath")
                    rt_warn = gr.Markdown()
                    rt_time = gr.Markdown(elem_classes="starling-timing")
                    rt_err = gr.Markdown()
                    with gr.Accordion("Traceback", open=False):
                        rt_tb = gr.Code(label="", lines=18)

            rt_lang.change(_lang_caveats, inputs=rt_lang, outputs=rt_caveats)
            rt_btn.click(
                run_roundtrip,
                inputs=[rt_audio, rt_lang],
                outputs=[rt_text, rt_out, rt_warn, rt_time, rt_err, rt_tb],
            ).then(lambda: _status_md(), outputs=status)

    return demo


def main() -> None:
    build().launch(server_port=settings.lab_port, show_error=True, css=CSS)


if __name__ == "__main__":
    main()
