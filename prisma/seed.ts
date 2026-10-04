/**
 * Development seed: one super admin, one approved test rep with a LAUTECH
 * space and dues, one test student who has joined it.
 *
 * With PAYMENT_PROVIDER=fake the rep is also KYC-verified (against fake
 * provider ids) with a payout account, and the student has one paid checkout,
 * created through the real checkout service, so the ledger, receipt and rep
 * dashboard all have data. With PAYMENT_PROVIDER=bachs the rep is left
 * unverified: KYC must be done for real against the Bachs sandbox.
 *
 * Idempotent: safe to re-run. Refuses to run with NODE_ENV=production.
 *
 * Run with: npm run db:seed
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/config/db';
import { env } from '../src/config/env';
import { encrypt, maskAccountNumber } from '../src/lib/encryption';
import { createCheckout, fulfilCheckout, findCheckoutId } from '../src/services/checkout.service';
import { getSpaceBalance } from '../src/services/ledger.service';

const PASSWORD = 'Demo1234!';
const JOIN_CODE = 'CSC-LAU1';

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const fake = env.PAYMENT_PROVIDER === 'fake';
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
      ...(fake
        ? {
            kycStatus: 'verified' as const,
            bachsAccountId: 'acct_fake_seed_rep',
            bachsPersonId: 'per_fake_seed_rep',
            bachsPayoutsActive: true,
            studentIdStatus: 'approved' as const,
            studentIdUploadedAt: now,
            studentIdReviewedAt: now,
            kycSubmittedAt: now,
            kycResolvedAt: now,
          }
        : {}),
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

  if (fake) {
    const accountNumber = '0123456789';
    if (!(await db.payoutBeneficiary.findFirst({ where: { spaceId: space.id } }))) {
      await db.payoutBeneficiary.create({
        data: {
          spaceId: space.id,
          label: 'My account',
          bankCode: '058',
          bankName: 'Guaranty Trust Bank',
          accountNumber: encrypt(accountNumber),
          accountNumberMasked: maskAccountNumber(accountNumber),
          accountName: 'OKAFOR TUNDE',
          bachsDestinationId: 'pd_fake_seed_rep',
          bachsAccountId: 'acct_fake_seed_rep',
          createdById: rep.id,
        },
      });
    }
  }

  // --- Dues --------------------------------------------------------------------
  const inDays = (d: number) => new Date(Date.now() + d * 864e5);
  async function upsertDue(title: string, amount: number, category: 'handout' | 'departmental_due' | 'lab_manual' | 'exam_levy', days: number, active: boolean) {
    const existing = await db.due.findFirst({ where: { spaceId: space.id, title } });
    if (existing) return existing;
    return db.due.create({
      data: {
        spaceId: space.id,
        title,
        amount,
        category,
        dueDate: inDays(days),
        // Publishing needs a verified rep; without one these stay drafts.
        status: active && fake ? 'active' : 'draft',
        publishedAt: active && fake ? now : null,
        assignedRepId: rep.id,
      },
    });
  }
  const departmental = await upsertDue('2026/2027 Departmental Due', 500_000, 'departmental_due', 30, true); // ₦5,000
  const handout = await upsertDue('CSC 301 Handout', 150_000, 'handout', 14, true); // ₦1,500
  await upsertDue('CSC 305 Lab Manual', 250_000, 'lab_manual', 21, true); // ₦2,500
  await upsertDue('Rain Semester Exam Levy', 300_000, 'exam_levy', 45, false); // draft

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

  // --- One paid checkout (fake provider only) ---------------------------------
  let paidNote = 'skipped (PAYMENT_PROVIDER is not fake)';
  if (fake) {
    const alreadyPaid = await db.duePayment.findFirst({ where: { userId: student.id, dueId: { in: [departmental.id, handout.id] } } });
    if (!alreadyPaid) {
      const { checkout } = await createCheckout(student.id, [departmental.id, handout.id]);
      await fulfilCheckout(await findCheckoutId(checkout.reference, null), checkout.amount, 0, 'seed');
      paidNote = `${checkout.reference} — ₦${(checkout.amount / 100).toLocaleString('en-NG')} for 2 dues`;
    } else {
      paidNote = `already present (${alreadyPaid.reference})`;
    }
  }

  const balance = await getSpaceBalance(space.id);
  console.log('Seeded.\n');
  console.log(`  super admin  admin@duevy.test / ${PASSWORD}`);
  console.log(`  rep          rep@duevy.test / ${PASSWORD}   (KYC: ${fake ? 'verified (fake provider)' : 'not verified — run KYC against the Bachs sandbox'})`);
  console.log(`  student      student@duevy.test / ${PASSWORD}`);
  console.log(`  space        ${space.name} — join code ${space.joinCode}`);
  console.log(`  paid example ${paidNote}`);
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
