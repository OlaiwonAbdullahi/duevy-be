/**
 * One-off: open the 9jaPay account for every live space that doesn't have one
 * yet (spaces created before the 9jaPay cutover). The daily sweep does the same
 * 25 at a time from 2am Lagos; this does them all now.
 *
 * Run where the API's production env is loaded (the API container):
 *   docker compose exec api node dist/scripts/backfillSpaceAccounts.js           # dry run: list only
 *   docker compose exec api node dist/scripts/backfillSpaceAccounts.js --apply   # open the accounts
 *
 * Safe to re-run: ensureSpaceAccount skips a space that already has one.
 */
import { db } from '../config/db';
import { ensureSpaceAccount } from '../services/sweep.service';

export async function backfillSpaceAccounts(apply: boolean, log: (line: string) => void = console.log) {
  const missing = await db.space.findMany({
    where: { walletAccountNumber: null, isArchived: false },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  log(`${missing.length} space(s) without an account${apply ? '' : ' (dry run — pass --apply to open them)'}`);
  let opened = 0;
  let failed = 0;
  for (const s of missing) {
    if (!apply) {
      log(`  would open: ${s.name} (${s.id})`);
      continue;
    }
    try {
      const space = await ensureSpaceAccount(s.id);
      opened++;
      log(`  opened: ${s.name} → ••${space.walletAccountNumber?.slice(-4)} (${space.walletAccountName})`);
    } catch (err) {
      failed++;
      log(`  FAILED: ${s.name} (${s.id}): ${(err as Error).message}`);
    }
  }
  return { total: missing.length, opened, failed };
}

if (require.main === module) {
  backfillSpaceAccounts(process.argv.includes('--apply'))
    .then((r) => {
      console.log(`done: ${r.opened} opened, ${r.failed} failed of ${r.total}`);
      process.exitCode = r.failed ? 1 : 0;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
