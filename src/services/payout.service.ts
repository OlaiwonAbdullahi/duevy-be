import { type Payout, type BankAccount } from '@prisma/client';
import { db } from '../config/db';
import { decrypt } from '../lib/encryption';
import {
  initiateDisbursement,
  getDisbursementStatus,
  isDisbursementConfigured,
  getActiveGatewayName,
  getBanks,
  verifyAccountName,
} from '../lib/paymentGateway';
import { notifyMany } from '../lib/notifications';

const STALE_PAYOUT_AFTER_MS = 15 * 60 * 1000;

/** Strips generic suffixes ("Bank", "MFB", "Plc", ...) so the same institution matches across providers' differently-formatted names. */
function normalizeBankName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(bank|mfb|microfinance|plc|limited|ltd)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Bank codes are gateway-specific — Monnify and Paystack number the same
 * bank differently (e.g. Kuda is `090267` on one and `50211` on the other).
 * `BankAccount.bankCodeGateway` records which scheme `bankCode` currently
 * matches; if the active gateway has since changed, re-resolve the code by
 * matching `bankName` against the active gateway's own bank list, re-verify
 * the account still checks out (never trust a name-match alone with real
 * money), and persist the correction so this is a one-time cost per switch.
 */
export async function resolveActiveBankCode(account: BankAccount): Promise<string> {
  const activeGateway = await getActiveGatewayName();
  if (account.bankCodeGateway === activeGateway) return account.bankCode;

  const banks = await getBanks();
  const target = normalizeBankName(account.bankName);
  const match =
    banks.find((b) => normalizeBankName(b.name) === target) ??
    banks.find((b) => normalizeBankName(b.name).includes(target) || target.includes(normalizeBankName(b.name)));
  if (!match) {
    throw new Error(`[bank-code] no match for "${account.bankName}" in the ${activeGateway} bank list — resolve manually`);
  }

  const accountNumber = decrypt(account.accountNumber);
  const resolvedName = await verifyAccountName(accountNumber, match.code);
  if (!resolvedName) {
    throw new Error(`[bank-code] "${account.bankName}" (${match.code}) didn't verify under ${activeGateway} — resolve manually`);
  }

  await db.bankAccount.update({
    where: { spaceId: account.spaceId },
    data: { bankCode: match.code, bankCodeGateway: activeGateway, accountName: resolvedName },
  });
  console.log(`[bank-code] re-resolved "${account.bankName}" for space ${account.spaceId}: ${account.bankCode} -> ${match.code} (${activeGateway})`);

  return match.code;
}

/**
 * Kick off the actual bank transfer for a freshly-created payout (§10.3).
 * Best-effort: if disbursement isn't configured or the provider call fails,
 * the payout simply stays `processing` for the reconciliation job to retry.
 */
export async function initiatePayoutDisbursement(payout: Payout): Promise<void> {
  if (!(await isDisbursementConfigured())) return;

  const account = await db.bankAccount.findUnique({ where: { spaceId: payout.spaceId } });
  if (!account) return;

  try {
    const bankCode = await resolveActiveBankCode(account);
    const result = await initiateDisbursement({
      amount: payout.amount,
      reference: payout.reference,
      narration: `Duevy payout ${payout.reference}`,
      bankCode,
      accountNumber: decrypt(account.accountNumber),
      accountName: account.accountName,
    });
    if (result.status === 'SUCCESS') {
      await settlePayout(payout.reference, true);
    } else if (result.status === 'FAILED') {
      await settlePayout(payout.reference, false, 'Disbursement was rejected by the payment provider');
    }
    // PENDING — leave `processing`; the webhook or reconciliation job resolves it.
  } catch (err) {
    console.error(`[payout] disbursement init failed for ${payout.reference}:`, err);
  }
}

/** Resolve a `processing` payout to `completed`/`failed`. Idempotent. */
export async function settlePayout(reference: string, success: boolean, failureReason?: string): Promise<void> {
  const payout = await db.payout.findUnique({ where: { reference } });
  if (!payout || payout.status !== 'processing') return;

  const updated = await db.payout.update({
    where: { reference },
    data: success
      ? { status: 'completed', settledAt: new Date() }
      : { status: 'failed', failureReason: failureReason ?? 'The payout could not be completed' },
  });

  const reps = await db.spaceRep.findMany({ where: { spaceId: updated.spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    success
      ? {
          kind: 'payout_completed',
          title: 'Payout completed',
          detail: `₦${(updated.amount / 100).toLocaleString('en-NG')} was sent to ${updated.accountMasked}.`,
          href: '/dashboard/payout',
        }
      : {
          kind: 'system',
          tone: 'rose',
          title: 'Payout failed',
          detail: `Your ₦${(updated.amount / 100).toLocaleString('en-NG')} payout could not be completed.`,
          href: '/dashboard/payout',
        },
  );
}

/** Poll the provider for payouts that have sat in `processing` too long (reconciliation job). */
export async function reconcileStalePayouts(): Promise<void> {
  if (!(await isDisbursementConfigured())) return;

  const staleThreshold = new Date(Date.now() - STALE_PAYOUT_AFTER_MS);
  const stale = await db.payout.findMany({
    where: { status: 'processing', requestedAt: { lte: staleThreshold } },
    take: 50,
  });

  for (const payout of stale) {
    try {
      const status = await getDisbursementStatus(payout.reference);
      if (!status) continue;
      if (status.status === 'SUCCESS') await settlePayout(payout.reference, true);
      else if (status.status === 'FAILED') await settlePayout(payout.reference, false);
    } catch (err) {
      console.error(`[payout] reconciliation failed for ${payout.reference}:`, err);
    }
  }
}
