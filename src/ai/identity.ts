import { db } from '../config/db';
import { signAccessToken } from '../lib/jwt';
import { logger } from '../lib/logger';

/**
 * Channel identity → Duevy rep. The agent needs to know which account it is
 * acting for (web session or linked WhatsApp number), which spaces they rep,
 * and a short-lived access token to call the REST API as them (api.ts).
 */

export interface RepSpace {
  id: string;
  name: string;
  short: string;
  repRole: string;
}

export interface RepContext {
  userId: string;
  name: string;
  role: string;
  spaces: RepSpace[];
}

export async function loadRepContext(userId: string): Promise<RepContext | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      role: true,
      isSuspended: true,
      isDeactivated: true,
      spaceReps: {
        select: { role: true, space: { select: { id: true, name: true, short: true, isArchived: true } } },
      },
    },
  });
  if (!user || user.isSuspended || user.isDeactivated) return null;
  const spaces = user.spaceReps
    .filter((r) => !r.space.isArchived)
    .map((r) => ({ id: r.space.id, name: r.space.name, short: r.space.short, repRole: r.role }));
  return { userId: user.id, name: user.name, role: user.role, spaces };
}

/** The Duevy user bound to a WhatsApp number, if any. */
export async function findUserIdByWhatsapp(number: string): Promise<string | null> {
  const u = await db.user.findUnique({ where: { whatsappNumber: number }, select: { id: true } });
  return u?.id ?? null;
}

/** A short-lived access token the agent uses to call the REST API as this rep. */
export async function mintToken(ctx: RepContext): Promise<string> {
  return signAccessToken({ sub: ctx.userId, role: ctx.role, spaceIds: ctx.spaces.map((s) => s.id) });
}

// ---------------------------------------------------------------------------
// WhatsApp account linking
//
// From the web dashboard a rep requests a 6-digit code (POST /ai/link/whatsapp).
// They send it to the bot, which binds their number to the account. Codes are
// one-time and short-lived; kept in memory (single-instance demo scope).
// ---------------------------------------------------------------------------

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const linkCodes = new Map<string, { userId: string; expiresAt: number }>();

function sixDigits(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function createLinkCode(userId: string): { code: string; expiresInMinutes: number } {
  // Drop expired entries so the map can't grow forever.
  const now = Date.now();
  for (const [k, v] of linkCodes) if (v.expiresAt < now) linkCodes.delete(k);
  const code = sixDigits();
  linkCodes.set(code, { userId, expiresAt: now + LINK_CODE_TTL_MS });
  return { code, expiresInMinutes: LINK_CODE_TTL_MS / 60000 };
}

/** Bind `number` (E.164 digits) to the account that owns `code`. Returns the userId or null. */
export async function consumeLinkCode(code: string, number: string): Promise<string | null> {
  const entry = linkCodes.get(code.trim());
  if (!entry || entry.expiresAt < Date.now()) return null;
  linkCodes.delete(code.trim());
  // One number drives one account: clear it from anyone else, then bind it here.
  await db.user.updateMany({ where: { whatsappNumber: number }, data: { whatsappNumber: null } });
  await db.user.update({ where: { id: entry.userId }, data: { whatsappNumber: number } });
  logger.info({ userId: entry.userId }, 'whatsapp number linked');
  return entry.userId;
}
