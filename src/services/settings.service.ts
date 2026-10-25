import { type Prisma } from '@prisma/client';
import { db } from '../config/db';

/**
 * Platform-wide values kept in platform_settings.
 *
 *  bank78_last_payout_fee_kobo — what Bank78 charged on the most recent
 *    withdrawal. Bank78 reports its transfer fee only after a transfer, so
 *    this is the best estimate of the next one: it is held back from a
 *    whole-balance withdrawal so the wallet can cover the fee too.
 */

const LAST_PAYOUT_FEE_KEY = 'bank78_last_payout_fee_kobo';

export async function getLastPayoutFee(): Promise<number | null> {
  const row = await db.platformSetting.findUnique({ where: { key: LAST_PAYOUT_FEE_KEY } });
  const v = row?.value as unknown;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export async function recordPayoutFee(feeKobo: number): Promise<void> {
  const value = feeKobo as Prisma.InputJsonValue;
  await db.platformSetting.upsert({
    where: { key: LAST_PAYOUT_FEE_KEY },
    update: { value },
    create: { key: LAST_PAYOUT_FEE_KEY, value },
  });
}
