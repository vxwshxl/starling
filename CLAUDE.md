# Starling

Speech-to-speech AI assistant for low-resource Northeast Indian languages.
A user speaks a health question in their language and hears the answer back
**in their own cloned voice**.

Built for the NEST symposium hackathon (MDoNER / North Eastern Council /
IIT Guwahati). Named for the hill myna of Northeast India — a starling, and one
of the few birds that mimics human speech.

## Architecture

The pipeline is **cascaded, not end-to-end**:

```
VAD -> ASR -> translate to English -> RAG+LLM -> translate back -> TTS
```

The user's own input audio is reused as the voice-cloning reference for TTS,
which is what makes the reply come back in their voice.

**Phase 1 (current) implements only the two ends**: ASR and TTS, wired together
by `roundtrip()` with nothing in between, so the assistant repeats you back to
yourself. The seam where translation/RAG/LLM will slot in is marked in
`pipeline.py` with `PHASE 2 SEAM`.

## Commands

All from the repo root unless noted.

| What | Command |
|---|---|
| Install Python deps | `pnpm setup:api` (or `cd services/asr && uv sync`) |
| Install web deps | `pnpm install` |
| Smoke check (no weights) | `pnpm smoke` |
| Run the API | `pnpm dev:api` → http://127.0.0.1:8000 |
| Run the Gradio lab | `pnpm lab` → http://127.0.0.1:7860 |
| Run the web shell | `pnpm dev:web` → http://localhost:3000 |
| Build the web shell | `pnpm build:web` |
| API docs | http://127.0.0.1:8000/docs |

The **Gradio lab is the primary debugging surface** — three tabs (ASR alone,
TTS alone, round trip), each showing per-stage timings, the language caveats
and the full traceback on error.

### API

```
GET  /health       liveness + what is resident. Never loads a model.
GET  /languages    the LANGUAGES config, for the web dropdown
POST /asr          multipart: audio, language        -> text + timings
POST /tts          form: text, language, [reference_audio, reference_text]
POST /roundtrip    multipart: audio, language        -> text + cloned audio
GET  /audio/{name} fetch a generated WAV
POST /unload       free model memory
```

## Invariants

These are not preferences. Breaking one causes subtle, hard-to-trace bugs.

1. **All audio entering a model is 16 kHz, mono, WAV.** Normalise at the
   boundary via `audio.to_wav_16k()`. Never trust an upload's format.
2. **OmniVoice output is 24 kHz, not 16 kHz.** Always write it with
   `model.sampling_rate`, never a hardcoded constant.
3. **Languages are configured in ONE place** — the `LANGUAGES` dict in
   `languages.py`. Never hardcode a language code in pipeline logic. Ask
   `languages.asr_code_for()` / `languages.tts_code_for()`.
4. **Models load once at first use and stay in memory.** Never load
   per-request. Loaders live in `models.py` behind locks.
5. **Every pipeline stage logs its own wall-clock duration** via
   `timing.Timings.stage()`. Every pipeline function returns
   `(result, timings)`.
6. **Prefer Apple-native (MLX / Core ML / ONNX).** This is an M4 MacBook Air;
   there is no CUDA. But **torch MPS is not safe for OmniVoice** — see below.
   Run the API with `STARLING_DEVICE=cpu`.

## Hardware and constraints

MacBook Air M4, fanless, **16 GB unified memory** shared between CPU and GPU.
That budget is the binding constraint:

- Whisper large-v3 (MLX, fp16) is ~3 GB.
- OmniVoice brings its own stack plus the higgs-audio-v2 audio tokenizer.
- So models must be **unloadable** — `models.unload_all()`, and a button for it
  in the lab UI.
- **Do not let OmniVoice auto-transcribe reference audio.** If `ref_text` is
  omitted, `generate()` quietly loads a *second* Whisper (`whisper-large-v3-turbo`)
  just to transcribe the reference. We always pass `ref_text`, and load the
  model with `load_asr=False`.
- OmniVoice's audio tokenizer does not support MPS (output channels > 65536)
  and silently falls back to CPU. Expect TTS to be partly CPU-bound.
- **torch MPS is broken for OmniVoice on torch 2.13.0. Measured, twice:**
  - `device_map="mps", dtype=float16` — **SIGSEGV** while loading weights, in
    `copy_cast_kernel_mps` → `MetalShaderLibrary::exec_unary_kernel`. Confirmed
    from the macOS crash report (`EXC_BAD_ACCESS` at `0x0`), not inferred from
    an exit code. It is *not* an out-of-memory kill.
  - `device_map="mps", dtype=float32` — loads and runs, then emits
    **near-silence**: 0.40 s of audio at peak 0.019, versus CPU's 1.73 s at
    peak 0.278 for the same text. This is the dangerous one: no crash, no
    error, just a silent WAV.
  - `device_map="cpu"` (either dtype) produces real speech. **Use CPU.**
  - So: verify TTS output by measuring RMS/peak, never by checking that the
    call returned. A green exit code here means nothing.

## Language support

Verified against the installed packages, not assumed:

| Language | ISO | Script | ASR | TTS (OmniVoice) |
|---|---|---|---|---|
| Assamese | `as` | Bengali-Assamese | `as` native — Whisper | `as` native |
| Bodo | `brx` | **Devanagari** | `brx` native — IndicConformer | `brx` native |
| Sylheti / Barak Bengali | `bn` | Bengali-Assamese | `bn` native — Whisper | `bn` **FALLBACK** |
| Khasi | `kha` | Latin | none | none — *disabled* |
| Mizo | `lus` | Latin | none | `lus` native — *disabled* |

The key asymmetry: **ASR and TTS do not cover the same languages**, so every
language carries a separate code *and* a separate "is this real?" flag for each
stage. Whisper knows 100 languages; OmniVoice knows 646.

**There is no longer one recogniser.** Whisper has no Bodo at any model size,
so `Language.asr_backend` names a backend per language and `models.get_asr()`
routes on it. Both backends can be resident at once.

- **Bodo is written in Devanagari, not Bengali script.** Do not assume otherwise.
- Bodo ASR runs on **AI4Bharat IndicConformer via ONNX Runtime**, not Whisper.
  Use the `OpenVoiceOS/ai4bharat-indicconformer-*-onnx` exports: the upstream
  `ai4bharat/*` repos are **gated** behind a terms click, these carry the same
  weights (see each card's `base_model`) and are MIT. One repo per language,
  ~590 MB each; `as` and `bn` exports exist too if Whisper is ever dropped.
- Khasi is unreachable today. If a hill language is needed for the demo, **use
  Mizo** — OmniVoice can at least speak it.

## Layout

```
apps/web/               Next.js 15 App Router, TS, Tailwind 4. Phase 1: a
                        health-check shell and nothing more.
services/asr/           Python 3.11, FastAPI, managed with uv (NOT pip/conda).
  starling/
    config.py           env -> settings. The only module reading os.environ.
    languages.py        THE LANGUAGES config. Single source of truth.
    audio.py            to_wav_16k() via ffmpeg subprocess
    asr_backends.py     ASRBackend protocol, MLXWhisperBackend (as, bn) and
                        IndicConformerBackend (brx, ONNX). Per-language routing
                        lives in models.get_asr().
    models.py           lazy singleton loaders, unload_all()
    timing.py           Timings.stage() context manager
    pipeline.py         transcribe(), synthesize(), roundtrip()
    main.py             FastAPI app
    lab.py              Gradio debug UI  <- primary debugging surface
    smoke.py            fast checks, loads no weights
```

## Working rules for this repo

- **Do not guess third-party APIs.** `omnivoice` and `mlx-whisper` are recent
  and may not be in training data. Read the installed source under
  `services/asr/.venv/lib/python3.11/site-packages/` and write against what is
  actually there. If an API is ambiguous, stop and ask.
  - Confirmed real API, as of `omnivoice` 0.2.1:
    `OmniVoice.from_pretrained(repo, device_map=..., dtype=torch.float16, load_asr=False)`
    then `model.generate(text=, language=, ref_audio=, ref_text=, num_step=,
    guidance_scale=, speed=) -> list[np.ndarray]`, and `model.sampling_rate`.
  - Confirmed real API, `mlx-whisper` 0.4.3:
    `mlx_whisper.transcribe(audio, *, path_or_hf_repo=..., language=..., ...)`.
  - Confirmed real API, `onnx-asr` 0.12.0:
    `onnx_asr.load_model(repo) -> TextResultsAsrAdapter`, then
    `adapter.recognize(path_or_ndarray, *, sample_rate=16000) -> str`.
    onnxruntime picks CoreML on Apple Silicon by itself.
- **Never download model weights during setup.** They download on first real
  use. Warn that it takes a while.
- Ask before installing anything heavy or not already listed.
- Small commits, clear messages.
- `smoke.py` must keep passing and must never load weights.

## Explicitly NOT in phase 1

No translation, no LLM, no RAG, no Supabase, no auth, no streaming, no
WebSockets, no Docker, no tests beyond the smoke check. Do not build ahead.
