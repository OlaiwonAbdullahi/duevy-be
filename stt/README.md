# Duevy STT sidecar (faster-whisper)

Local speech-to-text for WhatsApp voice notes. **No API key, no usage cap, runs
offline** after the first model download. The Node backend POSTs audio to
`/transcribe`; the transcript then flows into the normal text agent.

## Why a separate service?
faster-whisper is a Python library; the Duevy backend is Node. This tiny FastAPI
service bridges them over HTTP, behind the same `transcribe(audio) → text`
contract — so you can later swap it for NVIDIA Riva/NIM or any other
`/transcribe` endpoint without touching the agent.

## Run it

```bash
cd stt
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 8001
```

The first start downloads the Whisper model from Hugging Face (public, no token):
`small` ≈ 0.5 GB, `large-v3` ≈ 3 GB. After that it's cached and works offline.

## Point the backend at it

In the backend `.env`:

```
STT_ENABLED=true
STT_URL=http://localhost:8001
```

Then send a WhatsApp voice note to the bot — it transcribes and replies, echoing
what it heard so you can catch mis-hearings.

## Config (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium`/`large-v3` — bigger = more accurate, slower, more RAM. |
| `WHISPER_DEVICE` | `cpu` | `cuda` if you have an NVIDIA GPU. |
| `WHISPER_COMPUTE` | `int8` | `float16` on GPU for best accuracy/speed. |
| `WHISPER_LANGUAGE` | _(auto)_ | Force e.g. `en`; leave unset to auto-detect (handles code-switching better). |

For Nigerian-accented English + some pidgin, `small`/`medium` are the CPU sweet
spot; `large-v3` on a GPU is best. Test with real voice notes before the demo.

## API

- `GET /health` → `{ "status": "ok", "model": "...", "device": "..." }`
- `POST /transcribe` (multipart: `file`, optional `language`) → `{ "text", "language", "duration" }`
