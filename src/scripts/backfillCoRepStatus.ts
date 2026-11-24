/**
 * One-off: make sure every co-rep's account is fully provisioned, so none is
 * left looking like a pending applicant (which would show them the "Complete
 * verification" banner and lock them out of rep pages).
 *
 * A co-rep never needs their own KYC — the space's lead rep is verified, and
 * that's what gates collection — so any co-rep still sitting on a non-approved
 * rep-application status (or missing `isRep`) is a straggler to fix. Every path
 * that adds a co-rep already sets `repApplicationStatus: 'approved'`, so in
 * practice this should find nothing; it exists to confirm that and to repair
 * anyone provisioned before that was guaranteed.
 *
 * Run where the API's production env is loaded (the API container):
 *   docker compose exec api node dist/scripts/backfillCoRepStatus.js         # dry run: list only
 *   docker compose exec api node dist/scripts/backfillCoRepStatus.js --fix   # backfill them
 *
 * Safe to re-run: it only touches co-reps that aren't already approved reps.
 */
import { db } from '../config/db';

export async function backfillCoRepStatus(fix: boolean, log: (line: string) => void = console.log) {
  // A co-rep (a space_reps row with role 'co') whose account isn't a fully
  // provisioned rep: wrong application status, or not flagged as a rep.
  const stragglers = await db.user.findMany({
    where: {
      spaceReps: { some: { role: 'co' } },
      OR: [{ repApplicationStatus: { not: 'approved' } }, { isRep: false }],
    },
    select: { id: true, name: true, email: true, role: true, isRep: true, repApplicationStatus: true },
    orderBy: { createdAt: 'asc' },
  });

  log(`${stragglers.length} co-rep(s) to repair${fix ? '' : ' (dry run — pass --fix to backfill)'}`);

  let fixed = 0;
  for (const u of stragglers) {
    const was = `status=${u.repApplicationStatus}, isRep=${u.isRep}, role=${u.role}`;
    if (!fix) {
      log(`  would fix: ${u.email} (${u.id}) — ${was}`);
      continue;
    }
    await db.user.update({
      where: { id: u.id },
      data: {
        repApplicationStatus: 'approved',
        isRep: true,
        // Promote a lingering student account to rep; never touch an admin.
        ...(u.role === 'student' ? { role: 'rep' } : {}),
      },
    });
    fixed++;
    log(`  fixed: ${u.email} (${u.id}) — ${was} → approved rep`);
  }

  return { total: stragglers.length, fixed };
}

if (require.main === module) {
  backfillCoRepStatus(process.argv.includes('--fix'))
    .then((r) => {
      console.log(`done: ${r.fixed} fixed of ${r.total}`);
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
