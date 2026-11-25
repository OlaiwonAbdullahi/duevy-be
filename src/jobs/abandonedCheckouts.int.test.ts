import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../config/db';
import { makeSpace } from '../test/integration/fixtures';
import { sendAbandonedCheckoutEmail } from '../lib/email';
import { sendAbandonedCheckoutRemindersOnce } from './abandonedCheckouts';

vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendEmail: vi.fn(async () => {}),
  sendAbandonedCheckoutEmail: vi.fn(async () => {}),
}));

const remindEmail = vi.mocked(sendAbandonedCheckoutEmail);

const MIN = 60 * 1000;

type CheckoutOpts = {
  spaceId: string;
  dueId: string;
  isGuest?: boolean;
  status?: 'pending' | 'paid';
  ageMin: number;
  expiresInMin: number;
  reminded?: boolean;
};

/** A checkout (with one item) built at a chosen age and expiry, for the sweep to find — or skip. */
async function makeCheckout(o: CheckoutOpts) {
  const now = Date.now();
  const user = await db.user.create({
    data: { name: 'Tolu Guest', email: `pay_${randomUUID()}@test.duevy`, isGuest: o.isGuest ?? true },
  });
  const checkout = await db.checkout.create({
    data: {
      reference: `ref_${randomUUID()}`,
      userId: user.id,
      spaceId: o.spaceId,
      status: o.status ?? 'pending',
      faceKobo: 500_000,
      feeKobo: 7_500,
      totalKobo: 507_500,
      dueSetKey: o.dueId,
      expiresAt: new Date(now + o.expiresInMin * MIN),
      createdAt: new Date(now - o.ageMin * MIN),
      paidAt: o.status === 'paid' ? new Date() : null,
      abandonedReminderSentAt: o.reminded ? new Date() : null,
      items: { create: { dueId: o.dueId, faceKobo: 500_000, feeKobo: 7_500 } },
    },
  });
  return { user, checkout };
}

describe('abandoned checkout reminders', () => {
  beforeEach(() => {
    remindEmail.mockReset().mockResolvedValue(undefined);
  });

  it('emails a guest who opened a checkout and left, once, and marks it', async () => {
    const { space, dues } = await makeSpace();
    const dueId = dues[0]!.id;
    const { user, checkout } = await makeCheckout({ spaceId: space.id, dueId, ageMin: 40, expiresInMin: 20 });

    const sent = await sendAbandonedCheckoutRemindersOnce();
    expect(sent).toBe(1);
    expect(remindEmail).toHaveBeenCalledTimes(1);

    const [to, name, payload] = remindEmail.mock.calls[0]!;
    expect(to).toBe(user.email);
    expect(name).toBe('Tolu Guest');
    expect(payload).toMatchObject({ dueTitle: dues[0]!.title, spaceName: space.name, amountKobo: 507_500 });
    expect(payload.resumeUrl).toContain(`/pay/${dueId}`);
    expect(payload.resumeUrl).toContain(`ref=${checkout.reference}`);
    expect(payload.resumeUrl).toContain('&t=');

    const after = await db.checkout.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(after.abandonedReminderSentAt).not.toBeNull();

    // A second sweep doesn't email the same checkout again.
    await sendAbandonedCheckoutRemindersOnce();
    expect(remindEmail).toHaveBeenCalledTimes(1);
  });

  it('skips the recent, the expired, the already-paid, the already-reminded, and signed-in members', async () => {
    const { space, dues } = await makeSpace();
    const dueId = dues[0]!.id;

    await makeCheckout({ spaceId: space.id, dueId, ageMin: 10, expiresInMin: 50 }); // too recent
    await makeCheckout({ spaceId: space.id, dueId, ageMin: 90, expiresInMin: -5 }); // window closed
    await makeCheckout({ spaceId: space.id, dueId, ageMin: 40, expiresInMin: 20, status: 'paid' });
    await makeCheckout({ spaceId: space.id, dueId, ageMin: 40, expiresInMin: 20, reminded: true });
    await makeCheckout({ spaceId: space.id, dueId, ageMin: 40, expiresInMin: 20, isGuest: false }); // member

    const sent = await sendAbandonedCheckoutRemindersOnce();
    expect(sent).toBe(0);
    expect(remindEmail).not.toHaveBeenCalled();
  });

  it('releases the claim when the email fails, so the next run retries it', async () => {
    const { space, dues } = await makeSpace();
    const dueId = dues[0]!.id;
    const { checkout } = await makeCheckout({ spaceId: space.id, dueId, ageMin: 40, expiresInMin: 20 });

    remindEmail.mockRejectedValueOnce(new Error('resend down'));
    const sent = await sendAbandonedCheckoutRemindersOnce();
    expect(sent).toBe(0);

    const after = await db.checkout.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(after.abandonedReminderSentAt).toBeNull();

    // The next run (email healthy again) sends it.
    const retried = await sendAbandonedCheckoutRemindersOnce();
    expect(retried).toBe(1);
  });
});
