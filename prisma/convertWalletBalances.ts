/**
 * One-off migration: the wallet balance system was removed (payment
 * architecture migration — float custody risk). Any user who still had a
 * nonzero balance at cutover gets it converted 1:1 into a DiscountCode
 * (redeemable against their next due payment) instead of the money just
 * disappearing when the walletBalance column is dropped. Emails each
 * affected user their code. Safe to re-run — only touches users with
 * walletBalance > 0, and zeroes it out per-user as it goes.
 *
 * Run with: npx tsx prisma/convertWalletBalances.ts
 * Run BEFORE removing `walletBalance` from schema.prisma and pushing again.
 */
import { randomInt } from 'crypto';
import { db } from '../src/config/db';
import { sendEmail, renderEmail } from '../src/lib/email';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous, no 0/O/1/I

async function uniqueDiscountCode(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    let suffix = '';
    for (let j = 0; j < 8; j++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `BAL-${suffix}`;
    if (!(await db.discountCode.findUnique({ where: { code } }))) return code;
  }
  return `BAL-${Date.now()}`;
}

function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

async function main() {
  const users = await db.$queryRawUnsafe<Array<{ id: string; name: string; email: string; walletBalance: number }>>(
    'SELECT id, name, email, "walletBalance" FROM users WHERE "walletBalance" > 0',
  );

  console.log(`Found ${users.length} user(s) with a nonzero wallet balance.`);

  for (const user of users) {
    const code = await uniqueDiscountCode();
    try {
      await db.$transaction([
        db.discountCode.create({
          data: { code, userId: user.id, amountKobo: user.walletBalance },
        }),
        db.$executeRawUnsafe('UPDATE users SET "walletBalance" = 0 WHERE id = $1', user.id),
      ]);

      await sendEmail({
        to: user.email,
        subject: 'Your Duevy wallet balance is now a discount code',
        html: renderEmail(`
          <h1>Your balance became a discount code</h1>
          <p>Hi ${user.name}, we've retired Duevy's wallet balance feature. Your remaining balance of <strong>${formatNaira(user.walletBalance)}</strong> hasn't gone anywhere — it's now a discount code you can apply the next time you pay a due.</p>
          <div class="callout"><strong>Your code:</strong> ${code}</div>
          <p class="muted">Enter this code at checkout on your next due payment. Questions? Reply to this email or reach us at support@duevy.app</p>
        `),
        text: `Hi ${user.name}, your Duevy wallet balance of ${formatNaira(user.walletBalance)} is now discount code ${code} — apply it next time you pay a due.`,
      });

      console.log(`✔ ${user.email} — ${formatNaira(user.walletBalance)} -> ${code}`);
    } catch (err) {
      console.error(`✘ ${user.email} failed:`, err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
