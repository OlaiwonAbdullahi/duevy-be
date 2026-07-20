import { randomInt } from 'crypto';
import { db } from '../config/db';
import { generateReference } from '../lib/money';
import { REFERRAL_REWARD_KOBO } from '../lib/referral';
import { notify } from '../lib/notifications';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous, no 0/O/1/I

async function uniqueRef(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generateReference('REF');
    if (!(await db.transaction.findUnique({ where: { reference: ref } }))) return ref;
  }
  return `REF-${Date.now()}`;
}

async function uniqueDiscountCode(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    let suffix = '';
    for (let j = 0; j < 8; j++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `REF-${suffix}`;
    if (!(await db.discountCode.findUnique({ where: { code } }))) return code;
  }
  return `REF-${Date.now()}`;
}

/**
 * Issue the referral bounty as a redeemable discount code (not a wallet
 * credit — the wallet was dropped in the payment architecture migration).
 * Idempotent: only a `joined` referral is ever paid, so repeated calls (every
 * subsequent payment) are no-ops. `referredUserId` is the space's lead rep.
 * The code is owned by the referrer and redeemable only against their own
 * future due payments — see POST /dues/:dueId/pay's `discountCode` field.
 */
export async function maybeAwardReferral(referredUserId: string): Promise<void> {
  const referral = await db.referral.findFirst({ where: { referredId: referredUserId, status: 'joined' } });
  if (!referral) return;

  const reference = await uniqueRef();
  const code = await uniqueDiscountCode();

  await db.$transaction([
    db.referral.update({ where: { id: referral.id }, data: { status: 'paid', reward: REFERRAL_REWARD_KOBO } }),
    db.discountCode.create({
      data: { code, userId: referral.referrerId, amountKobo: REFERRAL_REWARD_KOBO },
    }),
    db.transaction.create({
      data: {
        userId: referral.referrerId,
        type: 'referral',
        title: 'Referral reward',
        detail: `Discount code ${code}`,
        amount: REFERRAL_REWARD_KOBO,
        method: 'Duevy',
        status: 'completed',
        reference,
      },
    }),
  ]);

  await notify({
    userId: referral.referrerId,
    kind: 'referral_earned',
    title: 'Referral reward earned',
    detail: `You earned a ₦${(REFERRAL_REWARD_KOBO / 100).toLocaleString('en-NG')} discount code (${code}) — a rep you referred just started collecting. Apply it next time you pay a due.`,
    href: '/dashboard/referrals',
  }).catch(() => {});
}
