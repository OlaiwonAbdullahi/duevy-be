import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { transcribeAudio } from '../../ai/stt';
import { handleWhatsappMessage } from './handler';

/**
 * WhatsApp via Meta's OFFICIAL Cloud API (graph.facebook.com). Inbound messages
 * arrive as webhooks (see routes/webhooks.ts → /webhooks/whatsapp); we reply by
 * calling the Graph API. Unlike Baileys there is no socket to keep alive and no
 * ToS/ban risk. See docs/WHATSAPP_CLOUD.md.
 *
 * The agent is untouched: a text message (or a transcribed voice note) is handed
 * to the same handleWhatsappMessage used by the Baileys transport.
 *
 * NOTE: free-form replies are only allowed within 24h of the rep's last message
 * (Meta's customer-service window). Since the rep always messages first here,
 * that holds for the reactive chat; proactive pushes would need message templates.
 */

const GRAPH = 'https://graph.facebook.com';
const base = () => `${GRAPH}/${env.WHATSAPP_GRAPH_VERSION}`;
const authHeader = () => ({ Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` });

// --- Webhook auth ----------------------------------------------------------

/**
 * GET handshake: when Meta (re)subscribes the webhook it calls with hub.* query
 * params; echo hub.challenge back iff the verify token matches. Returns the
 * challenge string to send as the 200 body, or null to reject.
 */
export function verifyWebhookChallenge(query: Record<string, unknown>): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

/** Verify a webhook POST is really from Meta: HMAC-SHA256(rawBody, appSecret). */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Graph API calls -------------------------------------------------------

/** Send a plain-text WhatsApp message to a number (international digits, no +). */
async function sendText(toNumber: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${base()}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'whatsapp cloud send failed');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'whatsapp cloud send did not complete');
  }
}

/** Download a media object (e.g. a voice note) by id: resolve its URL, then fetch the bytes. */
async function downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const metaRes = await fetch(`${base()}/${mediaId}`, { headers: authHeader(), signal: AbortSignal.timeout(15_000) });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;
    // The media URL also requires the Bearer token.
    const fileRes = await fetch(meta.url, { headers: authHeader(), signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) return null;
    return { bytes: Buffer.from(await fileRes.arrayBuffer()), mime: meta.mime_type ?? 'audio/ogg' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'whatsapp cloud media download failed');
    return null;
  }
}

// --- Inbound processing ----------------------------------------------------

interface InboundMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
}

/**
 * Process one webhook POST body: for each inbound message, transcribe a voice
 * note if needed, run the agent, and reply. Status/delivery callbacks (which
 * carry `statuses`, not `messages`) are ignored. Never throws.
 */
export async function processCloudWebhook(body: unknown): Promise<void> {
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const messages = (change as { value?: { messages?: InboundMessage[] } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        await handleInbound(msg).catch((err) => logger.warn({ err: (err as Error).message }, 'whatsapp cloud message handling failed'));
      }
    }
  }
}

async function handleInbound(msg: InboundMessage): Promise<void> {
  const from = (msg.from ?? '').replace(/[^\d]/g, '');
  if (!from) return;

  let text: string | null = null;
  let viaVoice = false;

  if (msg.type === 'text') {
    text = msg.text?.body?.trim() || null;
  } else if (msg.type === 'audio' && msg.audio?.id) {
    // Voice note: download + transcribe, then treat the transcript as typed text.
    if (!env.STT_ENABLED) {
      await sendText(from, 'I can only read text for now — please type your message.');
      return;
    }
    const media = await downloadMedia(msg.audio.id);
    const transcription = media ? await transcribeAudio(media.bytes, media.mime) : null;
    if (!transcription?.text) {
      await sendText(from, "I couldn't make out that voice note. Please try again, speak clearly, or type your message.");
      return;
    }
    text = transcription.text;
    viaVoice = true;
  }

  if (!text) return; // unsupported message type (image, location, etc.)

  let reply: string;
  try {
    reply = await handleWhatsappMessage(from, text);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'whatsapp cloud agent error');
    reply = 'Sorry, something went wrong on my side. Please try again in a moment.';
  }
  // Echo what we heard so the rep can catch a mis-hearing before acting on it.
  const out = viaVoice ? `🎙️ I heard: “${text}”\n\n${reply}` : reply;
  await sendText(from, out);
}
