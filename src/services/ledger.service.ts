import { Prisma, type LedgerDirection, type LedgerEntryType } from '@prisma/client';
import { db } from '../config/db';
import { generateId } from '../lib/id';

/**
 * The per-space ledger. Append-only (enforced by a database trigger) and the
 * only source of a space's balance, which is derived on every read and never
 * stored:
 *
 *   balance = Σ credits − Σ debits
 *
 *   credits: due_payment (a collection, at face value), manual_credit,
 *            payout_reversal (a failed/reversed withdrawal restored in full)
 *   debits:  payout (what was sent to the bank), payout_fee (Duevy's
 *            withdrawal fee), refund
 *
 * A withdrawal is debited when it is CREATED, not when it settles, so the
 * balance is always what can still be withdrawn. Nothing is reserved on the
 * side; there is no second number to keep in sync.
 */

type Tx = Prisma.TransactionClient;

export interface LedgerWrite {
  spaceId: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  amountKobo: number;
  reference: string;
  description: string;
  dueId?: string | null;
  txnId?: string | null;
  duePaymentId?: string | null;
  payoutId?: string | null;
  grossKobo?: number | null;
  feeKobo?: number | null;
  netKobo?: number | null;
  actorId?: string | null;
}

const CREDIT_TYPES: LedgerEntryType[] = ['due_payment', 'manual_credit', 'payout_reversal'];
const DEBIT_TYPES: LedgerEntryType[] = ['payout', 'payout_fee', 'refund'];

/**
 * Append one entry. Idempotent: the (type, duePaymentId) and (type, payoutId)
 * unique keys mean a replayed write returns false instead of double-counting.
 * Must run inside the caller's transaction so the entry commits with the
 * business change it records.
 */
export async function appendLedgerEntry(tx: Tx, entry: LedgerWrite): Promise<boolean> {
  if (!Number.isSafeInteger(entry.amountKobo) || entry.amountKobo <= 0) {
    throw new RangeError(`ledger amount must be a positive integer of kobo, got ${entry.amountKobo}`);
  }
  const expected = CREDIT_TYPES.includes(entry.type) ? 'credit' : DEBIT_TYPES.includes(entry.type) ? 'debit' : null;
  if (expected && expected !== entry.direction) {
    throw new Error(`ledger ${entry.type} entries are ${expected}s, not ${entry.direction}s`);
  }

  // ON CONFLICT DO NOTHING rather than catching P2002: a failed INSERT would
  // abort the surrounding Postgres transaction.
  const inserted = await tx.$executeRaw`
    INSERT INTO "ledger_entries"
      ("id", "spaceId", "dueId", "txnId", "duePaymentId", "payoutId", "type", "direction",
       "amountKobo", "grossKobo", "feeKobo", "netKobo", "reference", "description", "actorId", "createdAt")
    VALUES
      (${cuidLike()}, ${entry.spaceId}, ${entry.dueId ?? null}, ${entry.txnId ?? null}, ${entry.duePaymentId ?? null},
       ${entry.payoutId ?? null}, ${entry.type}::"LedgerEntryType", ${entry.direction}::"LedgerDirection",
       ${entry.amountKobo}, ${entry.grossKobo ?? null}, ${entry.feeKobo ?? null}, ${entry.netKobo ?? null},
       ${entry.reference}, ${entry.description}, ${entry.actorId ?? null}, (${new Date()}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT DO NOTHING`;
  return inserted === 1;
}

function cuidLike(): string {
  return generateId('ledger');
}

/** The space's balance in kobo, derived from the ledger. Pass `tx` to read inside a locked transaction. */
export async function getSpaceBalance(spaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
    SELECT COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amountKobo" ELSE -"amountKobo" END), 0)::bigint AS balance
    FROM "ledger_entries"
    WHERE "spaceId" = ${spaceId}`;
  return Number(rows[0]?.balance ?? 0);
}

export interface SpaceLedgerSummary {
  /** Withdrawable now. */
  balance: number;
  /** Lifetime collections credited at face value (incl. manual credits). */
  collected: number;
  /** Lifetime sent to the bank on withdrawals, net of reversals. */
  withdrawn: number;
  /** Lifetime withdrawal fees, net of reversals. */
  withdrawalFees: number;
  /** Debited for withdrawals that have not reached a final state yet. */
  inFlight: number;
}

export async function getSpaceLedgerSummary(spaceId: string): Promise<SpaceLedgerSummary> {
  const [byType, inFlight] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ['type'], where: { spaceId }, _sum: { amountKobo: true } }),
    db.payout.aggregate({ where: { spaceId, status: { in: ['pending', 'processing'] } }, _sum: { amount: true } }),
  ]);
  const sum = (t: LedgerEntryType) => byType.find((r) => r.type === t)?._sum.amountKobo ?? 0;

  // A reversal restores a whole withdrawal (fee included). Split it back out
  // so lifetime figures describe money that actually left.
  const reversed = await db.payout.aggregate({
    where: { spaceId, status: { in: ['failed', 'reversed'] }, ledgerEntries: { some: { type: 'payout_reversal' } } },
    _sum: { netKobo: true, feeKobo: true },
  });

  const collected = sum('due_payment') + sum('manual_credit');
  const balance =
    collected + sum('payout_reversal') - sum('payout') - sum('payout_fee') - sum('refund');
  return {
    balance,
    collected,
    withdrawn: sum('payout') - (reversed._sum.netKobo ?? 0),
    withdrawalFees: sum('payout_fee') - (reversed._sum.feeKobo ?? 0),
    inFlight: inFlight._sum.amount ?? 0,
  };
}

export async function listSpaceLedger(spaceId: string, skip: number, take: number) {
  const [total, rows] = await Promise.all([
    db.ledgerEntry.count({ where: { spaceId } }),
    db.ledgerEntry.findMany({ where: { spaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
  ]);
  return {
    total,
    rows: rows.map((e) => ({
      id: e.id,
      type: e.type,
      direction: e.direction,
      amount: e.amountKobo,
      signedAmount: e.direction === 'credit' ? e.amountKobo : -e.amountKobo,
      reference: e.reference,
      description: e.description,
      dueId: e.dueId,
      payoutId: e.payoutId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/**
 * Serialise all balance-changing work on one space. Transaction-scoped: the
 * lock is released when the surrounding transaction commits or rolls back.
 */
export async function lockSpace(tx: Tx, spaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'space:' + spaceId}, 0))`;
}
