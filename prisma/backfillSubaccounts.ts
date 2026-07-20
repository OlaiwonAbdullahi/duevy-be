/**
 * One-off backfill: create a Paystack subaccount for every space that already
 * has a BankAccount on file but no paystackSubaccountCode yet — reps who set
 * up payouts before the payment architecture migration. Safe to re-run
 * (skips spaces that already have a code). Run with: npx tsx prisma/backfillSubaccounts.ts
 *
 * Self-healing: a stored bankCode may have been resolved under a different
 * gateway than the one currently active (Monnify and Paystack number the
 * same bank differently) — resolveActiveBankCode() re-verifies and corrects
 * it before use, rather than blindly trusting a possibly-stale code.
 */
import { db } from '../src/config/db';
import { decrypt } from '../src/lib/encryption';
import { createSubaccount } from '../src/lib/paymentGateway';
import { PLATFORM_PERCENTAGE_CHARGE } from '../src/lib/money';
import { resolveActiveBankCode } from '../src/services/payout.service';

async function main() {
  const spaces = await db.space.findMany({
    where: { paystackSubaccountCode: null, bankAccount: { isNot: null } },
    include: { bankAccount: true },
  });

  console.log(`Found ${spaces.length} space(s) needing a subaccount.`);

  for (const space of spaces) {
    if (!space.bankAccount) continue;
    try {
      const bankCode = await resolveActiveBankCode(space.bankAccount);
      const { subaccountCode } = await createSubaccount({
        businessName: space.name,
        bankCode,
        accountNumber: decrypt(space.bankAccount.accountNumber),
        percentageCharge: PLATFORM_PERCENTAGE_CHARGE,
      });
      await db.space.update({ where: { id: space.id }, data: { paystackSubaccountCode: subaccountCode } });
      console.log(`✔ ${space.name} (${space.id}) -> ${subaccountCode}`);
    } catch (err) {
      console.error(`✘ ${space.name} (${space.id}) failed:`, err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
