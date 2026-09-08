/**
 * One-time backfill: create LedgerEntry rows for financial activity that
 * predates the ledger (see prisma/schema.prisma LedgerEntry). Historical
 * DuePayment/refund-Transaction/completed-Payout rows are the source —
 * their already-recorded fee columns are used as-is rather than recomputed
 * via computeCharge(), since historical fee percentages could in principle
 * have differed from today's SERVICE_CHARGE_PERCENT.
 *
 * Idempotent: skips any row that already has a matching LedgerEntry
 * (by reference + type), so it's safe to re-run.
 *
 * Defaults to a dry run (counts only, writes nothing). Pass --apply to write.
 *
 * Run with:
 *   npx tsx scripts/backfill-ledger.ts            (dry run)
 *   npx tsx scripts/backfill-ledger.ts --apply     (writes)
 */
import { db } from '../src/config/db';

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 200;

async function backfillDuePayments() {
  let cursor: string | undefined;
  let created = 0;
  let skipped = 0;

  for (;;) {
    const batch = await db.duePayment.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      include: { due: { select: { spaceId: true, title: true } } },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const payment of batch) {
      const existing = await db.ledgerEntry.findFirst({
        where: { reference: payment.reference, type: 'due_payment' },
        select: { id: true },
      });
      if (existing) {
        skipped++;
        continue;
      }
      if (APPLY) {
        await db.ledgerEntry.create({
          data: {
            spaceId: payment.due.spaceId,
            dueId: payment.dueId,
            txnId: payment.txnId,
            duePaymentId: payment.id,
            type: 'due_payment',
            direction: 'credit',
            amountKobo: payment.netToSpace,
            grossKobo: payment.amountPaid,
            feeKobo: payment.processingFee + payment.duevyFee,
            netKobo: payment.netToSpace,
            reference: payment.reference,
            description: `Payment for "${payment.due.title}"`,
            createdAt: payment.paidAt,
          },
        });
      }
      created++;
    }
  }
  return { created, skipped };
}

async function backfillRefunds() {
  let cursor: string | undefined;
  let created = 0;
  let skipped = 0;
  let noSpace = 0;

  for (;;) {
    const batch = await db.transaction.findMany({
      where: { type: 'refund', status: 'completed' },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const txn of batch) {
      if (!txn.spaceId) {
        noSpace++;
        continue;
      }
      const existing = await db.ledgerEntry.findFirst({
        where: { reference: txn.reference, type: 'refund' },
        select: { id: true },
      });
      if (existing) {
        skipped++;
        continue;
      }
      if (APPLY) {
        await db.ledgerEntry.create({
          data: {
            spaceId: txn.spaceId,
            txnId: txn.id,
            type: 'refund',
            direction: 'debit',
            amountKobo: Math.abs(txn.amount),
            reference: txn.reference,
            description: txn.detail ?? 'Refund',
            createdAt: txn.createdAt,
          },
        });
      }
      created++;
    }
  }
  return { created, skipped, noSpace };
}

async function backfillPayouts() {
  let cursor: string | undefined;
  let created = 0;
  let skipped = 0;

  for (;;) {
    const batch = await db.payout.findMany({
      where: { status: 'completed' },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const payout of batch) {
      const existing = await db.ledgerEntry.findFirst({
        where: { reference: payout.reference, type: 'payout' },
        select: { id: true },
      });
      if (existing) {
        skipped++;
        continue;
      }
      if (APPLY) {
        await db.ledgerEntry.create({
          data: {
            spaceId: payout.spaceId,
            dueId: payout.dueId,
            payoutId: payout.id,
            type: 'payout',
            direction: 'debit',
            amountKobo: payout.amount,
            reference: payout.reference,
            description: `Payout to ${payout.accountMasked}`,
            createdAt: payout.settledAt ?? payout.requestedAt,
          },
        });
      }
      created++;
    }
  }
  return { created, skipped };
}

async function main() {
  console.log(APPLY ? 'Running backfill (writing rows)...' : 'Dry run — no rows will be written. Pass --apply to write.');

  const duePayments = await backfillDuePayments();
  console.log(`DuePayment -> due_payment: ${duePayments.created} ${APPLY ? 'created' : 'to create'}, ${duePayments.skipped} already present`);

  const refunds = await backfillRefunds();
  console.log(`Transaction(refund) -> refund: ${refunds.created} ${APPLY ? 'created' : 'to create'}, ${refunds.skipped} already present, ${refunds.noSpace} skipped (no spaceId)`);

  const payouts = await backfillPayouts();
  console.log(`Payout(completed) -> payout: ${payouts.created} ${APPLY ? 'created' : 'to create'}, ${payouts.skipped} already present`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write these rows.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
