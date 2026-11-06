import { type DocumentReviewStatus, type KycStatus, type Prisma, type User } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getFileStore } from '../lib/storage';
import { getIdentityVerifier, type NinCheckResult } from '../providers/identity';

/**
 * Rep identity verification (KYC). Two independent checks, both required
 * before a rep can run a space's collections and withdrawals:
 *
 *  1. The rep's NIN and date of birth are checked against NIMC by Didit
 *     (src/providers/identity), synchronously. A full match verifies the rep;
 *     a partial match (name or date of birth only partly matched) waits for
 *     an admin; no match counts as a failed attempt.
 *  2. Duevy verifies the rep is a student: the rep uploads their student ID
 *     card, stored privately in ImageKit, and an admin approves it.
 *
 * The money is the space's, never the rep's: KYC records who is accountable
 * for running the space, so an incoming rep verifies before they can act.
 *
 * The NIN and date of birth go straight to the check and are NEVER persisted
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
  dob: string; // YYYY-MM-DD
  studentId: UploadedDocument;
}

/** One free-text name → first/last for the provider. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

type KycFields = Pick<User, 'kycStatus' | 'studentIdStatus'>;

/** Can this rep run a space's collections? Identity verified AND an admin approved the student ID. */
export function canCollect(user: KycFields): boolean {
  return user.kycStatus === 'verified' && user.studentIdStatus === 'approved';
}

/** Can this rep withdraw a space's money? The same bar as collecting. */
export function canWithdraw(user: KycFields): boolean {
  return canCollect(user);
}

export interface KycState {
  kycStatus: KycStatus;
  canCollect: boolean;
  canWithdraw: boolean;
  /** Deprecated: always equals canWithdraw. Kept for older clients. */
  payoutsActive: boolean;
  /** Deprecated: always empty. Kept for older clients. */
  requirementsDue: string[];
  /** The NIN check: its outcome and, after a partial match, the admin's review. */
  nin: {
    outcome: string | null;
    reviewStatus: DocumentReviewStatus | null;
    reviewNote: string | null;
  };
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

/** The user fields {@link toState} reads, for loads that only need the KYC state. */
const KYC_STATE_SELECT = {
  kycStatus: true,
  ninCheckOutcome: true,
  ninReviewStatus: true,
  ninReviewNote: true,
  studentIdStatus: true,
  studentIdUploadedAt: true,
  studentIdReviewedAt: true,
  studentIdReviewNote: true,
  kycRejectionReason: true,
  kycRetryLockedUntil: true,
  kycSubmittedAt: true,
  kycResolvedAt: true,
} as const satisfies Prisma.UserSelect;

function toState(u: Prisma.UserGetPayload<{ select: typeof KYC_STATE_SELECT }>): KycState {
  return {
    kycStatus: u.kycStatus,
    canCollect: canCollect(u),
    canWithdraw: canWithdraw(u),
    payoutsActive: canWithdraw(u),
    requirementsDue: [],
    nin: { outcome: u.ninCheckOutcome, reviewStatus: u.ninReviewStatus, reviewNote: u.ninReviewNote },
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
  canCollect: false,
  canWithdraw: false,
  payoutsActive: false,
  requirementsDue: [],
  nin: { outcome: null, reviewStatus: null, reviewNote: null },
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

/** KYC state of the space's lead rep — the rep accountable for its collections. */
export async function getSpaceKycState(spaceId: string): Promise<KycState & { leadRepId: string | null }> {
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: { select: KYC_STATE_SELECT } } });
  if (!lead) return { ...EMPTY_STATE, leadRepId: null };
  return { ...toState(lead.user), leadRepId: lead.userId };
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
  if (user.kycStatus === 'pending' && user.ninReviewStatus === 'pending') {
    throw conflict('KYC_PENDING', 'Your verification is already being reviewed');
  }
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
      { field: 'nin', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
    ]);
  }

  // 1. The student ID goes to private storage first, so a storage failure
  //    doesn't spend one of the rep's identity checks.
  const stored = await storeStudentId(user.id, input.studentId);

  // 2. The NIN and date of birth against NIMC.
  const names = splitName(user.name);
  let result: NinCheckResult;
  try {
    result = await getIdentityVerifier().verifyNin({
      userId: user.id,
      firstName: names.firstName,
      lastName: names.lastName,
      nin: input.nin,
      dob: input.dob,
    });
  } catch (err) {
    await discardFile(stored.fileId);
    throw err;
  }

  if (result.outcome === 'unavailable') {
    // The register couldn't be reached — not the rep's fault, not an attempt.
    await discardFile(stored.fileId);
    throw new AppError(503, 'KYC_PROVIDER_UNAVAILABLE', "We couldn't reach the identity service. Please try again in a few minutes.");
  }
  if (result.outcome === 'no_match') {
    await discardFile(stored.fileId);
    await recordFailedAttempt(user, 'The NIN and date of birth did not match the national register', result);
    throw new AppError(422, 'KYC_REJECTED', 'Your NIN and date of birth did not match the national register. Check them and try again.');
  }

  const kycStatus: KycStatus = result.outcome === 'match' ? 'verified' : 'pending';
  const now = new Date();
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus,
      diditRequestId: result.requestId,
      ninCheckOutcome: result.outcome,
      ninNameMatchScore: result.nameMatchScore,
      ninReviewStatus: result.outcome === 'partial' ? 'pending' : null,
      ninReviewedAt: null,
      ninReviewedById: null,
      ninReviewNote: null,
      kycSubmittedAt: now,
      kycResolvedAt: kycStatus === 'verified' ? now : null,
      kycRejectionReason: null,
      kycAttempts: kycStatus === 'verified' ? 0 : user.kycAttempts,
      studentIdFileId: stored.fileId,
      studentIdFilePath: stored.filePath,
      studentIdMimeType: input.studentId.mimeType,
      studentIdStatus: 'pending',
      studentIdUploadedAt: now,
      studentIdReviewedAt: null,
      studentIdReviewedById: null,
      studentIdReviewNote: null,
    },
  });
  if (user.studentIdFileId && user.studentIdFileId !== stored.fileId) await discardFile(user.studentIdFileId);

  logger.info({ userId, providerRef: result.requestId, outcome: result.outcome, kycStatus }, 'kyc submitted');
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

async function recordFailedAttempt(user: User, reason: string, result?: NinCheckResult): Promise<void> {
  const attempts = user.kycAttempts + 1;
  await db.user.update({
    where: { id: user.id },
    data: {
      kycAttempts: attempts,
      kycStatus: 'rejected',
      kycRejectionReason: reason.slice(0, 300),
      kycResolvedAt: new Date(),
      kycRetryLockedUntil: attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : null,
      ...(result ? { diditRequestId: result.requestId, ninCheckOutcome: result.outcome, ninNameMatchScore: result.nameMatchScore } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Admin: NIN partial-match review
// ---------------------------------------------------------------------------

/** Reps whose NIN only partly matched, oldest first. The NIN itself was never stored. */
export async function listNinReviews(status: DocumentReviewStatus, skip: number, take: number) {
  const where = { ninReviewStatus: status };
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { kycSubmittedAt: 'asc' },
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        matricNo: true,
        institution: true,
        kycStatus: true,
        kycSubmittedAt: true,
        ninNameMatchScore: true,
        ninReviewStatus: true,
        ninReviewedAt: true,
        ninReviewNote: true,
        diditRequestId: true,
        studentIdStatus: true,
      },
    }),
  ]);
  return {
    total,
    rows: users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      matricNo: u.matricNo,
      institution: u.institution,
      kycStatus: u.kycStatus,
      submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
      nameMatchScore: u.ninNameMatchScore,
      reviewStatus: u.ninReviewStatus,
      reviewedAt: u.ninReviewedAt?.toISOString() ?? null,
      reviewNote: u.ninReviewNote,
      // Look the check up in the Didit console by this.
      providerReference: u.diditRequestId,
      studentIdStatus: u.studentIdStatus,
    })),
  };
}

/** An admin's decision on a partial NIN match: approve verifies the rep, reject counts as a failed attempt. */
export async function reviewNin(
  adminId: string,
  userId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<KycState> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');
  if (user.ninReviewStatus !== 'pending') throw conflict('NOT_PENDING', 'There is no NIN check awaiting review for this user');
  if (decision === 'rejected' && !note) throw new AppError(400, 'VALIDATION_ERROR', 'Give the rep a reason when rejecting');

  const now = new Date();
  const attempts = decision === 'rejected' ? user.kycAttempts + 1 : 0;
  const updated = await db.user.update({
    where: { id: userId },
    data: {
      ninReviewStatus: decision,
      ninReviewedAt: now,
      ninReviewedById: adminId,
      ninReviewNote: note ?? null,
      kycStatus: decision === 'approved' ? 'verified' : 'rejected',
      kycResolvedAt: now,
      kycRejectionReason: decision === 'rejected' ? note!.slice(0, 300) : null,
      kycAttempts: attempts,
      kycRetryLockedUntil: decision === 'rejected' && attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : null,
    },
  });
  logger.info({ userId, adminId, decision }, 'nin review decided');
  await notify({
    userId,
    kind: 'system',
    tone: decision === 'approved' ? 'brand' : 'rose',
    title: decision === 'approved' ? 'Identity verified' : 'Identity verification failed',
    detail:
      decision === 'approved'
        ? !updated.isRep
          ? 'Your identity is verified. An admin will now review your rep application.'
          : updated.studentIdStatus === 'approved'
            ? 'Your spaces can now collect payments.'
            : 'Your identity is verified. Collection opens once your student ID is approved.'
        : `We could not verify your identity: ${note}. Please check your details and try again.`,
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated);
}

// ---------------------------------------------------------------------------
// Admin: student ID review
// ---------------------------------------------------------------------------

type AdminKycFields = Pick<
  User,
  | 'kycStatus'
  | 'kycRejectionReason'
  | 'kycSubmittedAt'
  | 'ninCheckOutcome'
  | 'ninNameMatchScore'
  | 'ninReviewStatus'
  | 'ninReviewNote'
  | 'kycResolvedAt'
  | 'studentIdStatus'
  | 'studentIdFilePath'
  | 'studentIdMimeType'
  | 'studentIdUploadedAt'
  | 'studentIdReviewedAt'
  | 'studentIdReviewNote'
>;

/** The KYC picture an admin needs next to a rep application: the NIN check and the student ID card. */
export function adminKycSummary(u: AdminKycFields) {
  return {
    identity: {
      status: u.kycStatus,
      rejectionReason: u.kycRejectionReason,
      ninOutcome: u.ninCheckOutcome,
      nameMatchScore: u.ninNameMatchScore,
      ninReviewStatus: u.ninReviewStatus,
      ninReviewNote: u.ninReviewNote,
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
