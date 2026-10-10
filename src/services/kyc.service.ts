import { type DocumentReviewStatus, type KycStatus, type User } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getFileStore } from '../lib/storage';
import { maskAccountNumber } from '../lib/encryption';
import { resolveBankDetails } from './beneficiary.service';
import { getPaymentProvider, ProviderError, type IdentityNumber, type IdentityResult } from '../providers/payment';

/**
 * Rep identity verification (KYC). Two independent checks, both required
 * before a rep's spaces can collect:
 *
 *  1. Bachs verifies the rep's identity: NIN + date of birth (a BVN only if
 *     Bachs later asks for one). The verdict arrives by webhook
 *     (identity.updated), which re-reads it from Bachs.
 *  2. Duevy verifies the rep is a student: the rep uploads their student ID
 *     card, stored privately in ImageKit, and an admin approves it.
 *
 * The NIN, BVN and date of birth go straight to Bachs and are NEVER persisted
 * or logged. For the student ID we keep only the storage reference.
 *
 * Students never do KYC; rep applicants do it as part of their application.
 */

/** §9.2 — three failed attempts lock retries for 24 hours. */
const MAX_KYC_ATTEMPTS = 3;
const KYC_RETRY_LOCK_MS = 24 * 60 * 60 * 1000;
/** How long an admin's link to a student ID image stays valid. */
const REVIEW_URL_TTL_SECONDS = 10 * 60;

export interface UploadedDocument {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

export interface KycSubmission {
  nin: string;
  /** Optional: only when Bachs asks for one (it is not required to start). */
  bvn?: string;
  dob: string; // YYYY-MM-DD
  /** Bachs has no field for it; kept on the user for admins. */
  gender: 'male' | 'female';
  firstName?: string;
  lastName?: string;
  phone?: string;
  studentId: UploadedDocument;
  /** Optional: a government ID document, when Bachs asks for one. */
  governmentId?: UploadedDocument;
}

/** One free-text name → first/last for the provider. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

type KycFields = Pick<User, 'kycStatus' | 'bachsAccountId' | 'studentIdStatus'>;

/** Can this rep's spaces take payments? Bachs passed the rep AND an admin approved the student ID. */
export function canCollect(user: KycFields): boolean {
  return user.kycStatus === 'verified' && !!user.bachsAccountId && user.studentIdStatus === 'approved';
}

/** Can this rep withdraw? (Can collect, and Bachs has enabled payouts.) */
export function canWithdraw(user: KycFields & Pick<User, 'bachsPayoutsActive'>): boolean {
  return canCollect(user) && user.bachsPayoutsActive;
}

export interface KycState {
  kycStatus: KycStatus;
  payoutsActive: boolean;
  canCollect: boolean;
  canWithdraw: boolean;
  providerReference: string | null;
  /** Field keys Bachs still asks for, e.g. a BVN or an ID document. */
  requirementsDue: string[];
  governmentIdSubmittedAt: string | null;
  /** The rep's own bank account on their Bachs account; `null` until sent. */
  payoutDestination: {
    bankCode: string;
    bankName: string;
    /** Masked, e.g. "•••• 6789". */
    accountNumber: string;
    accountName: string;
    submittedAt: string;
  } | null;
  studentId: {
    status: DocumentReviewStatus | null;
    uploadedAt: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
  };
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
    requirementsDue: u.kycRequirementsDue,
    governmentIdSubmittedAt: u.governmentIdSubmittedAt?.toISOString() ?? null,
    payoutDestination:
      u.payoutDestinationSubmittedAt && u.payoutDestinationBankCode
        ? {
            bankCode: u.payoutDestinationBankCode,
            bankName: u.payoutDestinationBankName ?? '',
            accountNumber: u.payoutDestinationAccountMasked ?? '',
            accountName: u.payoutDestinationAccountName ?? '',
            submittedAt: u.payoutDestinationSubmittedAt.toISOString(),
          }
        : null,
    studentId: {
      status: u.studentIdStatus,
      uploadedAt: u.studentIdUploadedAt?.toISOString() ?? null,
      reviewedAt: u.studentIdReviewedAt?.toISOString() ?? null,
      reviewNote: u.studentIdReviewNote,
    },
    rejectionReason: u.kycRejectionReason,
    retryLockedUntil: u.kycRetryLockedUntil?.toISOString() ?? null,
    submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
    resolvedAt: u.kycResolvedAt?.toISOString() ?? null,
  };
}

const EMPTY_STATE: KycState = {
  kycStatus: 'unverified',
  payoutsActive: false,
  canCollect: false,
  canWithdraw: false,
  providerReference: null,
  requirementsDue: [],
  governmentIdSubmittedAt: null,
  payoutDestination: null,
  studentId: { status: null, uploadedAt: null, reviewedAt: null, reviewNote: null },
  rejectionReason: null,
  retryLockedUntil: null,
  submittedAt: null,
  resolvedAt: null,
};

/**
 * KYC is part of the rep application: applicants verify before an admin gives
 * final approval, so a pending application is enough to submit.
 */
function isRepOrApplicant(user: Pick<User, 'isRep' | 'repApplicationStatus'>): boolean {
  return user.isRep || user.repApplicationStatus === 'pending' || user.repApplicationStatus === 'approved';
}

export async function getKycState(userId: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return toState(user);
}

/** KYC state of the space's lead rep — the account its collections settle into. */
export async function getSpaceKycState(spaceId: string): Promise<KycState & { leadRepId: string | null }> {
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: true } });
  if (!lead) return { ...EMPTY_STATE, leadRepId: null };
  return { ...toState(lead.user), leadRepId: lead.userId };
}

function statusFrom(result: IdentityResult): KycStatus {
  return result.status === 'verified' ? 'verified' : result.status === 'rejected' ? 'rejected' : 'pending';
}

async function storeStudentId(userId: string, doc: UploadedDocument) {
  return getFileStore().upload({
    buffer: doc.buffer,
    fileName: `student-id.${doc.ext}`,
    folder: `student-id/${userId}`,
    tags: ['kyc', 'student-id'],
  });
}

/** Best-effort removal of a superseded file; an orphan is harmless, a failed KYC is not. */
async function discardFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  await getFileStore()
    .delete(fileId)
    .catch((err) => logger.warn({ fileId, err: (err as Error).message }, 'could not delete superseded KYC file'));
}

export async function submitKyc(userId: string, input: KycSubmission): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can verify their identity', 'REP_NOT_APPROVED');
  }
  if (user.kycStatus === 'verified') throw conflict('ALREADY_VERIFIED', 'Your identity is already verified');
  if (user.kycStatus === 'pending' && user.bachsPersonId) {
    throw conflict('KYC_PENDING', 'Your verification is already being reviewed');
  }
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
      { field: 'nin', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
    ]);
  }

  // 1. The student ID goes to private storage first, so a failure there
  //    doesn't leave a half-submitted identity at Bachs.
  const stored = await storeStudentId(user.id, input.studentId);

  // 2. Identity at Bachs.
  const idNumbers: IdentityNumber[] = [{ type: 'nin', value: input.nin }];
  if (input.bvn) idNumbers.push({ type: 'bvn', value: input.bvn });
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
      idNumbers,
      dob: input.dob,
      existingAccountId: user.bachsAccountId,
      existingPersonId: user.bachsPersonId,
    });
  } catch (err) {
    await discardFile(stored.fileId);
    // A 4xx means the details were refused; count it. Anything else is the
    // provider being unavailable — not the rep's fault.
    if (err instanceof ProviderError && err.status !== null && err.status >= 400 && err.status < 500) {
      await recordFailedAttempt(user, err.message);
      throw new AppError(422, 'KYC_REJECTED', 'The verification details were not accepted. Check them and try again.');
    }
    throw err;
  }

  // 3. A government ID document, if the rep sent one (Bachs may ask for it).
  let governmentIdSubmittedAt = user.governmentIdSubmittedAt;
  if (input.governmentId) {
    try {
      await getPaymentProvider().uploadIdentityDocument({
        accountId: result.accountId,
        personId: result.personId,
        buffer: input.governmentId.buffer,
        fileName: `government-id.${input.governmentId.ext}`,
        mimeType: input.governmentId.mimeType,
      });
      governmentIdSubmittedAt = new Date();
    } catch (err) {
      logger.warn({ userId, err: (err as Error).message }, 'government ID upload to provider failed — rep can retry it');
    }
  }

  const kycStatus = statusFrom(result);
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      bachsAccountId: result.accountId,
      bachsPersonId: result.personId,
      kycStatus,
      bachsPayoutsActive: result.payoutsActive,
      kycRequirementsDue: result.requirementsDue,
      kycSubmittedAt: new Date(),
      // Kept for admins (the rep directory and application review).
      gender: input.gender,
      ...(input.phone ? { phone: input.phone } : {}),
      kycResolvedAt: kycStatus === 'pending' ? null : new Date(),
      kycRejectionReason: kycStatus === 'rejected' ? result.failureReason ?? 'Verification failed' : null,
      governmentIdSubmittedAt,
      studentIdFileId: stored.fileId,
      studentIdFilePath: stored.filePath,
      studentIdMimeType: input.studentId.mimeType,
      studentIdStatus: 'pending',
      studentIdUploadedAt: new Date(),
      studentIdReviewedAt: null,
      studentIdReviewedById: null,
      studentIdReviewNote: null,
    },
  });
  if (user.studentIdFileId && user.studentIdFileId !== stored.fileId) await discardFile(user.studentIdFileId);

  logger.info({ userId, providerRef: result.personId, kycStatus, requirementsDue: result.requirementsDue }, 'kyc submitted');
  return toState(updated);
}

/** Replace the student ID card — when an admin rejected it, or none was ever sent. */
export async function resubmitStudentId(userId: string, doc: UploadedDocument): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can upload a student ID', 'REP_NOT_APPROVED');
  }
  if (user.studentIdStatus === 'approved') throw conflict('STUDENT_ID_APPROVED', 'Your student ID is already approved');
  if (user.studentIdStatus === 'pending') throw conflict('STUDENT_ID_PENDING', 'Your student ID is already awaiting review');

  const stored = await storeStudentId(user.id, doc);
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      studentIdFileId: stored.fileId,
      studentIdFilePath: stored.filePath,
      studentIdMimeType: doc.mimeType,
      studentIdStatus: 'pending',
      studentIdUploadedAt: new Date(),
      studentIdReviewedAt: null,
      studentIdReviewedById: null,
      studentIdReviewNote: null,
    },
  });
  await discardFile(user.studentIdFileId);
  return toState(updated);
}

/** Forward a government ID document to Bachs, after Bachs asked for one. */
export async function submitGovernmentId(userId: string, doc: UploadedDocument): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.bachsAccountId || !user.bachsPersonId) {
    throw conflict('KYC_NOT_STARTED', 'Submit your NIN and student ID first');
  }
  await getPaymentProvider().uploadIdentityDocument({
    accountId: user.bachsAccountId,
    personId: user.bachsPersonId,
    buffer: doc.buffer,
    fileName: `government-id.${doc.ext}`,
    mimeType: doc.mimeType,
  });
  const updated = await db.user.update({ where: { id: user.id }, data: { governmentIdSubmittedAt: new Date() } });
  logger.info({ userId, providerRef: user.bachsPersonId }, 'government ID forwarded to provider');
  return toState(updated);
}

/**
 * Give the provider the rep's own bank account (`payout_destination`).
 * Collected during onboarding, and again whenever Bachs lists it in
 * requirementsDue. Name-checked first; the bank's name is what is sent.
 * Saved (masked) once Bachs accepts it, then the requirements are re-read.
 */
export async function submitPayoutDestination(userId: string, bankCode: string, accountNumber: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.bachsAccountId || !user.bachsPersonId) {
    throw conflict('KYC_NOT_STARTED', 'Submit your NIN and student ID first');
  }
  const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
  await getPaymentProvider().submitAccountPayoutDestination({
    accountId: user.bachsAccountId,
    bankCode,
    accountNumber,
    accountName,
  });
  await db.user.update({
    where: { id: userId },
    data: {
      payoutDestinationBankCode: bankCode,
      payoutDestinationBankName: bankName,
      payoutDestinationAccountMasked: maskAccountNumber(accountNumber),
      payoutDestinationAccountName: accountName,
      payoutDestinationSubmittedAt: new Date(),
    },
  });
  logger.info({ userId, providerRef: user.bachsAccountId, bank: bankCode, account: maskAccountNumber(accountNumber) }, 'payout destination sent to provider');
  await refreshIdentity(user.bachsAccountId);
  return toState(await db.user.findUniqueOrThrow({ where: { id: userId } }));
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
 * identity.updated — re-read the verdict and the outstanding requirements
 * from the provider and apply them. Idempotent.
 */
export async function refreshIdentity(accountId: string): Promise<'updated' | 'unchanged' | 'unknown'> {
  const user = await db.user.findUnique({ where: { bachsAccountId: accountId } });
  if (!user || !user.bachsPersonId) {
    logger.warn({ accountId }, 'identity event for an account we do not know');
    return 'unknown';
  }

  const result = await getPaymentProvider().getIdentityStatus(accountId, user.bachsPersonId);
  const kycStatus = statusFrom(result);
  const sameRequirements =
    result.requirementsDue.length === user.kycRequirementsDue.length &&
    result.requirementsDue.every((r) => user.kycRequirementsDue.includes(r));
  if (kycStatus === user.kycStatus && result.payoutsActive === user.bachsPayoutsActive && sameRequirements) return 'unchanged';

  const becameRejected = kycStatus === 'rejected' && user.kycStatus !== 'rejected';
  const attempts = becameRejected ? user.kycAttempts + 1 : user.kycAttempts;
  await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus,
      bachsPayoutsActive: result.payoutsActive,
      kycRequirementsDue: result.requirementsDue,
      kycResolvedAt: kycStatus === 'pending' ? user.kycResolvedAt : new Date(),
      kycRejectionReason: kycStatus === 'rejected' ? result.failureReason ?? 'Verification failed' : null,
      kycAttempts: kycStatus === 'verified' ? 0 : attempts,
      kycRetryLockedUntil:
        becameRejected && attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : user.kycRetryLockedUntil,
    },
  });
  logger.info(
    { userId: user.id, providerRef: user.bachsPersonId, kycStatus, payoutsActive: result.payoutsActive, requirementsDue: result.requirementsDue },
    'kyc updated',
  );

  if (kycStatus !== user.kycStatus && kycStatus !== 'pending') {
    await notify({
      userId: user.id,
      kind: 'system',
      tone: kycStatus === 'verified' ? 'brand' : 'rose',
      title: kycStatus === 'verified' ? 'Identity verified' : 'Identity verification failed',
      detail:
        kycStatus === 'verified'
          ? !user.isRep
            ? 'Your identity is verified. An admin will now review your rep application.'
            : user.studentIdStatus === 'approved'
              ? 'Your spaces can now collect payments.'
              : 'Your identity is verified. Collection opens once your student ID is approved.'
          : `We could not verify your identity${result.failureReason ? `: ${result.failureReason}` : ''}. Please try again.`,
      href: '/dashboard/kyc',
    }).catch(() => {});
  } else if (!sameRequirements && result.requirementsDue.length > 0) {
    await notify({
      userId: user.id,
      kind: 'system',
      tone: 'amber',
      title: 'More verification details needed',
      detail: 'Our payment partner has asked for more information to finish verifying you.',
      href: '/dashboard/kyc',
    }).catch(() => {});
  }
  return 'updated';
}

// ---------------------------------------------------------------------------
// Admin: student ID review
// ---------------------------------------------------------------------------

type AdminKycFields = Pick<
  User,
  | 'kycStatus'
  | 'kycRejectionReason'
  | 'kycRequirementsDue'
  | 'kycSubmittedAt'
  | 'kycResolvedAt'
  | 'studentIdStatus'
  | 'studentIdFilePath'
  | 'studentIdMimeType'
  | 'studentIdUploadedAt'
  | 'studentIdReviewedAt'
  | 'studentIdReviewNote'
>;

/** The KYC picture an admin needs next to a rep application: the Bachs NIN verdict and the student ID card. */
export function adminKycSummary(u: AdminKycFields) {
  return {
    identity: {
      status: u.kycStatus,
      rejectionReason: u.kycRejectionReason,
      requirementsDue: u.kycRequirementsDue,
      submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
      resolvedAt: u.kycResolvedAt?.toISOString() ?? null,
    },
    studentId: {
      status: u.studentIdStatus,
      mimeType: u.studentIdMimeType,
      uploadedAt: u.studentIdUploadedAt?.toISOString() ?? null,
      reviewedAt: u.studentIdReviewedAt?.toISOString() ?? null,
      reviewNote: u.studentIdReviewNote,
      // Short-lived: the document is private and never linked permanently.
      viewUrl: u.studentIdFilePath ? getFileStore().signedUrl(u.studentIdFilePath, REVIEW_URL_TTL_SECONDS) : null,
      viewUrlExpiresInSeconds: REVIEW_URL_TTL_SECONDS,
    },
  };
}

export async function listStudentIdsForReview(status: DocumentReviewStatus, skip: number, take: number) {
  const where = { studentIdStatus: status };
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { studentIdUploadedAt: 'asc' },
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        matricNo: true,
        institution: true,
        kycStatus: true,
        studentIdFilePath: true,
        studentIdMimeType: true,
        studentIdStatus: true,
        studentIdUploadedAt: true,
        studentIdReviewedAt: true,
        studentIdReviewNote: true,
      },
    }),
  ]);
  const store = getFileStore();
  return {
    total,
    rows: users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      matricNo: u.matricNo,
      institution: u.institution,
      kycStatus: u.kycStatus,
      studentId: {
        status: u.studentIdStatus,
        mimeType: u.studentIdMimeType,
        uploadedAt: u.studentIdUploadedAt?.toISOString() ?? null,
        reviewedAt: u.studentIdReviewedAt?.toISOString() ?? null,
        reviewNote: u.studentIdReviewNote,
        // Short-lived: the document is private and never linked permanently.
        viewUrl: u.studentIdFilePath ? store.signedUrl(u.studentIdFilePath, REVIEW_URL_TTL_SECONDS) : null,
        viewUrlExpiresInSeconds: REVIEW_URL_TTL_SECONDS,
      },
    })),
  };
}

export async function reviewStudentId(
  adminId: string,
  userId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<KycState> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');
  if (user.studentIdStatus !== 'pending') throw conflict('NOT_PENDING', 'There is no student ID awaiting review for this user');
  if (decision === 'rejected' && !note) throw new AppError(400, 'VALIDATION_ERROR', 'Give the rep a reason when rejecting');

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      studentIdStatus: decision,
      studentIdReviewedAt: new Date(),
      studentIdReviewedById: adminId,
      studentIdReviewNote: note ?? null,
    },
  });
  await notify({
    userId,
    kind: 'system',
    tone: decision === 'approved' ? 'brand' : 'rose',
    title: decision === 'approved' ? 'Student ID approved' : 'Student ID not accepted',
    detail:
      decision === 'approved'
        ? !updated.isRep
          ? 'Your student ID is approved. An admin will finish reviewing your rep application.'
          : updated.kycStatus === 'verified'
            ? 'Your spaces can now collect payments.'
            : 'Collection opens once your identity verification completes.'
        : `Please upload a clearer, valid student ID card. Reason: ${note}`,
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated);
}
