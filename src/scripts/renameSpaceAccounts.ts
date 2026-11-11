/**
 * One-off: give every existing space account the unique name
 * "DUEVY/<space name>-<3 letters>" (accounts opened before the suffix show
 * just "DUEVY/<space name>"). Uses 9jaPay's Update Permanent Virtual Account.
 *
 * Run where the API's production env is loaded (the API container), ideally
 * when withdrawals are quiet: the API and worker re-read a sending account's
 * name every 10 minutes, so a withdrawal sent in that window still uses the
 * old name.
 *   docker compose exec api node dist/scripts/renameSpaceAccounts.js           # dry run: list only
 *   docker compose exec api node dist/scripts/renameSpaceAccounts.js --apply   # rename them
 *
 * Safe to re-run: a space whose account already has the new form for its
 * current name is skipped.
 */
import { db } from '../config/db';
import { isCurrentSpaceAccountName } from '../lib/spaceAccountName';
import { renameSpaceAccount } from '../services/sweep.service';

export async function renameSpaceAccounts(apply: boolean, log: (line: string) => void = console.log) {
  const spaces = await db.space.findMany({
    where: { walletAccountNumber: { not: null } },
    select: { id: true, name: true, walletAccountNumber: true, walletAccountName: true },
    orderBy: { createdAt: 'asc' },
  });
  const due = spaces.filter((s) => !isCurrentSpaceAccountName(s.walletAccountName, s.name));
  log(`${due.length} of ${spaces.length} space account(s) to rename${apply ? '' : ' (dry run — pass --apply to rename them)'}`);
  let renamed = 0;
  let failed = 0;
  for (const s of due) {
    const acct = `••${s.walletAccountNumber?.slice(-4)}`;
    if (!apply) {
      log(`  would rename: ${s.name} ${acct} (now "${s.walletAccountName}")`);
      continue;
    }
    try {
      const result = await renameSpaceAccount(s.id);
      renamed++;
      log(`  renamed: ${s.name} ${acct}: "${s.walletAccountName}" → "${result.accountName}"`);
    } catch (err) {
      failed++;
      log(`  FAILED: ${s.name} (${s.id}): ${(err as Error).message}`);
    }
  }
  return { total: due.length, renamed, failed };
}

if (require.main === module) {
  renameSpaceAccounts(process.argv.includes('--apply'))
    .then((r) => {
      console.log(`done: ${r.renamed} renamed, ${r.failed} failed of ${r.total}`);
      process.exitCode = r.failed ? 1 : 0;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
