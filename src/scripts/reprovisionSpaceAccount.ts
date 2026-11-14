/**
 * One-off: replace a space's permanent (wallet) account with a freshly created
 * one from the CURRENT payment provider. Used to move a space that was opened
 * under the old provider (9jaPay) onto an Interswitch Virtual Account.
 *
 *   tsx src/scripts/reprovisionSpaceAccount.ts --space=<id>            # dry run
 *   tsx src/scripts/reprovisionSpaceAccount.ts --space=<id> --apply    # do it
 *
 * ensureSpaceAccount only opens an account when the space has none, so we clear
 * the wallet fields first, then let it provision against the active provider.
 * If the provider call fails, the old fields are restored so the space is never
 * left worse than before. NOTE: the old provider account is abandoned — drain /
 * reconcile any balance on it separately before running against live data.
 */
import type { Space } from '@prisma/client';
import { db } from '../config/db';
import { ensureSpaceAccount } from '../services/sweep.service';
import { getPaymentProvider } from '../providers/payment';

type WalletFields = Pick<
  Space,
  | 'walletAccountId'
  | 'walletAccountNumber'
  | 'walletAccountName'
  | 'walletBankName'
  | 'walletBankCode'
  | 'walletCreatedAt'
>;

function walletOf(s: WalletFields): WalletFields {
  return {
    walletAccountId: s.walletAccountId,
    walletAccountNumber: s.walletAccountNumber,
    walletAccountName: s.walletAccountName,
    walletBankName: s.walletBankName,
    walletBankCode: s.walletBankCode,
    walletCreatedAt: s.walletCreatedAt,
  };
}

async function main() {
  const spaceId = process.argv.find((a) => a.startsWith('--space='))?.slice('--space='.length);
  const apply = process.argv.includes('--apply');
  if (!spaceId) {
    console.error('Pass --space=<spaceId>');
    process.exit(2);
  }

  const space = await db.space.findUnique({ where: { id: spaceId } });
  if (!space) {
    console.error(`Space ${spaceId} not found`);
    process.exit(1);
  }
  if (space.isArchived) {
    console.error('Space is archived; refusing.');
    process.exit(1);
  }

  const old = walletOf(space);
  console.log(`Space: ${space.name} (${space.id})`);
  console.log(`Active provider: ${getPaymentProvider().name}`);
  console.log(
    `Current account: ${old.walletAccountNumber ?? '—'}  ${old.walletBankName ?? '—'} (${old.walletBankCode ?? '—'})  ${old.walletAccountName ?? '—'}`,
  );

  if (!apply) {
    console.log('\nDry run — pass --apply to clear the above and open a new account from the active provider.');
    return;
  }

  // Clear the wallet pointer so ensureSpaceAccount will provision anew.
  await db.space.update({
    where: { id: space.id },
    data: {
      walletAccountId: null,
      walletAccountNumber: null,
      walletAccountName: null,
      walletBankName: null,
      walletBankCode: null,
      walletCreatedAt: null,
    },
  });

  try {
    const updated = await ensureSpaceAccount(space.id);
    console.log('\nNew account opened:');
    console.log(
      `    ${updated.walletAccountNumber}  ${updated.walletBankName} (${updated.walletBankCode})  ${updated.walletAccountName}`,
    );
    console.log(`    acctId: ${updated.walletAccountId}  opened: ${updated.walletCreatedAt?.toISOString()}`);
    if (old.walletAccountNumber) {
      console.log(`\n⚠️  Old account ${old.walletAccountNumber} (${old.walletBankName}) is now abandoned — reconcile any balance on it separately.`);
    }
  } catch (err) {
    // Restore so the space isn't left with no account.
    await db.space.update({ where: { id: space.id }, data: old });
    console.error('\nProvider failed to open a new account; restored the previous one.');
    console.error((err as Error).message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
