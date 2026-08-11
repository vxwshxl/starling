"""FastAPI surface for the Starling speech service.

    GET  /health      is the service up, what is resident, which languages
    GET  /languages   the LANGUAGES config, for the web app's dropdown
    POST /asr         audio -> text
    POST /tts         text (+ optional reference audio) -> audio
    POST /roundtrip   audio -> text -> audio in the speaker's cloned voice
    POST /translate   one string, between English and one Indic language
    POST /translate/batch   many page segments at once, cached and deduped
    POST /agent/act   one browsing action, for the Chrome extension
    POST /unload      free model memory

Models are NOT warmed at startup. First real request pays the download and
load cost; /health stays instant so the web shell can poll it.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import agent, chat, languages, models, page, pipeline, tasks, translate
from .config import settings
from .translate_cache import cache as translation_cache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
)
logger = logging.getLogger("starling.api")

app = FastAPI(
    title="Starling speech service",
    version="0.1.0",
    description="ASR and zero-shot voice-cloning TTS for Northeast Indian languages",
)

# The Next.js shell runs on :3000 and this on :8000. Local dev only.
#
# Any loopback port, not just 3000: Next picks 3001 whenever 3000 is taken,
# and pinning the list meant that perfectly ordinary case surfaced as "No
# response from http://127.0.0.1:8000" with nothing to say it was CORS. The
# service binds to 127.0.0.1 and holds no credentials, so the widening buys
# a real convenience at no exposure -- an attacker who can already run code
# on this machine does not need a browser's help.
#
# `chrome-extension://` is here for apps/extension. A service worker's fetch
# carries its own extension origin, NOT the page's and not a loopback one, so
# without this every extension request fails preflight -- and it fails as a
# bare "Failed to fetch" in the worker's console with nothing pointing at
# CORS, which is an afternoon lost if you have not seen it before. The
# extension id changes every time it is loaded unpacked, so the id itself
# cannot be pinned; the scheme is the tightest thing available.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(http://(localhost|127\.0\.0\.1)(:\d+)?|chrome-extension://[a-p]+)",
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def _saved_upload(upload: UploadFile) -> Iterator[Path]:
    """Persist an upload to a temp file, since ffmpeg needs a real path."""
    suffix = Path(upload.filename or "audio").suffix or ".bin"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        shutil.copyfileobj(upload.file, tmp)
        tmp.close()
        yield Path(tmp.name)
    finally:
        Path(tmp.name).unlink(missing_ok=True)


def _fail(exc: Exception) -> HTTPException:
    """Surface the real error text. This is a debug service, not public API."""
    logger.exception("request failed")
    return HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@app.get("/health")
def health() -> dict[str, Any]:
    """Cheap liveness probe. Never loads a model."""
    return {
        "status": "ok",
        "service": "starling-asr",
        "version": "0.1.0",
        "models": models.status(),
        "languages": [lang.code for lang in languages.enabled()],
    }


@app.get("/languages")
def list_languages() -> dict[str, Any]:
    return {
        "default": languages.DEFAULT_LANGUAGE,
        "languages": [
            {
                "code": lang.code,
                "name": lang.name,
                "native_name": lang.native_name,
                "iso": lang.iso,
                "script": lang.script,
                "script_name": lang.script_name,
                "asr_native": lang.asr_native,
                "tts_native": lang.tts_native,
                "warnings": lang.warnings(),
            }
            for lang in languages.enabled()
        ],
    }


@app.post("/asr")
async def asr(
    audio: UploadFile = File(...),
    language: str = Form(languages.DEFAULT_LANGUAGE),
) -> dict[str, Any]:
    try:
        with _saved_upload(audio) as path:
            result, timings = pipeline.transcribe(path, language)
        return {"result": result.as_dict(), "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language: str = Form(languages.DEFAULT_LANGUAGE),
    reference_audio: UploadFile | None = File(None),
    reference_text: str | None = Form(None),
    backend: str | None = Form(None),
) -> dict[str, Any]:
    """Synthesise speech. `backend` is "local", "modal", or omitted for the
    configured default -- per request, so the UI toggle needs no restart."""
    try:
        if reference_audio is not None:
            with _saved_upload(reference_audio) as ref:
                result, timings = pipeline.synthesize(
                    text,
                    language,
                    reference_audio=ref,
                    reference_text=reference_text,
                    backend=backend,
                )
        else:
            result, timings = pipeline.synthesize(text, language, backend=backend)
        return {"result": result.as_dict(), "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/roundtrip")
async def roundtrip(
    audio: UploadFile = File(...),
    language: str = Form(languages.DEFAULT_LANGUAGE),
) -> dict[str, Any]:
    try:
        with _saved_upload(audio) as path:
            payload, timings = pipeline.roundtrip(path, language)
        return {**payload, "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/audio/{name}")
def get_audio(name: str) -> FileResponse:
    """Fetch a generated WAV by filename, as returned in `synthesis.audio_path`."""
    path = Path(tempfile.gettempdir()) / "starling" / name
    if not path.is_file() or path.suffix != ".wav":
        raise HTTPException(status_code=404, detail=f"No such audio: {name}")
    return FileResponse(path, media_type="audio/wav")


@app.post("/chat")
def chat_endpoint(
    question: str = Form(...),
    language: str = Form("en"),
) -> dict[str, Any]:
    """Answer a question, in the language it was asked in.

    `kind` says where the answer came from and callers must surface it:
    "answer" is grounded in retrieved passages and carries `sources`,
    "general" is the model's own knowledge with nothing behind it, and
    "small_talk" is fixed text. Only the first is sourced.
    """
    try:
        result, timings = chat.answer(question, language)
        return {
            "result": {
                "text": result.text,
                "text_en": result.text_en,
                "grounded": result.grounded,
                "kind": result.kind,
                "language": result.language,
                "warnings": result.warnings,
                "sources": [
                    {
                        "id": s.id,
                        "title": s.title,
                        "sector": s.sector,
                        "score": s.score,
                    }
                    for s in result.sources
                ],
            },
            "timings": timings.as_dict(),
        }
    except Exception as exc:
        raise _fail(exc) from exc


# ---------------------------------------------------------------------------
# Translation and browsing, for apps/extension
# ---------------------------------------------------------------------------
#
# These three take JSON rather than form data, unlike everything above. The
# callers are a service worker sending arrays of page segments and objects of
# page elements, which multipart cannot express without the caller flattening
# it by hand.


class TranslateRequest(BaseModel):
    text: str
    source: str = "en"
    target: str


class BatchTranslateRequest(BaseModel):
    segments: list[str]
    source: str = "en"
    target: str
    use_cache: bool = True


class AgentRequest(BaseModel):
    goal: str
    url: str = ""
    title: str = ""
    language: str = "en"
    elements: list[dict[str, Any]] = Field(default_factory=list)
    history: list[dict[str, Any]] = Field(default_factory=list)
    text: str = ""
    """An extract of the page's visible prose, so the agent can answer a
    question outright instead of clicking around to find what it already has."""

    goal_en: str = ""
    """An already-translated goal from POST /route, so the same sentence is
    not sent through Sarvam twice."""

    conversation: list[dict[str, Any]] = Field(default_factory=list)
    """Earlier turns of the chat, as {role, text}. The panel is a
    conversation, so "now add it to the cart" has to resolve against what was
    being discussed several turns ago."""


@app.post("/translate")
def translate_one(req: TranslateRequest) -> dict[str, Any]:
    """Translate one string. English on one side; see translate.py for why."""
    try:
        if req.source == req.target:
            return {"result": {"text": req.text, "source": req.source,
                               "target": req.target}, "timings": {}}
        from .timing import Timings

        timings = Timings()
        with timings.stage("translate"):
            if req.source == "en":
                out = translate.from_english(req.text, req.target)
            elif req.target == "en":
                out = translate.to_english(req.text, req.source)
            else:
                raise ValueError(
                    "Sarvam-Translate is English<->Indic only. Pivot through "
                    "English explicitly if you want Indic->Indic."
                )
        return {
            "result": {"text": out, "source": req.source, "target": req.target},
            "timings": timings.as_dict(),
        }
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/translate/batch")
def translate_batch(req: BatchTranslateRequest) -> dict[str, Any]:
    """Translate many page segments at once.

    The returned list is positionally aligned with `segments`, always -- the
    extension writes results back into DOM nodes by index, so a filtered or
    reordered reply would scramble the page rather than fail. Segments with
    nothing translatable in them come back unchanged and are counted as
    skipped.
    """
    try:
        result, timings = page.translate_segments(
            req.segments,
            source=req.source,
            target=req.target,
            use_cache=req.use_cache,
        )
        return {"result": result.as_dict(), "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/translate/cache")
def translation_cache_status() -> dict[str, Any]:
    return {"entries": translation_cache.size()}


@app.post("/translate/cache/clear")
def clear_translation_cache() -> dict[str, Any]:
    """Forget every cached segment. The cache holds text from pages the user
    browsed, so this is offered in the extension's UI, not just here."""
    return {"cleared": translation_cache.clear()}


class PageQuestion(BaseModel):
    question: str
    text: str
    url: str = ""
    title: str = ""
    language: str = "en"


@app.post("/page/ask")
def page_ask(req: PageQuestion) -> dict[str, Any]:
    """Answer a question about the page, at length, without acting on it.

    Separate from /agent/act because the two prompts pull against each other:
    the action prompt is built to emit one JSON verb and is measurably bad at
    emitting twelve sentences of prose. See PAGE_QA_PROMPT in agent.py.
    """
    try:
        decision, timings = agent.answer_page(
            req.question,
            text=req.text,
            url=req.url,
            title=req.title,
            language=req.language,
        )
        return {"result": decision.as_dict(), "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/agent/act")
def agent_act(req: AgentRequest) -> dict[str, Any]:
    """Decide ONE browsing action from a page snapshot.

    Stateless by design: the loop lives in the extension, which is the only
    side that can see the live DOM. See agent.py.
    """
    try:
        decision, timings = agent.decide(
            req.goal,
            url=req.url,
            title=req.title,
            elements=req.elements,
            history=req.history,
            text=req.text,
            language=req.language,
            conversation=req.conversation,
            goal_en=req.goal_en,
        )
        return {"result": decision.as_dict(), "timings": timings.as_dict()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/unload")
def unload() -> dict[str, Any]:
    """Free everything. Kept for the lab's existing button."""
    return {"freed": models.unload_all(), "models": models.status()}


@app.post("/models/{target}/load")
def load_model(
    target: str, language: str = Form(languages.DEFAULT_LANGUAGE)
) -> dict[str, Any]:
    """Warm one model so the UI can pay the load cost on a button press.

    `language` only matters for ASR, which has one recogniser per language.
    """
    try:
        return {"models": models.load(target, language)}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/models/{target}/unload")
def unload_model(target: str) -> dict[str, Any]:
    """Free one model: 'asr', 'tts' or 'all'."""
    try:
        return {"freed": models.unload(target), "models": models.status()}
    except Exception as exc:
        raise _fail(exc) from exc


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
