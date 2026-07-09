import { randomInt } from 'crypto';
import { db } from '../config/db';

/** Build a referral code from a name, e.g. "Amara Obi" → "AMARA742". */
export async function generateReferralCode(name: string): Promise<string> {
  const base = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'DUEVY';
  for (let i = 0; i < 6; i++) {
    const code = `${base}${randomInt(100, 1000)}`;
    if (!(await db.user.findUnique({ where: { referralCode: code } }))) return code;
  }
  return `${base}${Date.now().toString().slice(-5)}`;
}

/** Fixed referral bounty, credited when a referred rep's space takes its first payment. */
export const REFERRAL_REWARD_KOBO = 50_000; // ₦500
