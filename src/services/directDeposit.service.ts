import { db } from '../config/db';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';
import { appendLedgerEntry, lockSpace } from './ledger.service';

/**
 * Direct deposits: money someone sends straight to a space's own account
 * number instead of paying through a checkout. It is already in the space
 * account, so there is nothing to sweep; it is credited to the space as it is
 * (ledger direct_deposit), with no due attached.
 *
 * Found two ways, both reading 9jaPay's own records (never the event body):
 *   - the credit webhook on the space account, straight away;
 *   - reconciliation, which reads every space account every few hours in case
 *     a webhook never came.
 *
 * Our own sweeps and payouts the bank sent back are credits on the same
 * account; the provider tells them apart (AccountCredit.source) and only
 * 'external' ones are recorded. Each 9jaPay transaction is recorded once.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Re-read this much before the last check, in case a credit was posted late. */
const OVERLAP_MS = 24 * HOUR_MS;
const RECHECK_AFTER_MS = 6 * HOUR_MS;
const RECONCILE_BATCH = 20;

/** Read the space account and credit any direct deposit not yet recorded. Returns how many were new. */
export async function syncDirectDeposits(spaceId: string, now = new Date()): Promise<number> {
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: { id: true, walletAccountNumber: true, walletCreatedAt: true, walletDepositsCheckedAt: true },
  });
  if (!space?.walletAccountNumber || !space.walletCreatedAt) return 0;

  const opened = space.walletCreatedAt.getTime() - HOUR_MS;
  const since = (space.walletDepositsCheckedAt ?? space.walletCreatedAt).getTime() - OVERLAP_MS;
  const window = { from: new Date(Math.max(opened, since)), to: now };
  const credits = await getPaymentProvider().listAccountCredits(space.walletAccountNumber, window);

  let recorded = 0;
  for (const c of credits) {
    if (c.source !== 'external' || c.amountKobo <= 0) continue;
    const isNew = await db.$transaction(async (tx) => {
      await lockSpace(tx, spaceId);
      const seen = await tx.directDeposit.findUnique({ where: { providerTransactionId: c.transactionId }, select: { id: true } });
      if (seen) return false;
      const deposit = await tx.directDeposit.create({
        data: {
          spaceId,
          providerTransactionId: c.transactionId,
          amountKobo: c.amountKobo,
          senderName: c.senderName,
          senderAccountNumber: c.senderAccountNumber,
          senderBank: c.senderBank,
          narration: c.narration?.slice(0, 300) ?? null,
          receivedAt: c.at,
        },
      });
      await appendLedgerEntry(tx, {
        spaceId,
        type: 'direct_deposit',
        direction: 'credit',
        amountKobo: c.amountKobo,
        reference: c.transactionId,
        description: `Sent straight to the space account by ${c.senderName ?? 'an unknown sender'}`,
        directDepositId: deposit.id,
      });
      return true;
    });
    if (isNew) {
      recorded++;
      logger.info({ spaceId, amount: c.amountKobo, transactionId: c.transactionId }, 'direct deposit credited to the space');
    }
  }
  await db.space.update({ where: { id: spaceId }, data: { walletDepositsCheckedAt: now } });
  return recorded;
}

/** The credit webhook named this account: if it is a space's, pick up any direct deposit. */
export async function syncDirectDepositsForAccount(accountNumber: string): Promise<number> {
  const space = await db.space.findUnique({ where: { walletAccountNumber: accountNumber }, select: { id: true } });
  return space ? syncDirectDeposits(space.id) : 0;
}

/** Reconciliation: read the space accounts not checked for a while, oldest first. */
export async function reconcileDirectDeposits(now = new Date()): Promise<void> {
  const due = await db.space.findMany({
    where: {
      walletAccountNumber: { not: null },
      OR: [{ walletDepositsCheckedAt: null }, { walletDepositsCheckedAt: { lte: new Date(now.getTime() - RECHECK_AFTER_MS) } }],
    },
    select: { id: true },
    orderBy: { walletDepositsCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: RECONCILE_BATCH,
  });
  for (const s of due) {
    await syncDirectDeposits(s.id, now).catch((err) =>
      logger.warn({ spaceId: s.id, err: (err as Error).message }, 'direct deposit check failed'),
    );
  }
}
