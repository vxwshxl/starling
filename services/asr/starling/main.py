"""FastAPI surface for the Starling speech service.

    GET  /health      is the service up, what is resident, which languages
    GET  /languages   the LANGUAGES config, for the web app's dropdown
    POST /asr         audio -> text
    POST /tts         text (+ optional reference audio) -> audio
    POST /roundtrip   audio -> text -> audio in the speaker's cloned voice
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

from . import chat, languages, models, pipeline
from .config import settings

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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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
) -> dict[str, Any]:
    try:
        if reference_audio is not None:
            with _saved_upload(reference_audio) as ref:
                result, timings = pipeline.synthesize(
                    text, language, reference_audio=ref, reference_text=reference_text
                )
        else:
            result, timings = pipeline.synthesize(text, language)
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
    """Answer a question from the offline knowledge base.

    Grounded by construction: when retrieval finds nothing, the language model
    is never called and a fixed refusal comes back with grounded=false.
    """
    try:
        result, timings = chat.answer(question, language)
        return {
            "result": {
                "text": result.text,
                "grounded": result.grounded,
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
