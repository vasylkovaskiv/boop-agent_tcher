"""FastAPI sidecar that wraps faster-whisper for the boop-agent Telegram bot.

Boop's Node process sends a JSON payload `{ "url": "<download_url>" }` here
when the user sends a Telegram voice/audio note. The sidecar downloads the
file (Telegram file links are short-lived but valid for ~1 hour) and runs
faster-whisper on it. Returns plain JSON `{ text, language, duration }`.

The model is loaded once at process start so the first request only pays the
download/transcribe cost. Subsequent requests reuse the in-memory model.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [whisper] %(message)s")
log = logging.getLogger("whisper")

MODEL_NAME = os.getenv("WHISPER_MODEL", "medium")
COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None  # None -> autodetect
DOWNLOAD_TIMEOUT = float(os.getenv("WHISPER_DOWNLOAD_TIMEOUT", "60"))
BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))

log.info("loading model=%s device=%s compute=%s", MODEL_NAME, DEVICE, COMPUTE)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
log.info("model ready")

app = FastAPI(title="boop-whisper", version="0.1.0")


class TranscribeRequest(BaseModel):
    url: str
    # Override the configured language for this single request. Useful when the
    # caller already knows the user's language (we don't, currently, but the
    # field is here for the future).
    language: Optional[str] = None


class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str] = None
    duration: Optional[float] = None


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT) as client:
        r = await client.get(url)
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"download failed: {r.status_code}",
        )
    return r.content


def _transcribe_sync(path: str, language: Optional[str]) -> TranscribeResponse:
    segments, info = model.transcribe(
        path,
        language=language,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    text = "".join(seg.text for seg in segments).strip()
    return TranscribeResponse(text=text, language=info.language, duration=info.duration)


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    log.info("transcribe url=%s", req.url[:80])
    blob = await _download(req.url)
    # faster-whisper accepts file paths; ffmpeg under the hood handles ogg/opus.
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=True) as tmp:
        tmp.write(blob)
        tmp.flush()
        # Run blocking work in the default executor so we don't pin the event loop.
        result = await asyncio.to_thread(
            _transcribe_sync, tmp.name, req.language or LANGUAGE
        )
    log.info(
        "transcribed lang=%s duration=%.2fs chars=%d",
        result.language,
        result.duration or 0.0,
        len(result.text),
    )
    return result


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE, "compute": COMPUTE}
