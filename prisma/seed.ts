/**
 * Development seed: one super admin, one approved test rep with a LAUTECH
 * space and dues, one test student who has joined it.
 *
 * With PAYMENT_PROVIDER=fake the rep is KYC-verified with a beneficiary,
 * the space has a (fake) account, and the student has one paid checkout so
 * the ledger, receipt and rep dashboard all have data.
 *
 * With PAYMENT_PROVIDER=interswitch the rep is KYC-verified, the space gets
 * a real Interswitch virtual account (sandbox), and dues are published.
 * Checkouts go through the IPG gateway so there's no auto-paid example.
 *
 * Idempotent: safe to re-run. Refuses to run with NODE_ENV=production
 * unless SEED_FORCE=1 is set (for seeding a dev database that shares a
 * production-like config).
 *
 * Run with: npm run db:seed
 */
import { hashPassword } from '../src/lib/password';
import { db } from '../src/config/db';
import { env } from '../src/config/env';
import { encrypt, maskAccountNumber } from '../src/lib/encryption';
import { createCheckout, fulfilCheckout, findCheckoutId } from '../src/services/checkout.service';
import { getSpaceBalance } from '../src/services/ledger.service';
import { ensureSpaceAccount } from '../src/services/sweep.service';

const PASSWORD = 'Demo1234!';
const JOIN_CODE = 'CSC-LAU1';

async function main() {
  if (env.NODE_ENV === 'production' && !process.env.SEED_FORCE) {
    throw new Error('Refusing to seed a production database (set SEED_FORCE=1 to override)');
  }

  const provider = env.PAYMENT_PROVIDER;
  const fake = provider === 'fake';
  const interswitch = provider === 'interswitch';
  const canVerify = fake || interswitch;
  const passwordHash = await hashPassword(PASSWORD, env.BCRYPT_ROUNDS);
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
  const kycFields = canVerify
    ? {
        kycStatus: 'verified' as const,
        ninCheckOutcome: 'match',
        studentIdStatus: 'approved' as const,
        studentIdUploadedAt: now,
        studentIdReviewedAt: now,
        livenessStatus: 'approved' as const,
        livenessReviewedAt: now,
        livenessReviewNote: 'Seeded demo rep',
        kycSubmittedAt: now,
        kycResolvedAt: now,
      }
    : {};

  const rep = await db.user.upsert({
    where: { email: 'rep@duevy.test' },
    update: canVerify ? kycFields : {},
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
      ...kycFields,
    },
  });

  // --- Space -----------------------------------------------------------------
  const fakeWallet = fake
    ? {
        walletAccountId: 'va_fake_seed_space',
        walletAccountNumber: '9100000001',
        walletAccountName: 'DUEVY/Computer Science Department',
        walletBankName: '9jaPay',
        walletBankCode: '090629',
        walletCreatedAt: new Date(),
      }
    : {};

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
      ...fakeWallet,
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

  // Interswitch: provision a real VA via the sandbox API if the space has none.
  let walletNote = 'none (provider does not provision VAs in seed)';
  if (interswitch && !space.walletAccountNumber) {
    try {
      const updated = await ensureSpaceAccount(space.id);
      walletNote = `${updated.walletAccountNumber} @ ${updated.walletBankName}`;
    } catch (err) {
      walletNote = `failed: ${(err as Error).message}`;
      console.warn('  ⚠ Could not provision Interswitch VA:', (err as Error).message);
    }
  } else if (space.walletAccountNumber) {
    walletNote = `${space.walletAccountNumber} (already provisioned)`;
  }

  // Beneficiary for payouts
  if (canVerify) {
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
          createdById: rep.id,
        },
      });
    }
  }

  // --- Dues ------------------------------------------------------------------
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
        status: active && canVerify ? 'active' : 'draft',
        publishedAt: active && canVerify ? now : null,
        assignedRepId: rep.id,
      },
    });
  }
  const departmental = await upsertDue('2026/2027 Departmental Due', 500_000, 'departmental_due', 30, true);
  const handout = await upsertDue('CSC 301 Handout', 150_000, 'handout', 14, true);
  await upsertDue('CSC 305 Lab Manual', 250_000, 'lab_manual', 21, true);
  await upsertDue('Rain Semester Exam Levy', 300_000, 'exam_levy', 45, false);

  // --- Test student ----------------------------------------------------------
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

  // --- One paid checkout (fake provider only) --------------------------------
  let paidNote = 'skipped (gateway checkout — pay via the Interswitch IPG popup)';
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
  console.log(`  provider     ${provider}`);
  console.log(`  super admin  admin@duevy.test / ${PASSWORD}`);
  console.log(`  rep          rep@duevy.test / ${PASSWORD}   (KYC: ${canVerify ? 'verified' : 'not verified — run KYC against the sandbox'})`);
  console.log(`  student      student@duevy.test / ${PASSWORD}`);
  console.log(`  space        ${space.name} — join code ${space.joinCode}`);
  console.log(`  space wallet ${walletNote}`);
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
