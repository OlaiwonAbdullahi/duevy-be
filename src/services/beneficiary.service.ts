import type { Prisma, PayoutBeneficiary } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, notFound } from '../lib/errors';
import { encrypt, decrypt, maskAccountNumber } from '../lib/encryption';
import { logger } from '../lib/logger';
import { writeAudit } from '../lib/audit';
import { sendEmail, renderEmail } from '../lib/email';
import { getPaymentProvider } from '../providers/payment';
import { listBanksCached } from '../routes/banks';
import { escapeHtml } from '../lib/html';
import { lockSpace } from './ledger.service';

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
    throw new AppError(400, 'VALIDATION_ERROR', 'Unknown bank', [{ field: 'bankCode', issue: 'unknown bank code' }]);
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
  actor: { id: string; name: string; walletAccountNumber: string };
  bankCode: string;
  accountNumber: string;
  label?: string;
}): Promise<{ beneficiary: PayoutBeneficiary; created: boolean }> {
  const { spaceId, actor, bankCode, accountNumber } = input;
  const label = input.label?.trim() || null;

  // The same account added twice is the same beneficiary; just refresh its label.
  // Checked here first so a duplicate or a full list never reaches the
  // provider, then again under the space lock below (concurrent adds).
  const precheck = await findDuplicateOrAssertRoom(db, spaceId, bankCode, accountNumber);
  if (precheck) return { beneficiary: await refreshLabel(precheck, label), created: false };

  const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
  const destination = await getPaymentProvider().registerPayoutDestination({
    accountId: actor.walletAccountNumber,
    bankCode,
    bankName,
    accountNumber,
    accountName,
  });

  const masked = maskAccountNumber(accountNumber);
  const result = await db.$transaction(async (tx) => {
    await lockSpace(tx, spaceId);
    const duplicate = await findDuplicateOrAssertRoom(tx, spaceId, bankCode, accountNumber);
    if (duplicate) return { beneficiary: duplicate, created: false };
    const created = await tx.payoutBeneficiary.create({
      data: {
        spaceId,
        label,
        bankCode,
        bankName,
        accountNumber: encrypt(accountNumber),
        accountNumberMasked: masked,
        accountName,
        destinationId: destination.destinationId,
        walletAccountNumber: actor.walletAccountNumber,
        createdById: actor.id,
      },
    });
    return { beneficiary: created, created: true };
  });
  // A concurrent request added the same account first.
  if (!result.created) return { beneficiary: await refreshLabel(result.beneficiary, label), created: false };
  const beneficiary = result.beneficiary;
  logger.info({ spaceId, beneficiaryId: beneficiary.id, bank: bankCode, account: masked, usable: destination.usable }, 'beneficiary added');

  const who = `${accountName} (${bankName} ${masked})`;
  await writeAudit(spaceId, { id: actor.id, name: actor.name, role: 'lead' }, 'beneficiary_added', `Added beneficiary ${who}`).catch(() => {});
  void notifyRepsOfNewBeneficiary(spaceId, actor.name, who);
  return { beneficiary, created: true };
}

/** The space's existing beneficiary for this account, or throws if the space is at its limit. */
async function findDuplicateOrAssertRoom(
  client: Prisma.TransactionClient,
  spaceId: string,
  bankCode: string,
  accountNumber: string,
): Promise<PayoutBeneficiary | null> {
  const existing = await client.payoutBeneficiary.findMany({ where: { spaceId }, orderBy: { createdAt: 'desc' } });
  const duplicate = existing.find((b) => b.bankCode === bankCode && decrypt(b.accountNumber) === accountNumber);
  if (duplicate) return duplicate;
  if (existing.length >= MAX_BENEFICIARIES) {
    throw conflict('TOO_MANY_BENEFICIARIES', `A space can have at most ${MAX_BENEFICIARIES} beneficiaries. Remove one first.`);
  }
  return null;
}

function refreshLabel(b: PayoutBeneficiary, label: string | null): Promise<PayoutBeneficiary> | PayoutBeneficiary {
  return label && label !== b.label ? db.payoutBeneficiary.update({ where: { id: b.id }, data: { label } }) : b;
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
 * current lead rep's wallet). It is registered against one wallet, so after a
 * lead change it is registered again for the new one.
 */
export async function destinationFor(b: PayoutBeneficiary, accountId: string): Promise<string> {
  if (b.destinationId && b.walletAccountNumber === accountId) return b.destinationId;
  const destination = await getPaymentProvider().registerPayoutDestination({
    accountId,
    bankCode: b.bankCode,
    bankName: b.bankName,
    accountNumber: decrypt(b.accountNumber),
    accountName: b.accountName,
  });
  await db.payoutBeneficiary.update({
    where: { id: b.id },
    data: { destinationId: destination.destinationId, walletAccountNumber: accountId },
  });
  return destination.destinationId;
}

/** A one-off withdrawal target: name-checked and registered with the provider, but not saved. */
export async function oneOffDestination(accountId: string, bankCode: string, accountNumber: string) {
  const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
  const destination = await getPaymentProvider().registerPayoutDestination({ accountId, bankCode, bankName, accountNumber, accountName });
  return { bankName, accountName, accountNumberMasked: maskAccountNumber(accountNumber), destinationId: destination.destinationId };
}

async function notifyRepsOfNewBeneficiary(spaceId: string, actorName: string, who: string): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId }, include: { user: { select: { email: true, name: true } } } });
  for (const r of reps) {
    sendEmail({
      to: r.user.email,
      subject: 'New Duevy payout beneficiary',
      html: renderEmail(
        `<h1>New payout beneficiary</h1>
         <p>Hi ${escapeHtml(r.user.name)}, ${escapeHtml(actorName)} added <strong>${escapeHtml(who)}</strong> as a beneficiary for your space. Withdrawals can now be sent to this account.</p>
         <p class="muted">If this wasn't expected, contact support immediately at support@duevy.app</p>`,
        '#b01e4e',
      ),
    }).catch(() => {});
  }
}
