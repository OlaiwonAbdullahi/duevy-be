/**
 * Demo data seed — a rep account, a student account, and a full slate of
 * data (dues, a settled payment, a payout, a poll, notifications) so Duey and
 * the rest of the API can be exercised end-to-end without a real signup flow.
 *
 * Idempotent: safe to re-run. Existing rows are upserted/reused rather than
 * duplicated, keyed on each model's natural unique field where one exists.
 *
 * Run with: npm run db:seed
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/config/db';
import { env } from '../src/config/env';
import { encrypt, maskAccountNumber } from '../src/lib/encryption';
import { computeCharge } from '../src/lib/money';
import { generateReferralCode } from '../src/lib/referral';

const DEMO_PASSWORD = 'Demo1234!';
const JOIN_CODE = 'CSSA-7F2K';

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, env.BCRYPT_ROUNDS);

  // -------------------------------------------------------------------------
  // Rep account + their space
  // -------------------------------------------------------------------------
  const rep = await db.user.upsert({
    where: { email: 'rep@duevy.demo' },
    update: {},
    create: {
      name: 'Tunde Okafor',
      email: 'rep@duevy.demo',
      emailVerified: true,
      passwordHash,
      phone: '+2348012345678',
      role: 'rep',
      repApplicationStatus: 'approved',
      matricNo: '190802044',
      level: '400',
      referralCode: await generateReferralCode('Tunde Okafor'),
      kycStatus: 'verified',
      termsAcceptedAt: new Date(),
      termsVersion: '1.0',
    },
  });

  const space = await db.space.upsert({
    where: { joinCode: JOIN_CODE },
    update: {},
    create: {
      name: 'Computer Science Student Association',
      short: 'CSSA',
      kind: 'association',
      hue: 'indigo',
      theme: 'ocean',
      about: 'The umbrella body for CS undergraduates — dues, events, and department news.',
      faculty: 'Physical Sciences',
      school: 'University of Lagos',
      joinCode: JOIN_CODE,
    },
  });

  await db.spaceRep.upsert({
    where: { userId_spaceId: { userId: rep.id, spaceId: space.id } },
    update: {},
    create: { userId: rep.id, spaceId: space.id, role: 'lead' },
  });

  // Bank account on file (so payout requests + BankAccount reads have something to show).
  const accountNumber = '0123456789';
  await db.bankAccount.upsert({
    where: { spaceId: space.id },
    update: {},
    create: {
      spaceId: space.id,
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: maskAccountNumber(accountNumber),
      accountName: 'CSSA UNILAG',
    },
  });

  await db.payout.upsert({
    where: { reference: 'PAY-2026-0001' },
    update: {},
    create: {
      spaceId: space.id,
      amount: 500_000, // ₦5,000
      reference: 'PAY-2026-0001',
      status: 'completed',
      accountMasked: 'GTBank •••• 6789',
      note: 'Weekly payout',
      settledAt: new Date(),
    },
  });

  // -------------------------------------------------------------------------
  // Student account + membership
  // -------------------------------------------------------------------------
  const student = await db.user.upsert({
    where: { email: 'student@duevy.demo' },
    update: {},
    create: {
      name: 'Aisha Bello',
      email: 'student@duevy.demo',
      emailVerified: true,
      passwordHash,
      phone: '+2348098765432',
      role: 'student',
      matricNo: '210805019',
      level: '300',
      referralCode: await generateReferralCode('Aisha Bello'),
      kycStatus: 'verified',
      termsAcceptedAt: new Date(),
      termsVersion: '1.0',
    },
  });

  await db.spaceMembership.upsert({
    where: { userId_spaceId: { userId: student.id, spaceId: space.id } },
    update: {},
    create: { userId: student.id, spaceId: space.id, kind: 'member' },
  });

  // -------------------------------------------------------------------------
  // Dues — one unpaid (for pay_dues / check_balance), one already settled
  // (for view_history). Amounts match the worked examples in the assistant docs.
  // -------------------------------------------------------------------------
  async function upsertDue(title: string, amount: number, dueDate: Date) {
    const existing = await db.due.findFirst({ where: { spaceId: space.id, title } });
    if (existing) return existing;
    return db.due.create({
      data: {
        spaceId: space.id,
        title,
        amount,
        dueDate,
        category: 'levy',
        status: 'active',
        publishedAt: new Date(),
      },
    });
  }

  const handoutFee = await upsertDue('Handout Fee', 500_000, new Date('2026-08-15')); // ₦5,000 face → ₦5,150 payable
  const dinnerLevy = await upsertDue('Dinner Levy', 1_000_000, new Date('2026-09-01')); // ₦10,000 face → ₦10,300 payable

  // Dinner Levy already settled (via card) — sets up realistic history for view_history.
  const dinnerCharge = computeCharge(dinnerLevy.amount);
  const dinnerTxn = await db.transaction.upsert({
    where: { reference: 'DVY-DEMO-0002' },
    update: {},
    create: {
      userId: student.id,
      type: 'due',
      title: dinnerLevy.title,
      detail: space.name,
      amount: -dinnerCharge.totalCharged,
      method: 'Monnify',
      status: 'completed',
      reference: 'DVY-DEMO-0002',
      spaceId: space.id,
    },
  });
  await db.duePayment.upsert({
    where: { userId_dueId: { userId: student.id, dueId: dinnerLevy.id } },
    update: {},
    create: {
      userId: student.id,
      dueId: dinnerLevy.id,
      txnId: dinnerTxn.id,
      reference: 'DVY-DEMO-0002',
      amountPaid: dinnerCharge.totalCharged,
      monnifyFee: dinnerCharge.monnifyFee,
      duevyFee: dinnerCharge.duevyFee,
      netToSpace: dinnerCharge.netToSpace,
    },
  });

  // Handout Fee is left unpaid on purpose — this is the due Duey's pay_dues
  // and check_balance examples resolve to.
  void handoutFee;

  // -------------------------------------------------------------------------
  // A paid poll — exercises the polls feature end-to-end.
  // -------------------------------------------------------------------------
  const poll = await db.poll.upsert({
    where: { slug: 'best-coder-award-cssa' },
    update: {},
    create: {
      spaceId: space.id,
      title: 'Best Coder Award',
      description: "Vote for CSSA's most impressive coder this session.",
      deadline: new Date('2026-08-30'),
      status: 'active',
      membersOnly: true,
      paid: true,
      amountPerVote: 5_000, // ₦50/vote
      slug: 'best-coder-award-cssa',
      totalVotes: 20,
      revenue: 100_000,
      publishedAt: new Date(),
    },
  });

  let category = await db.pollCategory.findFirst({ where: { pollId: poll.id, title: 'Overall Winner' } });
  if (!category) {
    category = await db.pollCategory.create({ data: { pollId: poll.id, title: 'Overall Winner' } });
  }

  async function upsertNominee(name: string, votes: number) {
    const existing = await db.nominee.findFirst({ where: { categoryId: category!.id, name } });
    if (existing) return existing;
    return db.nominee.create({ data: { categoryId: category!.id, name, votes } });
  }
  await upsertNominee('Aisha Bello', 12);
  await upsertNominee('Tunde Okafor', 8);

  // -------------------------------------------------------------------------
  // Notifications — one per side, so both dashboards show real activity.
  // -------------------------------------------------------------------------
  async function ensureNotification(userId: string, title: string, detail: string, href: string) {
    const existing = await db.notification.findFirst({ where: { userId, title } });
    if (existing) return;
    await db.notification.create({ data: { userId, kind: 'payment_received', tone: 'brand', title, detail, href } });
  }
  await ensureNotification(
    rep.id,
    'Payment received',
    `Aisha Bello paid ₦10,300.00 for "Dinner Levy".`,
    '/dashboard/collections',
  );
  await ensureNotification(
    student.id,
    'Due reminder',
    'Your "Handout Fee" (₦5,150.00) is still unpaid.',
    '/dashboard/dues',
  );

  console.log('✅ Demo data seeded\n');
  console.log('Rep login:');
  console.log(`  email:    ${rep.email}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  space:    ${space.name} (join code: ${space.joinCode})\n`);
  console.log('Student login:');
  console.log(`  email:    ${student.email}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  wallet:   ₦12,000.00`);
  console.log(`  owes:     "Handout Fee" — ₦5,150.00`);
  console.log(`  history:  "Dinner Levy" already paid via Monnify\n`);
  console.log('Try with Duey:');
  console.log('  "pay my handout fee"');
  console.log('  "what\'s my balance"');
  console.log('  "show my payment history"');
  console.log(`  "join ${JOIN_CODE}"`);
  console.log('  "who is my rep"');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
