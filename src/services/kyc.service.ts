import { type DocumentReviewStatus, type KycStatus, type Prisma, type User } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getFileStore } from '../lib/storage';
import { getIdentityVerifier, type NinCheckResult } from '../providers/identity';
import { getKycPolicy, type KycPolicy } from './kycPolicy.service';

/**
 * Rep identity verification (KYC). What a rep must pass before their space
 * can collect is the admin-set policy (kycPolicy.service.ts), evaluated at
 * decision time:
 *
 *  1. Student ID (always): the rep uploads their student ID card, stored
 *     privately in ImageKit, and an admin approves it.
 *  2. Liveness (while livenessRequired): a photo or short video of the rep's
 *     face, captured by the app, stored privately; an admin approves it,
 *     looking at it next to the student ID card.
 *  3. NIN (while ninRequired): NIN + date of birth checked against NIMC by
 *     Didit (src/providers/identity), synchronously. A full match verifies;
 *     a partial match waits for an admin; no match counts as a failed attempt.
 *     While not required, a NIN is optional and is not sent anywhere.
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
  /** Required while the policy requires NIN; ignored (never sent anywhere) otherwise. */
  nin?: string;
  dob?: string; // YYYY-MM-DD
  studentId: UploadedDocument;
  /** The face capture; required while the policy requires liveness. */
  liveness?: UploadedDocument;
}

/** One free-text name → first/last for the provider. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

type KycFields = Pick<User, 'kycStatus' | 'studentIdStatus' | 'livenessStatus'>;

/** Can this rep run a space's collections? Every check the current policy requires has passed. */
export function canCollect(user: KycFields, policy: KycPolicy): boolean {
  return (
    user.studentIdStatus === 'approved' &&
    (!policy.ninRequired || user.kycStatus === 'verified') &&
    (!policy.livenessRequired || user.livenessStatus === 'approved')
  );
}

/** Withdrawals need the same verified identity as collecting. */
export function canWithdraw(user: KycFields, policy: KycPolicy): boolean {
  return canCollect(user, policy);
}

export interface KycState {
  kycStatus: KycStatus;
  canCollect: boolean;
  canWithdraw: boolean;
  /** Deprecated: always equals canWithdraw. Kept for older clients. */
  payoutsActive: boolean;
  /** Deprecated: always empty. Kept for older clients. */
  requirementsDue: string[];
  /** Which checks the current policy requires (the student ID always is). */
  requirements: { nin: boolean; studentId: true; liveness: boolean };
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
  /** The face capture an admin reviews. */
  liveness: {
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
  livenessStatus: true,
  livenessUploadedAt: true,
  livenessReviewedAt: true,
  livenessReviewNote: true,
  kycRejectionReason: true,
  kycRetryLockedUntil: true,
  kycSubmittedAt: true,
  kycResolvedAt: true,
} as const satisfies Prisma.UserSelect;

function toState(u: Prisma.UserGetPayload<{ select: typeof KYC_STATE_SELECT }>, policy: KycPolicy): KycState {
  return {
    kycStatus: u.kycStatus,
    canCollect: canCollect(u, policy),
    canWithdraw: canWithdraw(u, policy),
    payoutsActive: canWithdraw(u, policy),
    requirementsDue: [],
    requirements: { nin: policy.ninRequired, studentId: true, liveness: policy.livenessRequired },
    nin: { outcome: u.ninCheckOutcome, reviewStatus: u.ninReviewStatus, reviewNote: u.ninReviewNote },
    studentId: {
      status: u.studentIdStatus,
      uploadedAt: u.studentIdUploadedAt?.toISOString() ?? null,
      reviewedAt: u.studentIdReviewedAt?.toISOString() ?? null,
      reviewNote: u.studentIdReviewNote,
    },
    liveness: {
      status: u.livenessStatus,
      uploadedAt: u.livenessUploadedAt?.toISOString() ?? null,
      reviewedAt: u.livenessReviewedAt?.toISOString() ?? null,
      reviewNote: u.livenessReviewNote,
    },
    rejectionReason: u.kycRejectionReason,
    retryLockedUntil: u.kycRetryLockedUntil?.toISOString() ?? null,
    submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
    resolvedAt: u.kycResolvedAt?.toISOString() ?? null,
  };
}

const emptyState = (policy: KycPolicy): KycState => ({
  kycStatus: 'unverified',
  canCollect: false,
  canWithdraw: false,
  payoutsActive: false,
  requirementsDue: [],
  requirements: { nin: policy.ninRequired, studentId: true, liveness: policy.livenessRequired },
  nin: { outcome: null, reviewStatus: null, reviewNote: null },
  studentId: { status: null, uploadedAt: null, reviewedAt: null, reviewNote: null },
  liveness: { status: null, uploadedAt: null, reviewedAt: null, reviewNote: null },
  rejectionReason: null,
  retryLockedUntil: null,
  submittedAt: null,
  resolvedAt: null,
});

/**
 * KYC is part of the rep application: applicants verify before an admin gives
 * final approval, so a pending application is enough to submit.
 */
function isRepOrApplicant(user: Pick<User, 'isRep' | 'repApplicationStatus'>): boolean {
  return user.isRep || user.repApplicationStatus === 'pending' || user.repApplicationStatus === 'approved';
}

export async function getKycState(userId: string): Promise<KycState> {
  const [user, policy] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: userId } }), getKycPolicy()]);
  return toState(user, policy);
}

/** KYC state of the space's lead rep — the rep accountable for its collections. */
export async function getSpaceKycState(spaceId: string): Promise<KycState & { leadRepId: string | null }> {
  const [lead, policy] = await Promise.all([
    db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, include: { user: { select: KYC_STATE_SELECT } } }),
    getKycPolicy(),
  ]);
  if (!lead) return { ...emptyState(policy), leadRepId: null };
  return { ...toState(lead.user, policy), leadRepId: lead.userId };
}

async function storeStudentId(userId: string, doc: UploadedDocument) {
  return getFileStore().upload({
    buffer: doc.buffer,
    fileName: `student-id.${doc.ext}`,
    folder: `student-id/${userId}`,
    tags: ['kyc', 'student-id'],
  });
}

async function storeLiveness(userId: string, doc: UploadedDocument) {
  return getFileStore().upload({
    buffer: doc.buffer,
    fileName: `liveness.${doc.ext}`,
    folder: `liveness/${userId}`,
    tags: ['kyc', 'liveness'],
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
  const [user, policy] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: userId } }), getKycPolicy()]);

  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can verify their identity', 'REP_NOT_APPROVED');
  }
  if (canCollect(user, policy)) throw conflict('ALREADY_VERIFIED', 'Your identity is already verified');

  // The NIN runs only while required, and only if this rep hasn't passed it.
  const runNin = policy.ninRequired && user.kycStatus !== 'verified';
  if (runNin) {
    if (user.kycStatus === 'pending' && user.ninReviewStatus === 'pending') {
      throw conflict('KYC_PENDING', 'Your verification is already being reviewed');
    }
    if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
      throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
        { field: 'nin', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
      ]);
    }
    if (!input.nin || !input.dob) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Your NIN and date of birth are required', [
        ...(!input.nin ? [{ field: 'nin', issue: 'required' }] : []),
        ...(!input.dob ? [{ field: 'dob', issue: 'required' }] : []),
      ]);
    }
  }
  if (policy.livenessRequired && !input.liveness && user.livenessStatus !== 'approved' && user.livenessStatus !== 'pending') {
    throw new AppError(400, 'VALIDATION_ERROR', 'A photo or short video of your face is required', [
      { field: 'liveness', issue: 'required' },
    ]);
  }

  // 1. Files go to private storage first, so a storage failure doesn't spend
  //    one of the rep's identity checks.
  const [stored, storedLiveness] = await Promise.all([
    storeStudentId(user.id, input.studentId),
    input.liveness ? storeLiveness(user.id, input.liveness) : null,
  ]);
  const discardUploads = () => Promise.all([discardFile(stored.fileId), discardFile(storedLiveness?.fileId)]);

  // 2. While required: the NIN and date of birth against NIMC.
  let result: NinCheckResult | null = null;
  if (runNin) {
    const names = splitName(user.name);
    try {
      result = await getIdentityVerifier().verifyNin({
        userId: user.id,
        firstName: names.firstName,
        lastName: names.lastName,
        nin: input.nin!,
        dob: input.dob!,
      });
    } catch (err) {
      await discardUploads();
      throw err;
    }

    if (result.outcome === 'unavailable') {
      // The register couldn't be reached — not the rep's fault, not an attempt.
      await discardUploads();
      throw new AppError(503, 'KYC_PROVIDER_UNAVAILABLE', "We couldn't reach the identity service. Please try again in a few minutes.");
    }
    if (result.outcome === 'invalid_input') {
      // Refused before any lookup, because of how the details reached the
      // verifier: not an attempt. The account name is what's sent as the name.
      await discardUploads();
      throw new AppError(
        422,
        'KYC_INPUT_UNREADABLE',
        "We couldn't check these details as entered. Make sure the name on your profile matches the one on your NIN record, then try again.",
      );
    }
    if (result.outcome === 'no_match') {
      await discardUploads();
      await recordFailedAttempt(user, 'The NIN and date of birth did not match the national register', result);
      throw new AppError(422, 'KYC_REJECTED', 'Your NIN and date of birth did not match the national register. Check them and try again.');
    }
  }

  const now = new Date();
  const ninData: Prisma.UserUpdateInput = result
    ? {
        kycStatus: result.outcome === 'match' ? 'verified' : 'pending',
        diditRequestId: result.requestId,
        ninCheckOutcome: result.outcome,
        ninNameMatchScore: result.nameMatchScore,
        ninReviewStatus: result.outcome === 'partial' ? 'pending' : null,
        ninReviewedAt: null,
        ninReviewedById: null,
        ninReviewNote: null,
        kycResolvedAt: result.outcome === 'match' ? now : null,
        kycRejectionReason: null,
        kycAttempts: result.outcome === 'match' ? 0 : user.kycAttempts,
      }
    : {};
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...ninData,
      kycSubmittedAt: now,
      studentIdFileId: stored.fileId,
      studentIdFilePath: stored.filePath,
      studentIdMimeType: input.studentId.mimeType,
      studentIdStatus: 'pending',
      studentIdUploadedAt: now,
      studentIdReviewedAt: null,
      studentIdReviewedById: null,
      studentIdReviewNote: null,
      ...(storedLiveness && input.liveness ? livenessUploadData(storedLiveness, input.liveness.mimeType, now) : {}),
    },
  });
  if (user.studentIdFileId && user.studentIdFileId !== stored.fileId) await discardFile(user.studentIdFileId);
  if (storedLiveness && user.livenessFileId && user.livenessFileId !== storedLiveness.fileId) await discardFile(user.livenessFileId);

  logger.info({ userId, providerRef: result?.requestId ?? null, outcome: result?.outcome ?? 'not_required', liveness: !!storedLiveness }, 'kyc submitted');
  return toState(updated, policy);
}

function livenessUploadData(stored: { fileId: string; filePath: string }, mimeType: string, now: Date): Prisma.UserUpdateInput {
  return {
    livenessFileId: stored.fileId,
    livenessFilePath: stored.filePath,
    livenessMimeType: mimeType,
    livenessStatus: 'pending',
    livenessUploadedAt: now,
    livenessReviewedAt: null,
    livenessReviewedById: null,
    livenessReviewNote: null,
  };
}

/** A new face capture: first one, a retake after a rejection, or one an admin asked for. */
export async function submitLiveness(userId: string, doc: UploadedDocument): Promise<KycState> {
  const [user, policy] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: userId } }), getKycPolicy()]);
  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can verify their identity', 'REP_NOT_APPROVED');
  }
  if (user.livenessStatus === 'pending') throw conflict('LIVENESS_PENDING', 'Your face capture is already awaiting review');
  // An approval with a capture on file stands; an approval without one (reps
  // verified before liveness existed) may be replaced by a real capture.
  if (user.livenessStatus === 'approved' && user.livenessFileId) {
    throw conflict('LIVENESS_APPROVED', 'Your face capture is already approved');
  }

  const stored = await storeLiveness(user.id, doc);
  const updated = await db.user.update({ where: { id: user.id }, data: livenessUploadData(stored, doc.mimeType, new Date()) });
  if (user.livenessFileId && user.livenessFileId !== stored.fileId) await discardFile(user.livenessFileId);
  logger.info({ userId }, 'liveness capture submitted');
  return toState(updated, policy);
}

/** Replace the student ID card — when an admin rejected it, or none was ever sent. */
export async function resubmitStudentId(userId: string, doc: UploadedDocument): Promise<KycState> {
  const [user, policy] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: userId } }), getKycPolicy()]);
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
  return toState(updated, policy);
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

/** What a rep is told after an admin approves one check: what it unlocked, or what's still to come. */
function afterApprovalDetail(user: User, policy: KycPolicy, what: string): string {
  if (!user.isRep) return `Your ${what} is approved. An admin will finish reviewing your rep application.`;
  if (canCollect(user, policy)) return 'Your spaces can now collect payments.';
  const waiting = [
    user.studentIdStatus !== 'approved' ? 'your student ID' : null,
    policy.livenessRequired && user.livenessStatus !== 'approved' ? 'your face capture' : null,
    policy.ninRequired && user.kycStatus !== 'verified' ? 'your NIN check' : null,
  ].filter(Boolean);
  return `Your ${what} is approved. Collection opens once ${waiting.join(' and ')} ${waiting.length > 1 ? 'are' : 'is'} approved.`;
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
  const [user, policy] = await Promise.all([db.user.findUnique({ where: { id: userId } }), getKycPolicy()]);
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
        ? afterApprovalDetail(updated, policy, 'NIN check')
        : `We could not verify your identity: ${note}. Please check your details and try again.`,
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated, policy);
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
  | 'livenessStatus'
  | 'livenessFilePath'
  | 'livenessMimeType'
  | 'livenessUploadedAt'
  | 'livenessReviewedAt'
  | 'livenessReviewNote'
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
    liveness: livenessView(u),
  };
}

/** A face capture for an admin: a short-lived link, and whether it plays as a video. */
function livenessView(u: Pick<User, 'livenessStatus' | 'livenessFilePath' | 'livenessMimeType' | 'livenessUploadedAt' | 'livenessReviewedAt' | 'livenessReviewNote'>) {
  return {
    status: u.livenessStatus,
    mimeType: u.livenessMimeType,
    kind: u.livenessMimeType ? (u.livenessMimeType.startsWith('video/') ? ('video' as const) : ('photo' as const)) : null,
    uploadedAt: u.livenessUploadedAt?.toISOString() ?? null,
    reviewedAt: u.livenessReviewedAt?.toISOString() ?? null,
    reviewNote: u.livenessReviewNote,
    // Short-lived: the capture is private and never linked permanently.
    viewUrl: u.livenessFilePath ? getFileStore().signedUrl(u.livenessFilePath, REVIEW_URL_TTL_SECONDS) : null,
    viewUrlExpiresInSeconds: REVIEW_URL_TTL_SECONDS,
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
  const [user, policy] = await Promise.all([db.user.findUnique({ where: { id: userId } }), getKycPolicy()]);
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
        ? afterApprovalDetail(updated, policy, 'student ID')
        : `Please upload a clearer, valid student ID card. Reason: ${note}`,
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated, policy);
}

// ---------------------------------------------------------------------------
// Admin: liveness review. The capture is shown next to the rep's student ID
// card, so the admin can see it's a live person and the same face.
// ---------------------------------------------------------------------------

export async function listLivenessForReview(status: DocumentReviewStatus, skip: number, take: number) {
  const where = { livenessStatus: status };
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { livenessUploadedAt: 'asc' },
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        matricNo: true,
        institution: true,
        livenessStatus: true,
        livenessFilePath: true,
        livenessMimeType: true,
        livenessUploadedAt: true,
        livenessReviewedAt: true,
        livenessReviewNote: true,
        studentIdStatus: true,
        studentIdFilePath: true,
        studentIdMimeType: true,
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
      liveness: livenessView(u),
      // To compare faces.
      studentId: {
        status: u.studentIdStatus,
        mimeType: u.studentIdMimeType,
        viewUrl: u.studentIdFilePath ? store.signedUrl(u.studentIdFilePath, REVIEW_URL_TTL_SECONDS) : null,
        viewUrlExpiresInSeconds: REVIEW_URL_TTL_SECONDS,
      },
    })),
  };
}

export async function reviewLiveness(
  adminId: string,
  userId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<KycState> {
  const [user, policy] = await Promise.all([db.user.findUnique({ where: { id: userId } }), getKycPolicy()]);
  if (!user) throw notFound('User not found');
  if (user.livenessStatus !== 'pending') throw conflict('NOT_PENDING', 'There is no face capture awaiting review for this user');
  if (decision === 'rejected' && !note) throw new AppError(400, 'VALIDATION_ERROR', 'Give the rep a reason when rejecting');

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      livenessStatus: decision,
      livenessReviewedAt: new Date(),
      livenessReviewedById: adminId,
      livenessReviewNote: note ?? null,
    },
  });
  logger.info({ userId, adminId, decision }, 'liveness review decided');
  await notify({
    userId,
    kind: 'system',
    tone: decision === 'approved' ? 'brand' : 'rose',
    title: decision === 'approved' ? 'Face capture approved' : 'Face capture not accepted',
    detail:
      decision === 'approved'
        ? afterApprovalDetail(updated, policy, 'face capture')
        : `Please take a new photo or video of your face. Reason: ${note}`,
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated, policy);
}
