import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../config/db';

const sent: { to: string; stage: number }[] = [];
vi.mock('../../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/email')>()),
  sendKycReminderEmail: vi.fn(async (to: string, _name: string, stage: number) => {
    sent.push({ to, stage });
  }),
}));

const { sendKycRemindersOnce } = await import('../../jobs/kycReminders');

const HOUR = 60 * 60 * 1000;
let seq = 0;

/** A rep applicant who signed up `hoursAgo` hours ago. */
async function applicant(hoursAgo: number, data: Record<string, unknown> = {}) {
  return db.user.create({
    data: {
      name: 'Tobi Ade',
      email: `applicant_${Date.now()}_${++seq}@test.duevy`,
      emailVerified: true,
      repApplicationStatus: 'pending',
      createdAt: new Date(Date.now() - hoursAgo * HOUR),
      ...data,
    },
  });
}

describe('KYC reminder emails', () => {
  beforeEach(async () => {
    sent.length = 0;
    // Earlier test files leave users behind; only this file's applicants matter.
    await db.user.updateMany({ where: { repApplicationStatus: 'pending' }, data: { kycReminderStage: 3 } });
  });

  it('sends at 24h, 3 days and 7 days — once each', async () => {
    const u = await applicant(25);
    await sendKycRemindersOnce();
    await sendKycRemindersOnce(); // same window: nothing new
    expect(sent).toEqual([{ to: u.email, stage: 1 }]);

    await sendKycRemindersOnce(new Date(Date.now() + 2 * 24 * HOUR)); // ~3 days in
    await sendKycRemindersOnce(new Date(Date.now() + 6 * 24 * HOUR)); // ~7 days in
    expect(sent.map((s) => s.stage)).toEqual([1, 2, 3]);
    await sendKycRemindersOnce(new Date(Date.now() + 30 * 24 * HOUR));
    expect(sent).toHaveLength(3);
  });

  it('sends only the latest due reminder to someone found late', async () => {
    await applicant(10 * 24);
    await sendKycRemindersOnce();
    expect(sent.map((s) => s.stage)).toEqual([3]);
  });

  it('skips the too-new, the finished, the unverified and the suspended', async () => {
    await applicant(2); // too new
    await applicant(48, {
      phoneVerifiedAt: new Date(),
      kycSubmittedAt: new Date(),
      kycStatus: 'pending',
      studentIdStatus: 'pending',
      payoutDestinationSubmittedAt: new Date(),
    }); // everything submitted, awaiting review
    await applicant(48, { emailVerified: false });
    await applicant(48, { isSuspended: true });
    await applicant(48, { repApplicationStatus: 'none' }); // a student
    await sendKycRemindersOnce();
    expect(sent).toEqual([]);
  });

  it('reminds an applicant whose student ID was rejected', async () => {
    await applicant(30, {
      kycSubmittedAt: new Date(),
      kycStatus: 'verified',
      studentIdStatus: 'rejected',
      payoutDestinationSubmittedAt: new Date(),
    });
    await sendKycRemindersOnce();
    expect(sent.map((s) => s.stage)).toEqual([1]);
  });
});
