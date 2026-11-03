import { db } from '../config/db';
import { logger } from '../lib/logger';
import { generateToken, hashToken } from '../lib/tokens';
import { sendAccountActivationEmail } from '../lib/email';

/**
 * Guest → Duevy account, on the guest's say-so.
 *
 * Every guest payer already has an `isGuest` user row (routes/guestPay.ts), and
 * their payment, receipt and transaction already point at it. So "creating an
 * account" is claiming that row: a single-use, time-limited set-password link
 * (a `password_resets` token, only its hash stored) goes to the email they paid
 * with. Following it sets their password and clears `isGuest`
 * (POST /auth/reset-password), and their past guest payments come with it.
 *
 * Rules:
 *  - The link goes out only once the checkout is PAID. A pending, expired or
 *    underpaid checkout never gets one.
 *  - One person, one row: users.email is unique and the row is reused, so this
 *    can't make a duplicate account. A row that is already a full account is
 *    left alone — that person signs in instead.
 *  - Sending is claimed on the checkout (`accountInviteSentAt`) before the email
 *    goes, so a webhook replay or a racing retry can't send twice. A failed
 *    send releases the claim; the reconciliation sweep (retryGuestAccountInvites)
 *    and the guest's own "resend" pick it up again. The payment is never touched.
 */

export const ACTIVATION_LINK_HOURS = 72;
/** A guest can ask for the link again, but not more than once a minute. */
const RESEND_COOLDOWN_MS = 60_000;
/** The sweep leaves fresh payments to afterPaid, which sends straight away. */
const RETRY_AFTER_MS = 2 * 60_000;

export type InviteOutcome = 'sent' | 'not_requested' | 'not_paid' | 'has_account' | 'already_sent';

export async function sendGuestAccountInvite(checkoutId: string, opts: { resend?: boolean } = {}): Promise<InviteOutcome> {
  const checkout = await db.checkout.findUnique({
    where: { id: checkoutId },
    select: {
      id: true,
      reference: true,
      status: true,
      accountRequestedAt: true,
      user: { select: { id: true, name: true, email: true, isGuest: true, isSuspended: true, isDeactivated: true } },
      space: { select: { name: true } },
    },
  });
  if (!checkout?.accountRequestedAt) return 'not_requested';
  if (checkout.status !== 'paid') return 'not_paid';
  const { user } = checkout;
  if (!user.isGuest) return 'has_account';
  if (user.isSuspended || user.isDeactivated) return 'not_requested';

  const now = new Date();
  const claimed = await db.checkout.updateMany({
    where: {
      id: checkout.id,
      ...(opts.resend
        ? { OR: [{ accountInviteSentAt: null }, { accountInviteSentAt: { lt: new Date(now.getTime() - RESEND_COOLDOWN_MS) } }] }
        : { accountInviteSentAt: null }),
    },
    data: { accountInviteSentAt: now },
  });
  if (claimed.count === 0) return 'already_sent';

  try {
    const token = generateToken();
    await db.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + ACTIVATION_LINK_HOURS * 3_600_000),
      },
    });
    await sendAccountActivationEmail(user.email, user.name, token, {
      spaceName: checkout.space.name,
      expiresInHours: ACTIVATION_LINK_HOURS,
    });
  } catch (err) {
    // Release the claim so a retry can send it. The payment stands either way.
    await db.checkout
      .updateMany({ where: { id: checkout.id, accountInviteSentAt: now }, data: { accountInviteSentAt: null } })
      .catch(() => {});
    throw err;
  }

  logger.info({ ref: checkout.reference, userId: user.id, resend: !!opts.resend }, 'guest account activation link sent');
  return 'sent';
}

/**
 * Record a guest's consent after the fact (from the success page, when they
 * didn't tick the box at checkout) or ask for the link again. Sends right away
 * if the checkout is paid; otherwise afterPaid sends it once it is.
 */
export async function requestGuestAccount(checkoutId: string): Promise<InviteOutcome> {
  await db.checkout.updateMany({
    where: { id: checkoutId, accountRequestedAt: null },
    data: { accountRequestedAt: new Date() },
  });
  return sendGuestAccountInvite(checkoutId, { resend: true });
}

/** Backstop for invites that failed to send (email outage, crash after payment). */
export async function retryGuestAccountInvites(): Promise<void> {
  const owed = await db.checkout.findMany({
    where: {
      status: 'paid',
      accountRequestedAt: { not: null },
      accountInviteSentAt: null,
      paidAt: { lte: new Date(Date.now() - RETRY_AFTER_MS) },
      user: { isGuest: true },
    },
    select: { id: true, reference: true },
    take: 25,
  });
  for (const c of owed) {
    await sendGuestAccountInvite(c.id).catch((err) =>
      logger.warn({ ref: c.reference, err: (err as Error).message }, 'guest account invite retry failed'),
    );
  }
}

/** What the guest's status page shows about their account. */
export function guestAccountState(c: {
  accountRequestedAt: Date | null;
  accountInviteSentAt: Date | null;
  user: { isGuest: boolean };
}) {
  return {
    /** The payer already has a full Duevy account (signed in, or activated since). */
    exists: !c.user.isGuest,
    requested: !!c.accountRequestedAt,
    inviteSentAt: c.accountInviteSentAt?.toISOString() ?? null,
  };
}
