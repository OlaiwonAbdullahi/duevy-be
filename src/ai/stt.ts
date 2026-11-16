import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Speech-to-text for inbound voice notes. Transport-agnostic: WhatsApp (or any
 * channel) hands us the raw audio bytes, we POST them to the configured STT
 * service (the bundled faster-whisper sidecar by default, see stt/) and get back
 * a transcript, which then flows into the SAME text agent as a typed message.
 *
 * The provider is just a URL, so the local, no-key, no-cap faster-whisper service
 * can be swapped for NVIDIA Riva/NIM or any other /transcribe endpoint with the
 * same contract — the agent never changes. Returns null (never throws) when STT
 * is off or the transcription fails, so the caller can fall back to asking the
 * rep to type.
 */

export interface Transcription {
  text: string;
  language?: string;
  durationSec?: number;
}

/** POST audio to the STT sidecar's /transcribe. `null` = disabled or unusable. */
export async function transcribeAudio(audio: Buffer, mimeType: string, filename = 'voice-note'): Promise<Transcription | null> {
  if (!env.STT_ENABLED) return null;
  if (audio.length === 0) return null;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'application/octet-stream' }), filename);

  const url = `${env.STT_URL.replace(/\/+$/, '')}/transcribe`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(env.STT_TIMEOUT_MS) });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'stt request did not complete');
    return null;
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, 'stt request failed');
    return null;
  }

  const data = (await res.json().catch(() => null)) as { text?: string; language?: string; duration?: number } | null;
  const text = data?.text?.trim();
  if (!text) {
    logger.debug({ ms: Date.now() - started }, 'stt returned no text');
    return null;
  }
  logger.debug({ ms: Date.now() - started, language: data?.language, chars: text.length }, 'stt transcribed voice note');
  return { text, language: data?.language, durationSec: data?.duration };
}
