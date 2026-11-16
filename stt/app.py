"""
Duevy speech-to-text sidecar — local, no API key, no usage cap.

A tiny FastAPI service that turns an uploaded voice note into text with
faster-whisper (CTranslate2). The Node backend POSTs the raw audio bytes to
/transcribe and gets back { text, language, duration }; the transcript then
flows into the same text agent as a typed message.

Everything runs on this machine. The Whisper model downloads once from Hugging
Face (public, no token) and is cached locally, after which it works fully
offline. faster-whisper decodes OGG/Opus (WhatsApp voice notes), mp3, wav, etc.
via the bundled PyAV/ffmpeg — no system ffmpeg needed.

Run:
    cd stt
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app:app --port 8001

Config (env):
    WHISPER_MODEL    tiny | base | small | medium | large-v3   (default: small)
    WHISPER_DEVICE   cpu | cuda                                 (default: cpu)
    WHISPER_COMPUTE  int8 | int8_float16 | float16 | float32    (default: int8)
    WHISPER_LANGUAGE force a language code, e.g. "en"; unset = auto-detect
"""

import os
import io
import logging

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("duevy-stt")

MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")
DEFAULT_LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None

app = FastAPI(title="Duevy STT", version="1.0.0")

# Loaded once at startup; the first run downloads the model, then it's cached.
log.info("loading faster-whisper model=%s device=%s compute=%s", MODEL_SIZE, DEVICE, COMPUTE_TYPE)
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
log.info("model ready")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str | None = Form(default=None)):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty audio")

    # VAD filtering skips silence so short/quiet notes don't hallucinate text.
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes),
        language=language or DEFAULT_LANGUAGE,
        vad_filter=True,
        beam_size=5,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()

    return {
        "text": text,
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
    }
