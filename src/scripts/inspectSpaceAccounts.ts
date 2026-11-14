/**
 * Read-only: list spaces and their current wallet (permanent) account, so we
 * can see which ones still carry an old-provider account before re-provisioning.
 *
 *   tsx src/scripts/inspectSpaceAccounts.ts
 */
import { db } from '../config/db';

async function main() {
  const spaces = await db.space.findMany({
    select: {
      id: true,
      name: true,
      isArchived: true,
      walletAccountNumber: true,
      walletAccountName: true,
      walletBankName: true,
      walletBankCode: true,
      walletAccountId: true,
      walletCreatedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${spaces.length} space(s):\n`);
  for (const s of spaces) {
    console.log(`• ${s.name} (${s.id})${s.isArchived ? ' [archived]' : ''}`);
    console.log(
      `    acct: ${s.walletAccountNumber ?? '—'}  bank: ${s.walletBankName ?? '—'} (${s.walletBankCode ?? '—'})  name: ${s.walletAccountName ?? '—'}`,
    );
    console.log(`    acctId: ${s.walletAccountId ?? '—'}  opened: ${s.walletCreatedAt?.toISOString() ?? '—'}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
