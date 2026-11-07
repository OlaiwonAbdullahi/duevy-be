import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { env } from '../../config/env';
import { type FakeProvider } from '../../providers/payment';
import { createCheckout } from '../../services/checkout.service';
import { getSpaceBalance } from '../../services/ledger.service';
import { api, installFakeProvider, makeSpace, startHttp, stopHttp } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

describe('POST /v1/dev/simulate-deposit', () => {
  it("pays the checkout holding the account, straight away, when the amount is the checkout's total", async () => {
    const { space, students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    const accountNumber = checkout.bankTransfer!.accountNumber!;

    const res = await api('POST', '/v1/dev/simulate-deposit', { body: { accountNumber, amount: checkout.amount } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accountNumber, amount: checkout.amount, checkout: { reference: checkout.reference, status: 'paid' } });
    expect(await getSpaceBalance(space.id)).toBe(checkout.breakdown.face);
  });

  it('refuses an amount the one-time account would reject, without depositing', async () => {
    const { students, dues } = await makeSpace();
    const { checkout } = await createCheckout(students[0]!.id, [dues[0]!.id]);
    const res = await api('POST', '/v1/dev/simulate-deposit', { body: { accountNumber: checkout.bankTransfer!.accountNumber, amount: checkout.amount - 1 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(fake.calls.some((c) => c.op === 'simulateDeposit')).toBe(false);
    expect((await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } })).status).toBe('pending');
  });

  it('deposits into an account no checkout holds (e.g. a space account) and says so', async () => {
    const res = await api('POST', '/v1/dev/simulate-deposit', { body: { accountNumber: '9000000001', amount: 50_000 } });
    expect(res.status).toBe(200);
    expect(res.body.data.checkout).toBeNull();
  });

  it('validates the input', async () => {
    const res = await api('POST', '/v1/dev/simulate-deposit', { body: { accountNumber: '123', amount: 12.5 } });
    expect(res.status).toBe(400);
  });

  it('does not exist in production', async () => {
    const original = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      const res = await api('POST', '/v1/dev/simulate-deposit', { body: { accountNumber: '9000000001', amount: 50_000 } });
      expect(res.status).toBe(404);
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = original;
    }
  });
});
