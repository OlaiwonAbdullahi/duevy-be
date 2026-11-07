/**
 * Financial consistency audit after a load run (run while scripts/loadtest/server.ts is up):
 *   npx tsx scripts/loadtest/audit.ts
 * Every paid checkout must have exactly one DuePayment and one ledger credit
 * per due, each space's balance must equal the face value it collected, and
 * no webhook may be left dead or stuck.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ datasourceUrl: `postgresql://duevy:duevy@localhost:${process.env.LT_PG_PORT ?? 55433}/duevy_lt` });

async function main() {
  const [r] = await db.$queryRaw<Record<string, bigint>[]>`
    SELECT
      (SELECT COUNT(*) FROM checkouts WHERE status = 'paid') AS paid_checkouts,
      (SELECT COUNT(*) FROM checkout_items ci JOIN checkouts c ON c.id = ci."checkoutId" WHERE c.status = 'paid') AS paid_items,
      (SELECT COUNT(*) FROM due_payments) AS due_payments,
      (SELECT COUNT(*) FROM ledger_entries WHERE type = 'due_payment') AS ledger_credits,
      (SELECT COUNT(*) FROM receipts) AS receipts,
      (SELECT COUNT(*) FROM (SELECT "userId","dueId" FROM due_payments GROUP BY 1,2 HAVING COUNT(*) > 1) d) AS double_paid,
      (SELECT COALESCE(SUM("faceKobo"),0) FROM checkouts WHERE status = 'paid') AS face_collected,
      (SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN "amountKobo" ELSE -"amountKobo" END),0) FROM ledger_entries) AS ledger_balance,
      (SELECT COUNT(*) FROM checkouts WHERE status = 'paid' AND "needsReview") AS flagged,
      (SELECT COUNT(*) FROM webhook_events WHERE status = 'dead') AS dead_events,
      (SELECT COUNT(*) FROM webhook_events WHERE status IN ('received','failed','processing')) AS unprocessed_events,
      (SELECT COUNT(*) FROM webhook_events) AS events`;
  const n = Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]));
  console.table(n);
  const ok =
    n.paid_items === n.due_payments && n.due_payments === n.ledger_credits && n.receipts === n.paid_checkouts &&
    n.double_paid === 0 && n.face_collected === n.ledger_balance && n.dead_events === 0 && n.unprocessed_events === 0;
  console.log(ok ? 'CONSISTENT' : 'INCONSISTENT');
  await db.$disconnect();
  process.exit(ok ? 0 : 1);
}
main();
