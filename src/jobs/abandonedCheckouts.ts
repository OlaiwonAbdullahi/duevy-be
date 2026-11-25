import { db } from '../config/db';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { sendAbandonedCheckoutEmail } from '../lib/email';
import { guestCheckoutToken } from '../services/checkout.service';

/**
 * "Finish your payment" emails to guests who opened a checkout — filled the
 * pay form and got a transfer account — but left before the money arrived.
 *
 * A checkout qualifies once it's older than ABANDONED_CHECKOUT_REMINDER_MINUTES
 * (default 30) while still `pending` and not yet expired, so the payer still
 * has time to finish on the same account. Each checkout is emailed at most once
 * (`abandonedReminderSentAt`), and only guest-link payers are nudged — a
 * signed-in member resumes from their dashboard, not a tokenised guest link.
 */
const MINUTE = 60 * 1000;
const BATCH = 100;

/** The guest pay page, with the reference + token that unlock this checkout. */
function resumeUrl(dueId: string, reference: string): string {
  const token = guestCheckoutToken(reference);
  return `${env.FRONTEND_URL}/pay/${encodeURIComponent(dueId)}?ref=${encodeURIComponent(reference)}&t=${encodeURIComponent(token)}`;
}

export async function sendAbandonedCheckoutRemindersOnce(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.ABANDONED_CHECKOUT_REMINDER_MINUTES * MINUTE);
  const checkouts = await db.checkout.findMany({
    where: {
      status: 'pending',
      abandonedReminderSentAt: null,
      createdAt: { lte: cutoff },
      // Still payable: don't nudge someone toward an account that's about to close.
      expiresAt: { gt: now },
      user: { isGuest: true, isSuspended: false, isDeactivated: false },
    },
    select: {
      id: true,
      reference: true,
      totalKobo: true,
      expiresAt: true,
      user: { select: { name: true, email: true } },
      space: { select: { name: true } },
      // Guest links are per-due, so a guest checkout settles a single due.
      items: { select: { dueId: true, due: { select: { title: true } } }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let sent = 0;
  for (const c of checkouts) {
    const item = c.items[0];
    const email = c.user.email;
    if (!item || !email) continue;

    // Claim first, so two workers never email the same checkout twice.
    const claimed = await db.checkout.updateMany({
      where: { id: c.id, abandonedReminderSentAt: null, status: 'pending' },
      data: { abandonedReminderSentAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      await sendAbandonedCheckoutEmail(email, c.user.name, {
        dueTitle: item.due.title,
        spaceName: c.space.name,
        amountKobo: c.totalKobo,
        resumeUrl: resumeUrl(item.dueId, c.reference),
        expiresAt: c.expiresAt,
      });
      sent += 1;
    } catch (err) {
      // Release the claim so the next run retries it.
      await db.checkout.updateMany({ where: { id: c.id }, data: { abandonedReminderSentAt: null } });
      logger.warn({ checkoutId: c.id, err: (err as Error).message }, 'abandoned checkout reminder failed');
    }
  }
  if (sent) logger.info({ sent }, 'abandoned checkout reminders sent');
  return sent;
}

let running: Promise<void> | null = null;
let stopped = false;

/** Start the abandoned-checkout sweep (every 10 minutes). Returns a handle for shutdown. */
export function startAbandonedCheckoutJob(intervalMs = 10 * MINUTE): NodeJS.Timeout {
  stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = sendAbandonedCheckoutRemindersOnce()
      .then(() => undefined)
      .catch((err) => logger.error({ err: (err as Error).message }, 'abandoned checkout run failed'))
      .finally(() => {
        running = null;
      });
  };
  // First pass shortly after boot, then on the interval.
  setTimeout(run, 30 * 1000).unref();
  return setInterval(run, intervalMs);
}

/** Shutdown: start no new run (the boot-time one included) and wait for the one in flight. */
export async function stopAbandonedCheckoutJob(): Promise<void> {
  stopped = true;
  await running;
}
