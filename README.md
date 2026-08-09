# Starling

Speech-to-speech AI assistant for low-resource Northeast Indian languages.
Ask a health question out loud in your own language, and hear the answer back
**in your own voice**.

Named for the hill myna of Northeast India — a starling, and one of the few
birds that mimics human speech.

Built for the NEST symposium hackathon (MDoNER / North Eastern Council /
IIT Guwahati).

## Languages

Assamese · Bodo · Sylheti / Barak Valley Bengali, with Mizo and Khasi as
stretch goals. Coverage is uneven and the app says so out loud rather than
pretending otherwise — see the table in [CLAUDE.md](./CLAUDE.md#language-support).

## How it works

A **cascaded** pipeline, not an end-to-end model:

```
VAD -> ASR -> translate to English -> RAG + LLM -> translate back -> TTS
                                                                      ^
                              your own recording is the voice reference
```

Phase 1 implements the two ends — speech recognition and voice-cloning speech
synthesis — with nothing in between yet, so it repeats you back to yourself in
your own cloned voice.

| Stage | What runs |
|---|---|
| ASR | [`mlx-whisper`](https://pypi.org/project/mlx-whisper/), Apple-Silicon native |
| TTS | [`omnivoice`](https://github.com/k2-fsa/OmniVoice), zero-shot voice cloning, 24 kHz |
| Audio | ffmpeg, normalising everything to 16 kHz mono WAV |

## Requirements

- macOS on Apple Silicon (the ASR path is MLX/Metal; there is no CUDA fallback)
- ~16 GB RAM
- Node 20+, [pnpm](https://pnpm.io)
- [uv](https://docs.astral.sh/uv/) and ffmpeg: `brew install uv ffmpeg`

## Setup

```bash
pnpm install      # web workspace
pnpm setup:api    # Python venv via uv (~3-4 GB of wheels: torch, transformers, gradio)
pnpm smoke        # fast sanity check; loads no model weights
```

> **Model weights are not downloaded during setup.** Whisper large-v3 (~3 GB)
> and the OmniVoice checkpoint download from the Hugging Face hub on **first
> real use** and take several minutes. The first transcription or synthesis
> will look frozen — watch the terminal.

## Running

```bash
pnpm lab          # Gradio debug UI    -> http://127.0.0.1:7860
pnpm dev:api      # FastAPI service    -> http://127.0.0.1:8000  (docs at /docs)
pnpm dev:web      # Next.js shell      -> http://localhost:3000
```

The **lab** is where the work happens: three tabs (ASR alone, TTS alone, full
round trip), each showing per-stage wall-clock timings, the caveats for the
language you picked, and the complete traceback when something fails.

The **web shell** is deliberately minimal in phase 1 — it checks whether the
Python service is up and reports what is loaded.

## Layout

```
apps/web/        Next.js 15, TypeScript, Tailwind
services/asr/    Python 3.11, FastAPI, uv
```

See [CLAUDE.md](./CLAUDE.md) for architecture, invariants and the language
coverage table.
