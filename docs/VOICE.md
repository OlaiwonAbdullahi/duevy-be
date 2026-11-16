# Voice notes (speech-to-text)

Reps can send Duey a **WhatsApp voice note** and it responds just like a typed
message. This is popular with Nigerian users, who often prefer voice over typing.

## How it works

```
WhatsApp voice note (OGG/Opus)
  → Baileys downloads the audio                       (src/channels/whatsapp/baileys.ts)
  → POST bytes to the STT sidecar /transcribe         (src/ai/stt.ts)
  → faster-whisper transcribes locally → text         (stt/app.py)
  → handleWhatsappMessage(number, transcript)         (the existing agent, untouched)
  → reply, prefixed with "🎙️ I heard: …" so mis-hearings are easy to catch
```

The agent is **unchanged** — it only ever sees text. STT is a thin layer in
front of it, behind a `transcribe(audio) → text` contract, so the provider is
swappable (local faster-whisper by default; a Riva/NIM or other `/transcribe`
endpoint later) with no code change — just `STT_URL`.

## Why faster-whisper (local)

- **No API key, no usage cap, works offline** — nothing to run out of before a
  demo. The only one-time cost is downloading the model (cached after that).
- The LLM (Nemotron) stays on NIM; STT runs on your own CPU/GPU, so voice-note
  testing never eats into NIM credits.

## Setup

1. Start the sidecar (see [stt/README.md](../stt/README.md)):
   ```bash
   cd stt
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn app:app --port 8001
   ```
2. In the backend `.env`:
   ```
   STT_ENABLED=true
   STT_URL=http://localhost:8001
   ```
3. Send a voice note to the WhatsApp bot.

If `STT_ENABLED=false`, a voice note gets a polite "please type" reply; if the
sidecar is down or the audio can't be transcribed, Duey asks the rep to try again
or type — it never crashes the chat.

## Accuracy notes

- Nigerian-accented English transcribes well on `small`/`medium`; `large-v3`
  (GPU) is best. Pidgin and code-switching vary by model — **test real voice
  notes before the demo**.
- The "🎙️ I heard: …" echo is deliberate: it lets the rep confirm Duey got the
  amount/bank/name right before it acts.
