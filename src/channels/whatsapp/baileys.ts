import { mkdir } from 'node:fs/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  type WAMessage,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
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
    // Direct chats only (ignore groups, status, broadcasts).
    if (!jid.endsWith('@s.whatsapp.net')) return;
    const text = extractText(m.message as Record<string, unknown> | null | undefined);
    if (!text) return;

    const number = jid.split('@')[0]!.replace(/[^\d]/g, '');
    const sock = this.sock;
    if (!sock) return;

    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    let reply: string;
    try {
      reply = await handleWhatsappMessage(number, text);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'whatsapp agent error');
      reply = 'Sorry, something went wrong on my side. Please try again in a moment.';
    }
    await sock.sendMessage(jid, { text: reply });
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
  if (channel) return;
  channel = new BaileysChannel();
  await channel.start();
}

export async function stopWhatsappBot(): Promise<void> {
  await channel?.stop();
  channel = null;
}
