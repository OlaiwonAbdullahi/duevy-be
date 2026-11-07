import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { type FakeProvider } from '../../providers/payment';
import { type AccountCredit } from '../../providers/payment/types';
import { getSpaceBalance } from '../../services/ledger.service';
import { reconcileDirectDeposits } from '../../services/directDeposit.service';
import { DAILY_LIMIT_KOBO, getDailyAllowanceKobo, getSpaceFunds, getUnsweptKobo } from '../../services/sweep.service';
import { drainWebhookQueue } from '../../jobs/webhookWorker';
import { FakeProvider as Fake } from '../../providers/payment/fake/FakeProvider';
import { creditEvent, installFakeProvider, makeSpace, sendWebhook, startHttp, stopHttp } from './fixtures';

let fake: FakeProvider;
beforeAll(async () => {
  fake = installFakeProvider();
  await startHttp();
});
beforeEach(() => fake.reset());
afterAll(stopHttp);

let seq = 0;
function credit(source: AccountCredit['source'], amountKobo: number): AccountCredit {
  return {
    transactionId: `dd_${Date.now()}_${++seq}`,
    amountKobo,
    at: new Date(),
    source,
    senderName: source === 'external' ? 'TUNDE BAKARE' : 'Duevy Labs Ltd',
    senderAccountNumber: source === 'external' ? '0123456789' : '3000000000',
    senderBank: 'GTBank',
    narration: 'dues',
  };
}

/** 9jaPay tells us a space account was credited. */
async function notify(space: { id: string; walletAccountNumber: string | null }, id: string) {
  await sendWebhook(creditEvent({ id, accountNumber: space.walletAccountNumber!, accountRequestReference: Fake.spaceAccountReference(space.id), amountKobo: 1 }));
  await drainWebhookQueue();
}

describe('money sent straight to a space account', () => {
  it('is credited to the space once, and only the outside money — not our sweep or a bounced payout', async () => {
    const { space } = await makeSpace();
    const deposit = credit('external', 250_000);
    fake.accountCredits.set(space.walletAccountNumber!, [credit('business', 100_000), deposit, credit('reversal', 50_000)]);

    await notify(space, `dd_evt_${space.id}_1`);
    await notify(space, `dd_evt_${space.id}_2`); // a second notification for the same money

    expect(await getSpaceBalance(space.id)).toBe(250_000);
    const entries = await db.ledgerEntry.findMany({ where: { spaceId: space.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'direct_deposit', direction: 'credit', amountKobo: 250_000, reference: deposit.transactionId });
    expect(entries[0]!.description).toMatch(/TUNDE BAKARE/);
    expect(await db.directDeposit.count({ where: { spaceId: space.id } })).toBe(1);

    // Already in the space account: nothing to sweep, and it counts toward the account's day.
    expect(await getUnsweptKobo(space.id)).toBe(0);
    expect(await getSpaceFunds(space.id, 250_000)).toMatchObject({ inSpaceAccountKobo: 250_000, awaitingSweepKobo: 0 });
    expect(await getDailyAllowanceKobo(space.id)).toBe(DAILY_LIMIT_KOBO - 250_000);
  });

  it('is picked up by reconciliation when no webhook came', async () => {
    const { space } = await makeSpace();
    fake.accountCredits.set(space.walletAccountNumber!, [credit('external', 75_000)]);
    await db.space.update({ where: { id: space.id }, data: { walletDepositsCheckedAt: null } });
    // The shared test database holds other files' spaces; only this one is due.
    await db.space.updateMany({ where: { id: { not: space.id } }, data: { walletDepositsCheckedAt: new Date() } });

    await reconcileDirectDeposits();
    expect(await getSpaceBalance(space.id)).toBe(75_000);
    expect((await db.space.findUniqueOrThrow({ where: { id: space.id } })).walletDepositsCheckedAt).not.toBeNull();

    // A space checked recently is left alone until it is due again.
    fake.accountCredits.get(space.walletAccountNumber!)!.push(credit('external', 10_000));
    await reconcileDirectDeposits();
    expect(await getSpaceBalance(space.id)).toBe(75_000);
  });
});
