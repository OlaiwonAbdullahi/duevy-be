import { type KycStatus, type User } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getPaymentProvider, ProviderError, type IdentityResult } from '../providers/payment';

/**
 * Rep identity verification (KYC) through the payment provider.
 *
 * The rep submits BVN + date of birth + gender. They go straight to the
 * provider and are NEVER persisted or logged: we keep only the outcome
 * (kycStatus, bachsPayoutsActive) and the provider's references
 * (bachsAccountId, bachsPersonId). The verdict arrives asynchronously, by
 * webhook (identity.updated), which re-reads it from the provider.
 *
 * Students never do KYC.
 */

/** §9.2 — three failed attempts lock retries for 24 hours. */
const MAX_KYC_ATTEMPTS = 3;
const KYC_RETRY_LOCK_MS = 24 * 60 * 60 * 1000;

export interface KycSubmission {
  bvn: string;
  dob: string; // YYYY-MM-DD
  /** Collected as required, but the provider has no field for it — validated and dropped. */
  gender: 'male' | 'female';
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** One free-text name → first/last for the provider. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

/** Can this rep's spaces take payments? (KYC passed, provider account exists.) */
export function canCollect(user: Pick<User, 'kycStatus' | 'bachsAccountId'>): boolean {
  return user.kycStatus === 'verified' && !!user.bachsAccountId;
}

/** Can this rep withdraw? (Can collect, and the provider has enabled payouts.) */
export function canWithdraw(user: Pick<User, 'kycStatus' | 'bachsAccountId' | 'bachsPayoutsActive'>): boolean {
  return canCollect(user) && user.bachsPayoutsActive;
}

export interface KycState {
  kycStatus: KycStatus;
  payoutsActive: boolean;
  canCollect: boolean;
  canWithdraw: boolean;
  providerReference: string | null;
  rejectionReason: string | null;
  retryLockedUntil: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
}

function toState(u: User): KycState {
  return {
    kycStatus: u.kycStatus,
    payoutsActive: u.bachsPayoutsActive,
    canCollect: canCollect(u),
    canWithdraw: canWithdraw(u),
    providerReference: u.bachsPersonId,
    rejectionReason: u.kycRejectionReason,
    retryLockedUntil: u.kycRetryLockedUntil?.toISOString() ?? null,
    submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
    resolvedAt: u.kycResolvedAt?.toISOString() ?? null,
  };
}

export async function getKycState(userId: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return toState(user);
}

/** KYC state of the space's lead rep — the account its collections settle into. */
export async function getSpaceKycState(spaceId: string): Promise<KycState & { leadRepId: string | null }> {
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: true } });
  if (!lead) {
    return {
      kycStatus: 'unverified',
      payoutsActive: false,
      canCollect: false,
      canWithdraw: false,
      providerReference: null,
      rejectionReason: null,
      retryLockedUntil: null,
      submittedAt: null,
      resolvedAt: null,
      leadRepId: null,
    };
  }
  return { ...toState(lead.user), leadRepId: lead.userId };
}

function statusFrom(result: IdentityResult): KycStatus {
  return result.status === 'verified' ? 'verified' : result.status === 'rejected' ? 'rejected' : 'pending';
}

export async function submitKyc(userId: string, input: KycSubmission): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  if (!user.isRep || user.repApplicationStatus !== 'approved') {
    throw forbidden('Only an approved rep can verify their identity', 'REP_NOT_APPROVED');
  }
  if (user.kycStatus === 'verified') throw conflict('ALREADY_VERIFIED', 'Your identity is already verified');
  if (user.kycStatus === 'pending' && user.bachsPersonId) {
    throw conflict('KYC_PENDING', 'Your verification is already being reviewed');
  }
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
      { field: 'bvn', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
    ]);
  }

  const names = splitName(user.name);
  let result: IdentityResult;
  try {
    result = await getPaymentProvider().verifyIdentity({
      profile: {
        userId: user.id,
        email: user.email,
        firstName: input.firstName ?? names.firstName,
        lastName: input.lastName ?? names.lastName,
        displayName: user.name,
        phone: input.phone ?? user.phone,
      },
      bvn: input.bvn,
      dob: input.dob,
      existingAccountId: user.bachsAccountId,
      existingPersonId: user.bachsPersonId,
    });
  } catch (err) {
    // A 4xx from the provider means the details were refused; count it.
    // Anything else is the provider being unavailable — not the rep's fault.
    if (err instanceof ProviderError && err.status !== null && err.status >= 400 && err.status < 500) {
      await recordFailedAttempt(user, err.message);
      throw new AppError(422, 'KYC_REJECTED', 'The verification details were not accepted. Check them and try again.');
    }
    throw err;
  }

  const kycStatus = statusFrom(result);
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      bachsAccountId: result.accountId,
      bachsPersonId: result.personId,
      kycStatus,
      bachsPayoutsActive: result.payoutsActive,
      kycSubmittedAt: new Date(),
      kycResolvedAt: kycStatus === 'pending' ? null : new Date(),
      kycRejectionReason: kycStatus === 'rejected' ? result.failureReason ?? 'Verification failed' : null,
    },
  });
  logger.info({ userId, providerRef: result.personId, kycStatus }, 'kyc submitted');
  return toState(updated);
}

async function recordFailedAttempt(user: User, reason: string): Promise<void> {
  const attempts = user.kycAttempts + 1;
  await db.user.update({
    where: { id: user.id },
    data: {
      kycAttempts: attempts,
      kycStatus: 'rejected',
      kycRejectionReason: reason.slice(0, 300),
      kycRetryLockedUntil: attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : null,
    },
  });
}

/**
 * identity.updated — re-read the verdict from the provider and apply it.
 * Idempotent: applying the same state twice changes nothing.
 */
export async function refreshIdentity(accountId: string): Promise<'updated' | 'unchanged' | 'unknown'> {
  const user = await db.user.findUnique({ where: { bachsAccountId: accountId } });
  if (!user || !user.bachsPersonId) {
    logger.warn({ accountId }, 'identity event for an account we do not know');
    return 'unknown';
  }

  const result = await getPaymentProvider().getIdentityStatus(accountId, user.bachsPersonId);
  const kycStatus = statusFrom(result);
  if (kycStatus === user.kycStatus && result.payoutsActive === user.bachsPayoutsActive) return 'unchanged';

  const becameRejected = kycStatus === 'rejected' && user.kycStatus !== 'rejected';
  const attempts = becameRejected ? user.kycAttempts + 1 : user.kycAttempts;
  await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus,
      bachsPayoutsActive: result.payoutsActive,
      kycResolvedAt: kycStatus === 'pending' ? user.kycResolvedAt : new Date(),
      kycRejectionReason: kycStatus === 'rejected' ? result.failureReason ?? 'Verification failed' : null,
      kycAttempts: kycStatus === 'verified' ? 0 : attempts,
      kycRetryLockedUntil:
        becameRejected && attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : user.kycRetryLockedUntil,
    },
  });
  logger.info({ userId: user.id, providerRef: user.bachsPersonId, kycStatus, payoutsActive: result.payoutsActive }, 'kyc updated');

  if (kycStatus !== user.kycStatus && kycStatus !== 'pending') {
    await notify({
      userId: user.id,
      kind: 'system',
      tone: kycStatus === 'verified' ? 'brand' : 'rose',
      title: kycStatus === 'verified' ? 'Identity verified' : 'Identity verification failed',
      detail:
        kycStatus === 'verified'
          ? 'Your spaces can now collect payments.'
          : `We could not verify your identity${result.failureReason ? `: ${result.failureReason}` : ''}. Please try again.`,
      href: '/dashboard/payout',
    }).catch(() => {});
  }
  return 'updated';
}
