<div align="center">

<img src="apps/web/src/app/icon.svg" width="88" height="88" alt="Starling" />

# Starling

**Speech-to-speech AI for low-resource Northeast Indian languages.**

Ask a health question out loud in your own language.
Hear the answer back **in your own voice**.

<br />

[![languages](https://img.shields.io/badge/languages-6_native-5a45ad)](#languages)
[![offline](https://img.shields.io/badge/runs-fully_offline-14874e)](#offline-by-design)
[![platform](https://img.shields.io/badge/Apple_Silicon-MLX_·_CoreML_·_ONNX-333)](#requirements)

<br />

*Named for the hill myna of Northeast India — a starling, and one of the
few birds that mimics human speech.*

Built for the NEST symposium hackathon · MDoNER / North Eastern Council / IIT Guwahati

</div>

---

## Offline by design

Nothing leaves the machine. Speech recognition, retrieval, the language model
and voice synthesis all run locally. That is not a privacy nicety — it is the
requirement. This is aimed at health and government questions in places where
connectivity is the thing you cannot count on.

Answers come from a **fixed, curated knowledge base**, never from the model's
own memory. If retrieval finds nothing, the language model is *not called* and
a fixed refusal is returned. A confident wrong answer, spoken aloud to someone
who cannot check it, is the failure this is engineered against.

## Languages

Six, all native in both directions — no fallbacks, no stand-ins.

| Language | | Script | Recognition | Voice |
|---|---|---|---|---|
| Assamese | অসমীয়া | Bengali-Assamese | Whisper | OmniVoice |
| Bodo | बर' | Devanagari | IndicConformer | OmniVoice |
| Sylheti | সিলেটি | Bengali-Assamese | Whisper | OmniVoice¹ |
| Manipuri | ꯃꯤꯇꯩꯂꯣꯟ | Meetei Mayek | IndicConformer | OmniVoice |
| Nepali | नेपाली | Devanagari | IndicConformer | OmniVoice |
| Santali | ᱥᱟᱱᱛᱟᱲᱤ | Ol Chiki | IndicConformer | OmniVoice |

<sub>¹ Synthesised as standard Bengali; pronunciation is approximate. The app
says so in the interface.</sub>

**Not supported, and not pretended otherwise:** Khasi, Garo, Nagamese, Ao,
Angami, Adi, Nyishi, Apatani, Karbi, Dimasa, Rabha — no model covers them in
either direction. Mizo, Kokborok and Sikkimese can be *spoken* but not
recognised, so they stay out of the picker rather than half-working in it.

Coverage is uneven and the UI reports it per language, per stage.

## How it works

A **cascaded** pipeline, not one end-to-end model:

```
  speech ──▶ ASR ──▶ retrieve ──▶ LLM ──▶ TTS ──▶ speech
                         │         │        ▲
                    knowledge   grounded    │
                       base      answer     │
                                            │
              your own recording is the voice reference
```

| Stage | What runs | Where |
|---|---|---|
| Recognition | [`mlx-whisper`](https://pypi.org/project/mlx-whisper/) · [IndicConformer](https://huggingface.co/OpenVoiceOS) ONNX | Metal / CoreML |
| Retrieval | BM25 over a curated corpus, no dependency | CPU, sub-millisecond |
| Answering | Qwen2.5-3B-Instruct 4-bit via [MLX](https://github.com/ml-explore/mlx) | Metal |
| Voice | [`omnivoice`](https://github.com/k2-fsa/OmniVoice), zero-shot cloning, 24 kHz | CPU |
| Audio | ffmpeg, everything normalised to 16 kHz mono WAV | CPU |

Covering **healthcare · governance · education · rural development**.

## Quick start

```bash
pnpm install      # web workspace
pnpm setup:api    # Python env via uv
pnpm smoke        # sanity check — loads no model weights

pnpm dev          # API + web together  ->  http://localhost:3000
```

That is the only command you need. `Ctrl+C` stops both.

> **Weights are not downloaded during setup.** They arrive from the Hugging
> Face hub on first real use — about 7 GB in total — and the first request
> will look frozen. Watch the terminal, not the browser. Use **Start** in the
> app header to warm the models deliberately instead.

<details>
<summary>Other commands</summary>

```bash
pnpm lab          # Gradio debug UI  -> http://127.0.0.1:7860
pnpm dev:api      # API only         -> http://127.0.0.1:8000  (docs at /docs)
pnpm dev:web      # Web only         -> http://localhost:3000
pnpm build:web    # production build
pnpm smoke        # fast checks, no weights
```

The **lab** is the debugging surface: ASR, TTS and round trip in isolation,
each with per-stage timings and full tracebacks. The **app** is the product.

</details>

## Requirements

- macOS on Apple Silicon — MLX and CoreML paths, no CUDA fallback
- 16 GB RAM
- Node 20+ and [pnpm](https://pnpm.io)
- [uv](https://docs.astral.sh/uv/) and ffmpeg — `brew install uv ffmpeg`

## Layout

```
apps/web/          Next.js 15 · TypeScript · Tailwind 4 · shadcn/ui
  /                chat  — the product
  /status          service health, model controls, language coverage

services/asr/      Python 3.11 · FastAPI · uv
  languages.py     the single source of truth for language support
  asr_backends.py  Whisper and IndicConformer behind one protocol
  knowledge.py     the curated corpus
  retrieval.py     BM25, sixty lines, no dependency
  llm.py           local model, grounded generation only
  pipeline.py      transcribe · synthesize · roundtrip
```

## Known gaps

Stated here rather than discovered on stage.

- **Translation is not wired up.** `omnivoice` pins `transformers>=5.3.0`;
  transformers 5 removed slow tokenizers; IndicTrans2 needs one. Speech works
  end to end in all six languages, but answers come back in English. The fix
  is running IndicTrans2 in an isolated environment as a subprocess.
- **Synthesis is slow** — roughly 46× realtime on CPU. Speech is therefore an
  explicit button, never automatic.
- **`STARLING_DEVICE=cpu` is required** for synthesis and is baked into the
  scripts. On `mps`, OmniVoice segfaults in fp16 and emits near-silence in
  fp32 — the second being far more dangerous, since it fails without an error.

## Documentation

[CLAUDE.md](./CLAUDE.md) — architecture, invariants, and the hardware
constraints that shaped the design.
