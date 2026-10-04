import type { PayoutBeneficiary } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, notFound } from '../lib/errors';
import { encrypt, decrypt, maskAccountNumber } from '../lib/encryption';
import { logger } from '../lib/logger';
import { writeAudit } from '../lib/audit';
import { sendEmail, renderEmail } from '../lib/email';
import { getPaymentProvider } from '../providers/payment';
import { listBanksCached } from '../routes/banks';

/**
 * Beneficiaries: the bank accounts a space can withdraw to. Any account the
 * lead rep adds — their own, a lecturer's, a vendor's. Name enquiry is
 * mandatory, so the stored name is always the bank's. Every rep is emailed
 * when one is added, since a new beneficiary is where money can now go.
 */

export const MAX_BENEFICIARIES = 25;

export interface ResolvedBankDetails {
  bankName: string;
  accountName: string;
}

/** Name enquiry. Throws 422 for an unknown bank or an account the bank can't find. */
export async function resolveBankDetails(bankCode: string, accountNumber: string): Promise<ResolvedBankDetails> {
  const banks = await listBanksCached();
  const bankName = banks.find((b) => b.code === bankCode)?.name;
  if (!bankName) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Unknown bank', [{ field: 'bankCode', issue: 'unknown bank code' }]);
  }
  const resolved = await getPaymentProvider().resolveAccount(bankCode, accountNumber);
  if (!resolved) throw new AppError(422, 'ACCOUNT_UNVERIFIABLE', 'Could not verify this account number with the selected bank');
  return { bankName, accountName: resolved.accountName };
}

export function listBeneficiaries(spaceId: string): Promise<PayoutBeneficiary[]> {
  return db.payoutBeneficiary.findMany({ where: { spaceId }, orderBy: { createdAt: 'desc' } });
}

export async function addBeneficiary(input: {
  spaceId: string;
  actor: { id: string; name: string; bachsAccountId: string };
  bankCode: string;
  accountNumber: string;
  label?: string;
}): Promise<{ beneficiary: PayoutBeneficiary; created: boolean }> {
  const { spaceId, actor, bankCode, accountNumber } = input;
  const label = input.label?.trim() || null;

  // The same account added twice is the same beneficiary; just refresh its label.
  const existing = await listBeneficiaries(spaceId);
  const duplicate = existing.find((b) => b.bankCode === bankCode && decrypt(b.accountNumber) === accountNumber);
  if (duplicate) {
    const beneficiary =
      label && label !== duplicate.label
        ? await db.payoutBeneficiary.update({ where: { id: duplicate.id }, data: { label } })
        : duplicate;
    return { beneficiary, created: false };
  }
  if (existing.length >= MAX_BENEFICIARIES) {
    throw conflict('TOO_MANY_BENEFICIARIES', `A space can have at most ${MAX_BENEFICIARIES} beneficiaries. Remove one first.`);
  }

  const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
  const destination = await getPaymentProvider().registerPayoutDestination({
    accountId: actor.bachsAccountId,
    bankCode,
    accountNumber,
    accountName,
  });

  const masked = maskAccountNumber(accountNumber);
  const beneficiary = await db.payoutBeneficiary.create({
    data: {
      spaceId,
      label,
      bankCode,
      bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName,
      bachsDestinationId: destination.destinationId,
      bachsAccountId: actor.bachsAccountId,
      createdById: actor.id,
    },
  });
  logger.info({ spaceId, beneficiaryId: beneficiary.id, bank: bankCode, account: masked, usable: destination.usable }, 'beneficiary added');

  const who = `${accountName} (${bankName} ${masked})`;
  await writeAudit(spaceId, { id: actor.id, name: actor.name, role: 'lead' }, 'beneficiary_added', `Added beneficiary ${who}`).catch(() => {});
  void notifyRepsOfNewBeneficiary(spaceId, actor.name, who);
  return { beneficiary, created: true };
}

export async function removeBeneficiary(spaceId: string, beneficiaryId: string, actor: { id: string; name: string }): Promise<void> {
  const b = await db.payoutBeneficiary.findFirst({ where: { id: beneficiaryId, spaceId } });
  if (!b) throw notFound('Beneficiary not found');
  // Withdrawals keep their own copy of the destination, so one in flight is unaffected.
  await db.payoutBeneficiary.delete({ where: { id: b.id } });
  await writeAudit(
    spaceId,
    { id: actor.id, name: actor.name, role: 'lead' },
    'beneficiary_removed',
    `Removed beneficiary ${b.accountName} (${b.bankName} ${b.accountNumberMasked})`,
  ).catch(() => {});
}

/**
 * The provider destination for paying this beneficiary out of `accountId` (the
 * current lead rep's Bachs account). A destination belongs to one Bachs
 * account, so after a lead change it is registered again on the new one.
 */
export async function destinationFor(b: PayoutBeneficiary, accountId: string): Promise<string> {
  if (b.bachsDestinationId && b.bachsAccountId === accountId) return b.bachsDestinationId;
  const destination = await getPaymentProvider().registerPayoutDestination({
    accountId,
    bankCode: b.bankCode,
    accountNumber: decrypt(b.accountNumber),
    accountName: b.accountName,
  });
  await db.payoutBeneficiary.update({
    where: { id: b.id },
    data: { bachsDestinationId: destination.destinationId, bachsAccountId: accountId },
  });
  return destination.destinationId;
}

async function notifyRepsOfNewBeneficiary(spaceId: string, actorName: string, who: string): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId }, include: { user: { select: { email: true, name: true } } } });
  for (const r of reps) {
    sendEmail({
      to: r.user.email,
      subject: 'New Duevy payout beneficiary',
      html: renderEmail(
        `<h1>New payout beneficiary</h1>
         <p>Hi ${r.user.name}, ${actorName} added <strong>${who}</strong> as a beneficiary for your space. Withdrawals can now be sent to this account.</p>
         <p class="muted">If this wasn't expected, contact support immediately at support@duevy.app</p>`,
        '#b01e4e',
      ),
    }).catch(() => {});
  }
}
