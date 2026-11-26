/**
 * Re-send payment emails that silently failed (e.g. when the mail quota ran out)
 * by reconstructing them from paid Checkout records. There is NO email outbox and
 * no per-email "sent" flag, so "which failed" is defined by a CUTOFF: the last
 * checkout whose emails DID go out (here, Fajuke Richard's payment). Every
 * checkout paid AFTER the cutoff is re-sent — payer receipt + rep notifications,
 * exactly as checkout fulfilment builds them.
 *
 * PREREQUISITES
 *   - SENDBYTE_API_KEY set (the new mailer) and a valid .env for this branch
 *     (DB urls, PAYMENT_PROVIDER, etc). Run against the DB holding the real
 *     payments (production).
 *
 * SAFETY: dry run by default — it only PRINTS what would be sent. Add --send to
 * actually send. Re-sending is safe for checkouts after the cutoff because none
 * of their emails went out; do NOT set the cutoff earlier than the last email
 * that was delivered, or you'll double-mail people.
 *
 *   # Find the cutoff checkout's reference first (the last one that WAS emailed),
 *   # then preview everything after it:
 *   npx tsx prisma/resendPaymentEmails.ts --after <checkout-reference>
 *   # or by timestamp:
 *   npx tsx prisma/resendPaymentEmails.ts --since 2026-11-26T10:00:00Z
 *   # When the preview looks right, actually send:
 *   npx tsx prisma/resendPaymentEmails.ts --after <checkout-reference> --send
 *
 * Scope flags: --payer-only, --reps-only, --limit <n> (default 1000).
 */
import type { Prisma } from '@prisma/client';
import { db } from '../src/config/db';
import { env } from '../src/config/env';
import { sendDuePaymentReceiptEmail, sendRepPaymentReceivedEmail } from '../src/lib/email';
import { guestCheckoutToken } from '../src/services/checkout.service';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

// Replicated from checkout.service.ts (both are private there).
function wantsPaymentEmails(prefs: Prisma.JsonValue | null): boolean {
  const email = (prefs as { email?: { paymentReceipts?: unknown } } | null)?.email;
  return email?.paymentReceipts !== false;
}
function guestReceiptUrl(dueId: string, reference: string): string {
  const q = new URLSearchParams({ ref: reference, t: guestCheckoutToken(reference) });
  return `${env.FRONTEND_URL}/pay/${encodeURIComponent(dueId)}?${q}`;
}

async function main() {
  const send = has('--send');
  const payerOnly = has('--payer-only');
  const repsOnly = has('--reps-only');
  const limit = Number(arg('--limit') ?? '1000');

  // Resolve the cutoff: re-send everything paid strictly AFTER it.
  let cutoff: Date;
  const afterRef = arg('--after');
  const since = arg('--since');
  if (afterRef) {
    const c = await db.checkout.findUnique({ where: { reference: afterRef }, select: { paidAt: true } });
    if (!c?.paidAt) {
      console.error(`No paid checkout with reference "${afterRef}".`);
      process.exit(1);
    }
    cutoff = c.paidAt;
    console.log(`Cutoff: checkouts paid AFTER ${afterRef} (${cutoff.toISOString()}).`);
  } else if (since) {
    cutoff = new Date(since);
    if (Number.isNaN(cutoff.getTime())) {
      console.error(`Invalid --since timestamp: "${since}".`);
      process.exit(1);
    }
    console.log(`Cutoff: checkouts paid after ${cutoff.toISOString()}.`);
  } else {
    console.error('Give a cutoff: --after <checkout-reference> (recommended) or --since <ISO timestamp>.');
    process.exit(1);
  }

  const checkouts = await db.checkout.findMany({
    where: { status: 'paid', paidAt: { gt: cutoff } },
    orderBy: { paidAt: 'asc' },
    take: limit,
    select: { id: true, reference: true, userId: true, spaceId: true, faceKobo: true, feeKobo: true, totalKobo: true, receivedKobo: true, paidAt: true },
  });

  console.log(`\n${send ? '>>> SENDING' : '--- DRY RUN'} — ${checkouts.length} paid checkout(s) after the cutoff.\n`);

  let payerSent = 0;
  let repSent = 0;
  let failures = 0;

  for (const c of checkouts) {
    const [payer, space, items, receipt, reps] = await Promise.all([
      db.user.findUnique({ where: { id: c.userId }, select: { name: true, email: true, isGuest: true } }),
      db.space.findUnique({ where: { id: c.spaceId }, select: { name: true } }),
      db.checkoutItem.findMany({ where: { checkoutId: c.id }, include: { due: { select: { title: true } } } }),
      db.receipt.findFirst({ where: { checkoutId: c.id }, select: { number: true } }),
      db.spaceRep.findMany({
        where: { spaceId: c.spaceId },
        select: { userId: true, user: { select: { name: true, email: true, notificationPrefs: true, isDeactivated: true } } },
      }),
    ]);

    const lineItems = items.map((i) => ({ title: i.due.title, amountKobo: i.faceKobo }));
    const rosterHref = items.length === 1 ? `/dashboard/create-dues?due=${items[0]!.dueId}` : '/dashboard/create-dues';

    // 1) Payer's receipt.
    if (!repsOnly && payer) {
      console.log(`  [payer] ${c.reference} -> ${payer.email} (${payer.name})`);
      if (send) {
        try {
          await sendDuePaymentReceiptEmail(payer.email, payer.name, {
            spaceName: space?.name ?? '',
            reference: c.reference,
            receiptNumber: receipt?.number ?? null,
            items: lineItems,
            faceKobo: c.faceKobo,
            feeKobo: c.totalKobo - c.faceKobo,
            amountPaidKobo: c.receivedKobo ?? c.totalKobo,
            paidAt: c.paidAt ?? new Date(),
            receiptUrl: payer.isGuest && items[0] ? guestReceiptUrl(items[0].dueId, c.reference) : undefined,
          });
          payerSent++;
        } catch (e) {
          failures++;
          console.error(`    ! payer send failed: ${(e as Error).message}`);
        }
      }
    }

    // 2) Reps (skip the payer themselves, deactivated reps, and opt-outs).
    if (!payerOnly) {
      const emailReps = reps.filter((r) => r.userId !== c.userId && !r.user.isDeactivated && wantsPaymentEmails(r.user.notificationPrefs));
      for (const r of emailReps) {
        console.log(`  [rep]   ${c.reference} -> ${r.user.email} (${r.user.name})`);
        if (send) {
          try {
            await sendRepPaymentReceivedEmail(r.user.email, r.user.name, {
              spaceName: space?.name ?? '',
              payerName: payer?.name ?? 'A member',
              reference: c.reference,
              items: lineItems,
              faceKobo: c.totalKobo - c.feeKobo,
              feeAbsorbedKobo: c.faceKobo - (c.totalKobo - c.feeKobo),
              paidAt: c.paidAt ?? new Date(),
              link: `${env.FRONTEND_URL}${rosterHref}`,
            });
            repSent++;
          } catch (e) {
            failures++;
            console.error(`    ! rep send failed: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  console.log(`\n${send ? 'Sent' : 'Would send'}: ${payerSent} payer + ${repSent} rep email(s).${send ? ` Failures: ${failures}.` : ''}`);
  if (!send) console.log('Re-run with --send to actually send. Double-check the cutoff first.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
