import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { getSpaceBalance } from '../../services/ledger.service';
import { requestRefund, refreshRefund } from '../../services/refund.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { type FakeProvider } from '../../providers/payment';
import { api, installFakeProvider, makeSpace, payCheckout, startHttp, stopHttp, tokenFor, TEST_PIN } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
afterAll(stopHttp);

let seq = 0;
const guestEmail = () => `refund_${Date.now()}_${seq++}@test.duevy`;

/** A guest pays a guest-enabled due of a fresh space, from a known account. */
async function paidGuestDue(sender?: { accountNumber: string; bankCode: string; bank?: string }) {
  const { rep, space, dues } = await makeSpace();
  const due = await db.due.update({ where: { id: dues[0]!.id }, data: { allowGuests: true } });
  const opened = await api('POST', `/v1/public/dues/${due.id}/checkout`, {
    body: { name: 'Ada Obi', matricNo: 'CSC/21/001', email: guestEmail() },
  });
  const { reference, amount } = opened.body.data;
  await payCheckout(fake, reference, {
    receivedKobo: amount,
    sender: sender ? { name: 'Ada Obi', bank: sender.bank ?? 'GTBank', ...sender } : undefined,
  });
  await drainWebhookQueue();
  const payment = await db.duePayment.findFirstOrThrow({ where: { dueId: due.id } });
  return { rep, space, due, payment };
}

describe('refunds', () => {
  it('refunds a payer back to their source account, debiting the space (lead + code)', async () => {
    const { rep, space, due, payment } = await paidGuestDue({ accountNumber: '0123456789', bankCode: '058' });
    const before = await getSpaceBalance(space.id);

    const res = await api('POST', `/v1/spaces/${space.id}/dues/${due.id}/payments/${payment.id}/refund`, {
      token: await tokenFor(rep),
      body: { amountKobo: 200_000, pin: TEST_PIN },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'processing', amountKobo: 200_000 });

    // The money left the balance, and went to the payer's own account.
    expect(await getSpaceBalance(space.id)).toBe(before - 200_000);
    expect(fake.calls.find((c) => c.op === 'initiateTransfer')?.args).toMatchObject({
      from: 'business',
      bankCode: '058',
      accountNumber: '0123456789',
      amountKobo: 200_000,
    });

    // The transfer settles; the refund completes.
    fake.settleTransfer(res.body.data.reference, 'succeeded');
    const refund = await db.refund.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    await refreshRefund(refund.id);
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('success');
    // Still debited after success.
    expect(await getSpaceBalance(space.id)).toBe(before - 200_000);
  });

  it('allows partial refunds but never more than what is left', async () => {
    const { space, due, payment } = await paidGuestDue({ accountNumber: '0123456789', bankCode: '058' });
    const lead = await db.spaceRep.findFirstOrThrow({ where: { spaceId: space.id, role: 'lead' } });

    await requestRefund({ spaceId: space.id, dueId: due.id, duePaymentId: payment.id, requestedById: lead.userId, amountKobo: 300_000, pin: TEST_PIN });
    // Only (amountPaid − 300,000) remains.
    const remaining = payment.amountPaid - 300_000;
    await expect(
      requestRefund({ spaceId: space.id, dueId: due.id, duePaymentId: payment.id, requestedById: lead.userId, amountKobo: remaining + 1, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'REFUND_TOO_LARGE' });
  });

  it('restores the balance when the transfer fails', async () => {
    const { space, due, payment } = await paidGuestDue({ accountNumber: '0123456789', bankCode: '058' });
    const lead = await db.spaceRep.findFirstOrThrow({ where: { spaceId: space.id, role: 'lead' } });
    const before = await getSpaceBalance(space.id);

    const refund = await requestRefund({ spaceId: space.id, dueId: due.id, duePaymentId: payment.id, requestedById: lead.userId, amountKobo: 150_000, pin: TEST_PIN });
    expect(await getSpaceBalance(space.id)).toBe(before - 150_000);

    fake.settleTransfer(refund.reference, 'failed');
    await refreshRefund(refund.id);
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('failed');
    // Balance restored in full.
    expect(await getSpaceBalance(space.id)).toBe(before);
  });

  it('rejects a wrong withdrawal code and never moves money', async () => {
    const { rep, space, due, payment } = await paidGuestDue({ accountNumber: '0123456789', bankCode: '058' });
    const before = await getSpaceBalance(space.id);
    const res = await api('POST', `/v1/spaces/${space.id}/dues/${due.id}/payments/${payment.id}/refund`, {
      token: await tokenFor(rep),
      body: { amountKobo: 100_000, pin: '0000' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_WITHDRAWAL_PIN');
    expect(await getSpaceBalance(space.id)).toBe(before);
  });

  it("won't refund a payment with no recorded source account", async () => {
    const { space, due, payment } = await paidGuestDue(); // no sender captured
    const lead = await db.spaceRep.findFirstOrThrow({ where: { spaceId: space.id, role: 'lead' } });
    await expect(
      requestRefund({ spaceId: space.id, dueId: due.id, duePaymentId: payment.id, requestedById: lead.userId, amountKobo: 100_000, pin: TEST_PIN }),
    ).rejects.toMatchObject({ code: 'NO_SOURCE_ACCOUNT' });
  });

  it('is co-rep forbidden — only the lead can refund', async () => {
    const { space, due, payment } = await paidGuestDue({ accountNumber: '0123456789', bankCode: '058' });
    // A co-rep of the space.
    const co = await db.user.create({ data: { name: 'Co Rep', email: guestEmail() } });
    await db.spaceRep.create({ data: { userId: co.id, spaceId: space.id, role: 'co' } });
    const res = await api('POST', `/v1/spaces/${space.id}/dues/${due.id}/payments/${payment.id}/refund`, {
      token: await tokenFor(co),
      body: { amountKobo: 100_000, pin: TEST_PIN },
    });
    expect(res.status).toBe(403);
  });
});
