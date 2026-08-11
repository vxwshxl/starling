<div align="center">

<img src="apps/web/src/app/icon.svg" width="88" height="88" alt="Starling" />

# Starling

**Speech-to-speech AI for low-resource Northeast Indian languages.**

Ask a health question out loud in your own language.
Hear the answer back **in your own voice**.

<br />

[![languages](https://img.shields.io/badge/languages-5_native-5a45ad)](#languages)
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

Five, every one native at every stage — recognition, translation and voice.
No fallbacks, no stand-ins, nothing borrowing another language's model.

| Language | | Script | Recognition | Voice |
|---|---|---|---|---|
| Assamese | অসমীয়া | Assamese | Whisper | OmniVoice |
| Bodo | बर' | Devanagari | IndicConformer | OmniVoice |
| Bengali | বাংলা | Bengali | Whisper | OmniVoice |
| Manipuri | ꯃꯤꯇꯩꯂꯣꯟ | Meetei Mayek | IndicConformer | OmniVoice |
| Nepali | नेपाली | Devanagari | IndicConformer | OmniVoice |

<sub>Assamese and Bengali are written in the same script — ISO 15924 calls it
`Beng` — and each is named after its own language here rather than as
"Bengali-Assamese".</sub>

**Not supported, and not pretended otherwise:** Khasi, Garo, Nagamese, Ao,
Angami, Adi, Nyishi, Apatani, Karbi, Dimasa, Rabha — no model covers them in
either direction. Mizo, Kokborok and Sikkimese can be *spoken* but not
recognised, so they stay out of the picker rather than half-working in it.
Sylheti and Santali were both dropped for the same reason — Sylheti was
standard Bengali wearing a different label, so Bengali itself replaced it.

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
| Translation | [Sarvam-Translate](https://huggingface.co/sarvamai/sarvam-translate) 4-bit, a Gemma-3-4B fine-tune | Metal |
| Voice | [`omnivoice`](https://github.com/k2-fsa/OmniVoice), zero-shot cloning, 24 kHz | CPU |
| Audio | ffmpeg, everything normalised to 16 kHz mono WAV | CPU |

Covering **healthcare · governance · education · rural development**.

English is the pivot throughout: the knowledge base is English, the answering
model reasons in English, and the user's language goes on at the very end.
That is not a shortcut — it is the only arrangement in which a 3B model gives
a correct answer in Bodo.

## Also: the browser

`apps/extension/` puts the same models behind a Chrome side panel.

- **Translate any page** into the five languages, in place, one click to
  restore. Visible screen first; the cache makes a revisited page instant.
- **Drive the browser by voice.** Say what you want in your own language; the
  agent reads the page, takes one action, looks again, and repeats — showing
  you every step and ringing the element before it touches it.

No build step. `chrome://extensions` → Developer mode → **Load unpacked** →
`apps/extension`. It talks to `127.0.0.1:8000` and nothing else; the
manifest's `connect-src` blocks any other host.
[Details, measured timings and limitations.](./apps/extension/README.md)

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

apps/extension/    Chrome MV3 · no build step
  content/         page translation and the agent's hands, in the page
  sidepanel/       the UI, and the owner of both loops

services/asr/      Python 3.11 · FastAPI · uv
  languages.py     the single source of truth for language support
  asr_backends.py  Whisper and IndicConformer behind one protocol
  knowledge.py     the curated corpus
  retrieval.py     BM25, sixty lines, no dependency
  llm.py           local model, grounded generation only
  translate.py     Sarvam-Translate, both legs, plus batched segments
  page.py          whole-page translation: filter · cache · dedupe · batch
  agent.py         one browsing action per call, validated against the page
  pipeline.py      transcribe · synthesize · roundtrip
```

## Known gaps

Stated here rather than discovered on stage.

- **Whole-page translation is not instant, and cannot be.** A 4B model on this
  machine manages about 2.4 segments a second, so a dense first screen is
  ~12 s cold. The extension sends the visible viewport first and caches
  everything, which makes a revisited page instant — but a long article keeps
  filling in while you read it. The panel shows the counts rather than
  claiming otherwise.
- **A sentence broken by a link translates in pieces.** Cosmetic inline markup
  is absorbed into the surrounding sentence; `<a>` cannot be, because the
  translation would have to be split back across nodes and these languages
  reorder words.
- **Synthesis is slow** — measured at ~5.5× realtime on CPU (17 s of compute
  for 3.2 s of speech), and considerably worse when the machine is already
  under memory pressure. Speech is therefore an explicit button, never
  automatic.
- **Always pass a reference transcript to `/tts`.** Omit it and OmniVoice
  quietly loads a second Whisper of its own just to transcribe the reference,
  which looks exactly like a hang. Round trip supplies it for you.
- **`STARLING_DEVICE=cpu` is required** for synthesis and is baked into the
  scripts. On `mps`, OmniVoice segfaults in fp16 and emits near-silence in
  fp32 — the second being far more dangerous, since it fails without an error.

## Documentation

[CLAUDE.md](./CLAUDE.md) — architecture, invariants, and the hardware
constraints that shaped the design.
