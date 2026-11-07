/**
 * Seed the deploy rehearsal's Postgres (deploy/rehearsal/compose.yml exposes
 * it on localhost:55440) with students, a verified space and dues, and write
 * load-tests/.rehearsal.json for load-tests/rolling-deploy.js.
 *
 *   DATABASE_URL=postgresql://duevy:duevy@localhost:55440/duevy npx tsx scripts/loadtest/seed-rehearsal.ts
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const STUDENTS = 200;
const db = new PrismaClient();

async function main() {
  const run = Date.now();
  const rep = await db.user.create({
    data: { name: 'Rehearsal Rep', email: `rep_${run}@rehearsal.duevy`, emailVerified: true, role: 'rep', isRep: true, repApplicationStatus: 'approved', kycStatus: 'verified', ninCheckOutcome: 'match', studentIdStatus: 'approved' },
  });
  const space = await db.space.create({
    data: { name: `Rehearsal ${run}`, short: 'RHS', kind: 'department', school: 'LAUTECH', joinCode: `RH-${run}`.slice(0, 24), walletAccountId: `va_rh_${run}`, walletAccountNumber: `92${String(run).slice(-8)}`, walletAccountName: 'DUEVY/RHS', walletBankName: '9jaPay', walletBankCode: '090629', walletCreatedAt: new Date() },
  });
  await db.spaceRep.create({ data: { userId: rep.id, spaceId: space.id, role: 'lead' } });
  const due = await db.due.create({ data: { spaceId: space.id, title: 'Rehearsal due', amount: 250_000, dueDate: new Date(Date.now() + 30 * 86_400_000), category: 'departmental_due', status: 'active' } });
  const students = Array.from({ length: STUDENTS }, (_, i) => ({ id: `usr_rh_${run}_${i}`, name: `Student ${i}`, email: `s${i}_${run}@rehearsal.duevy`, emailVerified: true }));
  await db.user.createMany({ data: students });
  await db.spaceMembership.createMany({ data: students.map((s) => ({ userId: s.id, spaceId: space.id })) });
  writeFileSync(
    path.join(__dirname, '../../load-tests/.rehearsal.json'),
    JSON.stringify({ jwtSecret: 'rehearsal-access-secret-0123456789abcdef0123', joinCode: space.joinCode, dueId: due.id, students: students.map((s) => ({ id: s.id, spaceId: space.id })) }),
  );
  console.log(`seeded ${STUDENTS} students in ${space.id}`);
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
