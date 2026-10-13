import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { logger } from '../lib/logger';
import { sendKycReminderEmail } from '../lib/email';

/**
 * "Finish your verification" emails to rep applicants who signed up but still
 * owe a KYC step — the same test as the frontend's onboarding gate: NIN not
 * submitted (or refused), student ID missing (or refused), or no payout
 * account. Anything merely pending review is on us, so it isn't nagged.
 *
 * Reminders go out 24 hours, 3 days and 7 days after sign-up, at most one per
 * run. Someone found late (e.g. on the first run after deploy) gets only the
 * latest reminder that's due, never a burst. Only verified email addresses are
 * written to: an unverified applicant can't sign in to act on it yet.
 */
const HOUR = 60 * 60 * 1000;
const STAGES = [
  { stage: 1, afterMs: 24 * HOUR },
  { stage: 2, afterMs: 3 * 24 * HOUR },
  { stage: 3, afterMs: 7 * 24 * HOUR },
] as const;
type Stage = (typeof STAGES)[number]['stage'];

const KYC_OUTSTANDING: Prisma.UserWhereInput = {
  OR: [
    { kycSubmittedAt: null },
    { kycStatus: 'rejected' },
    { studentIdStatus: null },
    { studentIdStatus: 'rejected' },
    { payoutDestinationSubmittedAt: null },
  ],
};

const BATCH = 100;

export async function sendKycRemindersOnce(now = new Date()): Promise<number> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const users = await db.user.findMany({
    where: {
      repApplicationStatus: 'pending',
      emailVerified: true,
      isSuspended: false,
      isDeactivated: false,
      AND: [
        KYC_OUTSTANDING,
        // A reminder is due: past a stage's age without having had it yet.
        { OR: STAGES.map(({ stage, afterMs }) => ({ kycReminderStage: { lt: stage }, createdAt: { lte: ago(afterMs) } })) },
      ],
    },
    select: { id: true, name: true, email: true, createdAt: true, kycReminderStage: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let sent = 0;
  for (const u of users) {
    const age = now.getTime() - u.createdAt.getTime();
    const due = [...STAGES].reverse().find((s) => age >= s.afterMs && s.stage > u.kycReminderStage)?.stage as Stage | undefined;
    if (!due) continue;

    // Claim first, so two workers never send the same reminder twice.
    const claimed = await db.user.updateMany({
      where: { id: u.id, kycReminderStage: u.kycReminderStage },
      data: { kycReminderStage: due, kycReminderSentAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      await sendKycReminderEmail(u.email, u.name, due);
      sent += 1;
    } catch (err) {
      // Give the stage back so the next run retries it.
      await db.user.updateMany({ where: { id: u.id, kycReminderStage: due }, data: { kycReminderStage: u.kycReminderStage } });
      logger.warn({ userId: u.id, stage: due, err: (err as Error).message }, 'kyc reminder email failed');
    }
  }
  if (sent) logger.info({ sent }, 'kyc reminder emails sent');
  return sent;
}

let running = false;

/** Start the hourly reminder sweep. Returns a handle for shutdown. */
export function startKycReminderJob(intervalMs = HOUR): NodeJS.Timeout {
  const run = () => {
    if (running) return;
    running = true;
    sendKycRemindersOnce()
      .catch((err) => logger.error({ err: (err as Error).message }, 'kyc reminder run failed'))
      .finally(() => {
        running = false;
      });
  };
  // First pass shortly after boot, then hourly.
  setTimeout(run, 30 * 1000).unref();
  return setInterval(run, intervalMs);
}
