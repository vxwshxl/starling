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

**The whole cascade is now built.** `POST /chat` runs the middle of it and
`chat.py` owns the orchestration:

```
question (native) -> translate in -> retrieve -> answer -> translate out -> reply (native)
```

English is the pivot everywhere. The knowledge base is English, the answering
model reasons in English, and the user's language goes on at the very end.
That is not a shortcut — it is the only arrangement in which a 3B model gives
a correct answer in Bodo.

`roundtrip()` in `pipeline.py` is the older ASR→TTS echo path and still exists;
it is the audio-only proof, not the product path.

**Three ways a question is answered**, and `ChatResult.kind` says which. The
UI must distinguish them, because `grounded` alone cannot:

| kind | source | carries sources | UI must say |
|---|---|---|---|
| `answer` | retrieved passages | yes | cites the passages |
| `general` | the model's own knowledge | no | "nothing behind this" |
| `small_talk` | fixed text, no model | no | nothing |

`general` is a deliberate loosening: a twenty-passage corpus cannot cover what
people actually ask, and refusing everything else made the assistant look
broken. Safety does not loosen with it — `llm.GENERAL_PROMPT` still forbids
diagnosis, medicine names and dosages, and still routes anything urgent to a
health centre.

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
POST /chat         form: question, language          -> text, text_en, kind,
                                                        sources, timings
POST /tts          form: text, language, [reference_audio, reference_text]
POST /roundtrip    multipart: audio, language        -> text + cloned audio
GET  /audio/{name} fetch a generated WAV
POST /models/{target}/load    warm one deliberately
POST /models/{target}/unload  free one
POST /unload       free model memory
```

`{target}` is `asr`, `tts`, `llm`, `translate` or `all`. The web Start button
uses `all`, because the answer path needs three of them and warming only one
left two multi-second loads inside the first question.

## Invariants

These are not preferences. Breaking one causes subtle, hard-to-trace bugs.

1. **All audio entering a model is 16 kHz, mono, WAV.** Normalise at the
   boundary via `audio.to_wav_16k()`. Never trust an upload's format.
2. **OmniVoice output is 24 kHz, not 16 kHz.** Always write it with
   `model.sampling_rate`, never a hardcoded constant.
3. **Languages are configured in ONE place** — the `LANGUAGES` dict in
   `languages.py`. Never hardcode a language code in pipeline logic. Ask
   `languages.asr_code_for()` / `tts_code_for()` / `translate_name_for()`.
   Three names per language, because all three models name them differently:
   Nepali is `ne` to ASR, `npi` to OmniVoice and `"Nepali"` to Sarvam.
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
- Qwen2.5-3B-Instruct-4bit (answering) is ~1.8 GB.
- Sarvam-Translate-4bit (translation) is ~2.6 GB.
- That is four models and roughly 10 GB with everything resident, on a machine
  that is also running a browser. So models must be **unloadable** —
  `models.unload("llm")`, `models.unload_all()`, and buttons for it in both UIs.
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

### TTS is the slow stage, and `num_step` is the dial

Cost is linear in `settings.tts_num_step` and in text length. Measured on this
machine, one 5.7 s utterance:

| num_step | wall clock | real-time factor | peak |
|---|---|---|---|
| 32 | 138.6 s | 25.9× | 0.500 |
| 16 | 68.0 s | 11.7× | 0.500 |
| **8** (default) | **34.3 s** | **6.1×** | 0.500 |
| 4 | 17.1 s | 3.0× | 0.500 |

32 was the old default and is unusable live. Peak held at 0.500 throughout, so
none of these is the near-silence failure mode above. Set `STARLING_TTS_STEPS=4`
if the demo needs the speed more than the fidelity — judge that by ear, not by
RMS. Short answers matter as much as the step count: the prompts cap replies at
2–4 sentences partly for this reason.

## Language support

Verified against the installed packages, not assumed:

| Language | ISO | Script | ASR | TTS (OmniVoice) | Translate (Sarvam) |
|---|---|---|---|---|---|
| Assamese | `as` | Bengali-Assamese | `as` native — Whisper | `as` native | `Assamese` |
| Bodo | `brx` | **Devanagari** | `brx` native — IndicConformer | `brx` native | `Bodo` |
| Sylheti / Barak Bengali | `bn` | Bengali-Assamese | `bn` native — Whisper | `bn` **FALLBACK** | `Bengali` **FALLBACK** |
| Manipuri (Meitei) | `mni` | Meetei Mayek | `mni` native — IndicConformer | `mni` native | `Manipuri` |
| Nepali | `ne` | Devanagari | `ne` native — IndicConformer | `npi` native | `Nepali` |
| Santali | `sat` | Ol Chiki | `sat` native — IndicConformer | `sat` native | `Santali` |
| Khasi | `kha` | Latin | none | none — *disabled* | none |
| Mizo | `lus` | Latin | none | `lus` native — *disabled* | none |

The key asymmetry: **the three stages do not cover the same languages**, so
every language carries a separate code *and* a separate "is this real?" flag
for each. Whisper knows 100 languages; OmniVoice knows 646; Sarvam-Translate
knows the 22 scheduled Indian languages, which happens to be all six of ours.

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

### Translation, and why not IndicTrans2

The blocker was never translation as such, it was IndicTrans2 specifically: it
needs a slow tokenizer that transformers 5 removed, and OmniVoice pins
transformers ≥ 5.3. **Sarvam-Translate sidesteps that entirely** — it is a
fine-tune of Gemma-3-4B-IT, so mlx-lm loads it like any other causal LM. Both
directions (English↔Indic) are supported; Indic↔Indic must pivot through
English, which is what the pipeline does anyway.

**Do not call it through `apply_chat_template`.** Every other model here goes
through the template and this one must not. The template shipped in the MLX
repo is broken in two ways that both produce fluent garbage rather than an
error, and both were initially misread as 4-bit quantisation damage:

1. It writes the instruction itself and derives the target language from the
   system message by splitting on `": "`. Passing the whole sentence as the
   system turn — which is what the upstream model card shows — yields
   *"Translate the text below to Translate the text below to Assamese.."*
2. It ignores `add_generation_prompt`, so there is no `<start_of_turn>model`
   cue and the model has to guess it is its turn.

The symptoms were repetition loops (`এক মিনিটৰ আগতে এক মিনিটৰ আগতে`), Santali
and Manipuri collapsing to one repeated syllable, and *"my son has a fever"*
coming back as *"I'm afraid I'm going to have to disappoint you."*
`translate._prompt()` builds the turn structure by hand instead. Also **do not
decode greedily** — `temp=0` reintroduces the loops; use `temp=0.2` with a
repetition penalty.

## Layout

```
apps/web/               Next.js 15 App Router, TS, Tailwind 4. The chatbot.
  src/components/chat/   chat-shell (threads + persistence), chat-sidebar,
                         chat-messages, chat-composer, mic-equalizer (live
                         input spectrum), audio-player (custom waveform
                         playback -- deliberately not <audio controls>)
services/asr/           Python 3.11, FastAPI, managed with uv (NOT pip/conda).
  starling/
    config.py           env -> settings. The only module reading os.environ.
    languages.py        THE LANGUAGES config. Single source of truth.
    audio.py            to_wav_16k() via ffmpeg subprocess
    asr_backends.py     ASRBackend protocol, MLXWhisperBackend (as, bn) and
                        IndicConformerBackend (brx, ONNX). Per-language routing
                        lives in models.get_asr().
    models.py           lazy singleton loaders, load()/unload() per target
    timing.py           Timings.stage() context manager
    knowledge.py        the ~20 English passages, by sector
    retrieval.py        BM25 over them. MIN_SCORE is measured, not guessed.
    llm.py              answer() grounded, answer_general() ungrounded
    translate.py        Sarvam-Translate, both legs. Read its docstring first.
    chat.py             orchestrates the middle of the cascade
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
  - Confirmed real API, `mlx-lm` 0.31.3:
    `load(repo) -> (model, tokenizer)`, `generate(model, tokenizer, prompt=,
    max_tokens=, sampler=, logits_processors=, verbose=) -> str`,
    `sample_utils.make_sampler(temp=, top_p=)` and
    `make_logits_processors(repetition_penalty=)`.
- **Never download model weights during setup.** They download on first real
  use. Warn that it takes a while.
- Ask before installing anything heavy or not already listed.
- Small commits, clear messages.
- `smoke.py` must keep passing and must never load weights.

## Explicitly NOT built

No Supabase, no auth, no streaming, no WebSockets, no Docker, no tests beyond
the smoke check. Chat history lives in the browser's localStorage, not on the
server — these are the user's own health questions and the premise is that
nothing leaves the machine. Do not build ahead.
