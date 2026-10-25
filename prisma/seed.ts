/**
 * Development seed: one super admin, one approved test rep with a LAUTECH
 * space and dues, one test student who has joined it.
 *
 * The rep is left unverified: KYC runs for real (phone OTP and NIN with Didit,
 * then the wallet at the Bank78 sandbox), so no payment data is seeded.
 *
 * Idempotent: safe to re-run. Refuses to run with NODE_ENV=production.
 *
 * Run with: npm run db:seed
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/config/db';
import { env } from '../src/config/env';
import { getSpaceBalance } from '../src/services/ledger.service';

const PASSWORD = 'Demo1234!';
const JOIN_CODE = 'CSC-LAU1';

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const passwordHash = await bcrypt.hash(PASSWORD, env.BCRYPT_ROUNDS);
  const now = new Date();

  // --- Super admin -----------------------------------------------------------
  const admin = await db.user.upsert({
    where: { email: 'admin@duevy.test' },
    update: {},
    create: {
      name: 'Duevy Admin',
      email: 'admin@duevy.test',
      emailVerified: true,
      passwordHash,
      role: 'admin',
      adminSubRole: 'super_admin',
      termsAcceptedAt: now,
      termsVersion: '1.0.0',
    },
  });
  await db.adminPermission.upsert({
    where: { userId: admin.id },
    update: {},
    create: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true },
  });

  // --- Test rep (approved) ---------------------------------------------------
  const rep = await db.user.upsert({
    where: { email: 'rep@duevy.test' },
    update: {},
    create: {
      name: 'Tunde Okafor',
      email: 'rep@duevy.test',
      emailVerified: true,
      passwordHash,
      phone: '+2348012345678',
      role: 'rep',
      isRep: true,
      repApplicationStatus: 'approved',
      institution: 'LAUTECH',
      matricNo: '190802044',
      level: '400',
      termsAcceptedAt: now,
      termsVersion: '1.0.0',
    },
  });

  const space = await db.space.upsert({
    where: { joinCode: JOIN_CODE },
    update: {},
    create: {
      name: 'Computer Science Department',
      short: 'CSC',
      kind: 'department',
      hue: 'indigo',
      theme: 'ocean',
      about: 'Departmental dues, handouts and lab manuals for CSC students.',
      faculty: 'Engineering and Technology',
      school: 'Ladoke Akintola University of Technology',
      institution: 'LAUTECH',
      joinCode: JOIN_CODE,
    },
  });
  await db.spaceRep.upsert({
    where: { userId_spaceId: { userId: rep.id, spaceId: space.id } },
    update: {},
    create: { userId: rep.id, spaceId: space.id, role: 'lead' },
  });
  await db.spaceMembership.upsert({
    where: { userId_spaceId: { userId: rep.id, spaceId: space.id } },
    update: {},
    create: { userId: rep.id, spaceId: space.id },
  });

  // --- Dues --------------------------------------------------------------------
  const inDays = (d: number) => new Date(Date.now() + d * 864e5);
  async function upsertDue(title: string, amount: number, category: 'handout' | 'departmental_due' | 'lab_manual' | 'exam_levy', days: number) {
    const existing = await db.due.findFirst({ where: { spaceId: space.id, title } });
    if (existing) return existing;
    return db.due.create({
      data: {
        spaceId: space.id,
        title,
        amount,
        category,
        dueDate: inDays(days),
        // Publishing needs a rep who can collect; until KYC is done these are drafts.
        status: 'draft',
        publishedAt: null,
        assignedRepId: rep.id,
      },
    });
  }
  await upsertDue('2026/2027 Departmental Due', 500_000, 'departmental_due', 30); // ₦5,000
  await upsertDue('CSC 301 Handout', 150_000, 'handout', 14); // ₦1,500
  await upsertDue('CSC 305 Lab Manual', 250_000, 'lab_manual', 21); // ₦2,500
  await upsertDue('Rain Semester Exam Levy', 300_000, 'exam_levy', 45); // ₦3,000

  // --- Test student ------------------------------------------------------------
  const student = await db.user.upsert({
    where: { email: 'student@duevy.test' },
    update: {},
    create: {
      name: 'Aisha Bello',
      email: 'student@duevy.test',
      emailVerified: true,
      passwordHash,
      phone: '+2348098765432',
      institution: 'LAUTECH',
      matricNo: '210805019',
      level: '300',
      termsAcceptedAt: now,
      termsVersion: '1.0.0',
    },
  });
  await db.spaceMembership.upsert({
    where: { userId_spaceId: { userId: student.id, spaceId: space.id } },
    update: {},
    create: { userId: student.id, spaceId: space.id },
  });

  const balance = await getSpaceBalance(space.id);
  console.log('Seeded.\n');
  console.log(`  super admin  admin@duevy.test / ${PASSWORD}`);
  console.log(`  rep          rep@duevy.test / ${PASSWORD}   (KYC: not verified — run it against Didit and the Bank78 sandbox)`);
  console.log(`  student      student@duevy.test / ${PASSWORD}`);
  console.log(`  space        ${space.name} — join code ${space.joinCode}`);
  console.log(`  space balance ₦${(balance / 100).toLocaleString('en-NG')}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
