import { mkdir } from 'node:fs/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
  type WASocket,
  type WAMessage,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { transcribeAudio } from '../../ai/stt';
import { handleWhatsappMessage } from './handler';

/**
 * WhatsApp via Baileys — an UNOFFICIAL WhatsApp Web client (QR-linked). Fine for
 * a hackathon demo number; see docs/WHATSAPP.md for the ToS/ban caveat and how
 * to swap in the official Cloud API later. The session is persisted under
 * WHATSAPP_AUTH_DIR, so the QR is scanned once.
 *
 * Kept behind the MessagingChannel interface so the transport can be replaced
 * without touching the agent.
 */

export interface MessagingChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Pull the plain text out of a Baileys message, if it is one. */
function extractText(message: Record<string, unknown> | null | undefined): string | null {
  if (!message) return null;
  const conversation = message.conversation;
  if (typeof conversation === 'string' && conversation) return conversation;
  const extended = message.extendedTextMessage as { text?: string } | undefined;
  if (extended?.text) return extended.text;
  const imageCaption = (message.imageMessage as { caption?: string } | undefined)?.caption;
  if (imageCaption) return imageCaption;
  return null;
}

/** The voice-note (push-to-talk) or audio message on a Baileys message, if any. */
function extractAudio(message: Record<string, unknown> | null | undefined): { mimetype?: string } | null {
  const audio = message?.audioMessage as { mimetype?: string } | undefined;
  return audio ?? null;
}

class BaileysChannel implements MessagingChannel {
  private sock: WASocket | null = null;
  private stopping = false;

  async start(): Promise<void> {
    this.stopping = false;
    await mkdir(env.WHATSAPP_AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(env.WHATSAPP_AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.appropriate('Duevy'),
      // We print the QR ourselves from connection.update.
      printQRInTerminal: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('Scan this QR in WhatsApp → Linked devices to connect the Duevy bot:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        logger.info('whatsapp bot connected');
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'whatsapp connection closed');
        if (!this.stopping && !loggedOut) {
          setTimeout(() => void this.start().catch((err) => logger.error({ err: (err as Error).message }, 'whatsapp reconnect failed')), 3_000).unref();
        } else if (loggedOut) {
          logger.error(`whatsapp session logged out — delete ${env.WHATSAPP_AUTH_DIR} and restart to re-link`);
        }
      }
    });

    sock.ev.on('messages.upsert', (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const m of upsert.messages) {
        void this.onMessage(m).catch((err) => logger.warn({ err: (err as Error).message }, 'whatsapp message handling failed'));
      }
    });
  }

  private async onMessage(m: WAMessage): Promise<void> {
    const jid = m.key.remoteJid;
    if (!jid || m.key.fromMe) return;
    // Direct chats only (ignore groups @g.us, status@broadcast, newsletters).
    // Accept BOTH classic phone-number addressing (@s.whatsapp.net) and WhatsApp's
    // newer hidden LID addressing (@lid) — modern clients use @lid for 1:1 chats.
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;

    // The stable per-contact id we key the rep on. For @lid this is the LID, not
    // the phone number, but it's consistent for the same contact, so linking and
    // lookup still match. Prefer a phone-number alt from the key when present.
    const altJid = (m.key as { remoteJidAlt?: string }).remoteJidAlt;
    const idJid = altJid?.endsWith('@s.whatsapp.net') ? altJid : jid;
    const number = idJid.split('@')[0]!.replace(/[^\d]/g, '');
    const sock = this.sock;
    if (!sock) return;

    const message = m.message as Record<string, unknown> | null | undefined;
    let text = extractText(message);
    let viaVoice = false;

    // A voice note (or audio) with no caption: transcribe it, then treat the
    // transcript exactly like a typed message. The agent is untouched.
    if (!text && extractAudio(message)) {
      if (!env.STT_ENABLED) {
        await sock.sendMessage(jid, { text: 'I can only read text for now — please type your message.' });
        return;
      }
      await sock.sendPresenceUpdate('recording', jid).catch(() => {});
      const transcript = await this.transcribeVoiceNote(m);
      if (!transcript) {
        await sock.sendMessage(jid, { text: "I couldn't make out that voice note. Please try again, speak clearly, or type your message." });
        return;
      }
      text = transcript;
      viaVoice = true;
    }

    if (!text) return;

    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    let reply: string;
    try {
      reply = await handleWhatsappMessage(number, text);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'whatsapp agent error');
      reply = 'Sorry, something went wrong on my side. Please try again in a moment.';
    }
    // Echo what we heard so the rep can catch a mis-hearing before acting on it.
    const out = viaVoice ? `🎙️ I heard: “${text}”\n\n${reply}` : reply;
    await sock.sendMessage(jid, { text: out });
  }

  /** Download a voice note's audio and transcribe it via the STT sidecar. */
  private async transcribeVoiceNote(m: WAMessage): Promise<string | null> {
    const sock = this.sock;
    if (!sock) return null;
    try {
      // Baileys bundles its own pino; our logger is a compatible instance, so we
      // cast the whole context to the function's own (unexported) context type.
      const ctx = { logger, reuploadRequest: sock.updateMediaMessage } as unknown as NonNullable<
        Parameters<typeof downloadMediaMessage>[3]
      >;
      const buffer = (await downloadMediaMessage(m, 'buffer', {}, ctx)) as Buffer;
      const mimetype = extractAudio(m.message as Record<string, unknown> | null | undefined)?.mimetype ?? 'audio/ogg';
      const result = await transcribeAudio(buffer, mimetype);
      return result?.text ?? null;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'voice note download/transcription failed');
      return null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }
}

let channel: BaileysChannel | null = null;

/** Start the WhatsApp bot (idempotent). No-op unless WHATSAPP_ENABLED. */
export async function startWhatsappBot(): Promise<void> {
  if (!env.WHATSAPP_ENABLED) return;
  if (!env.AI_ENABLED) {
    logger.warn('WHATSAPP_ENABLED is true but AI_ENABLED is false; the bot needs the AI assistant. Not starting.');
    return;
  }
  // Cloud API is webhook-driven (routes/webhooks.ts → /webhooks/whatsapp), so
  // there is no socket to start here — just log that it's the active transport.
  if (env.WHATSAPP_PROVIDER === 'cloud') {
    logger.info('whatsapp transport: Meta Cloud API (inbound via /v1/webhooks/whatsapp)');
    return;
  }
  if (channel) return;
  channel = new BaileysChannel();
  await channel.start();
}

export async function stopWhatsappBot(): Promise<void> {
  await channel?.stop();
  channel = null;
}
