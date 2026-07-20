/**
 * Re-sends the "your wallet balance is now a discount code" email for the
 * BAL-* codes created by convertWalletBalances.ts, without touching the
 * database again (balances are already converted/zeroed). Use this to retry
 * once Resend's sending domain is verified. Safe to re-run — just resends.
 *
 * Run with: npx tsx prisma/notifyBalanceConversion.ts
 */
import { db } from '../src/config/db';
import { sendEmail, renderEmail } from '../src/lib/email';

function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

async function main() {
  const codes = await db.discountCode.findMany({
    where: { code: { startsWith: 'BAL-' } },
    include: { user: { select: { name: true, email: true } } },
  });

  console.log(`Found ${codes.length} balance-conversion code(s) to notify.`);

  for (const c of codes) {
    try {
      await sendEmail({
        to: c.user.email,
        subject: 'Your Duevy wallet balance is now a discount code',
        html: renderEmail(`
          <h1>Your balance became a discount code</h1>
          <p>Hi ${c.user.name}, we've retired Duevy's wallet balance feature. Your remaining balance of <strong>${formatNaira(c.amountKobo)}</strong> hasn't gone anywhere — it's now a discount code you can apply the next time you pay a due.</p>
          <div class="callout"><strong>Your code:</strong> ${c.code}</div>
          <p class="muted">Enter this code at checkout on your next due payment. Questions? Reply to this email or reach us at support@duevy.app</p>
        `),
        text: `Hi ${c.user.name}, your Duevy wallet balance of ${formatNaira(c.amountKobo)} is now discount code ${c.code} — apply it next time you pay a due.`,
      });
      console.log(`✔ ${c.user.email} notified (${c.code})`);
    } catch (err) {
      console.error(`✘ ${c.user.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
