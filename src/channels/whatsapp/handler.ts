import { env } from '../../config/env';
import { handleMessage } from '../../ai/agent';
import { findUserIdByWhatsapp, consumeLinkCode } from '../../ai/identity';

/**
 * Turn one inbound WhatsApp message into a reply. Transport-agnostic (Baileys
 * calls it; a Twilio/Meta adapter could too):
 *
 *   - Unlinked number → walk them through linking (a code from the dashboard,
 *     sent as "link 123456").
 *   - Linked number → hand the text to the shared agent as that rep.
 */

const LINK_RE = /^\s*link\s+(\d{4,8})\s*$/i;

export async function handleWhatsappMessage(fromNumber: string, text: string): Promise<string> {
  const trimmed = text.trim();

  const link = trimmed.match(LINK_RE);
  if (link) {
    const userId = await consumeLinkCode(link[1]!, fromNumber);
    if (!userId) return "That link code is invalid or has expired. Get a fresh one from the Duevy dashboard (Settings → WhatsApp) and send it as: link 123456";
    return "✅ Your WhatsApp is now linked to Duevy. You can manage your dues, see who hasn't paid, check your balance and more — just ask. Try: \"how much have we collected?\"";
  }

  const userId = await findUserIdByWhatsapp(fromNumber);
  if (!userId) {
    return [
      "👋 Welcome to Duevy. This number isn't linked to a Duevy account yet.",
      `Sign in at ${env.FRONTEND_URL}, open Settings → WhatsApp to get a 6-digit code, then send it here as:`,
      'link 123456',
    ].join('\n');
  }

  return handleMessage(userId, trimmed);
}
