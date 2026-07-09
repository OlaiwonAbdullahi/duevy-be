import { db } from '../config/db';
import { generateReference } from '../lib/money';
import { REFERRAL_REWARD_KOBO } from '../lib/referral';
import { notify } from '../lib/notifications';

async function uniqueRef(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generateReference('REF');
    if (!(await db.transaction.findUnique({ where: { reference: ref } }))) return ref;
  }
  return `REF-${Date.now()}`;
}

/**
 * Pay the referral bounty when a referred rep's space takes its first payment.
 * Idempotent: only a `joined` referral is ever paid, so repeated calls (every
 * subsequent payment) are no-ops. `referredUserId` is the space's lead rep.
 */
export async function maybeAwardReferral(referredUserId: string): Promise<void> {
  const referral = await db.referral.findFirst({ where: { referredId: referredUserId, status: 'joined' } });
  if (!referral) return;

  const reference = await uniqueRef();
  await db.$transaction([
    db.referral.update({ where: { id: referral.id }, data: { status: 'paid', reward: REFERRAL_REWARD_KOBO } }),
    db.user.update({ where: { id: referral.referrerId }, data: { walletBalance: { increment: REFERRAL_REWARD_KOBO } } }),
    db.transaction.create({
      data: {
        userId: referral.referrerId,
        type: 'referral',
        title: 'Referral reward',
        detail: 'Referral bonus',
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
    detail: `You earned ₦${(REFERRAL_REWARD_KOBO / 100).toLocaleString('en-NG')} — a rep you referred just started collecting.`,
    href: '/dashboard/referrals',
  }).catch(() => {});
}
