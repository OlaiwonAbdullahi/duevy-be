import { type DocumentReviewStatus, type KycStatus, type Prisma, type User } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getFileStore } from '../lib/storage';
import { checkPhoneCode, DiditError, normaliseNigerianPhone, sendPhoneCode, verifyIdNumber, type IdCheckResult, type IdKind } from '../lib/didit';
import { getPaymentProvider } from '../providers/payment';

/**
 * Rep identity verification (KYC). Three checks, all required before a rep's
 * spaces can collect:
 *
 *  1. Phone: Didit texts a one-time code to the rep's number and checks it.
 *  2. NIN and BVN: Didit validates each, with the name and date of birth,
 *     against Nigeria's registries. Approval opens the rep's wallet (a Bank78
 *     sub-account, which needs the BVN) that collections are routed into and
 *     withdrawals are paid out of.
 *  3. Student: the rep uploads their student ID card, stored privately in
 *     ImageKit, and an admin approves it.
 *
 * The NIN, BVN, date of birth and OTP code go straight to Didit (the NIN and
 * BVN also to Bank78 when the wallet opens) and are NEVER persisted or logged. For the
 * student ID we keep only the storage reference.
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
  /** Bank78 requires it to open the rep's wallet. Checked by Didit, never stored. */
  bvn: string;
  dob: string; // YYYY-MM-DD
  /** Kept on the user for admins. */
  gender: 'male' | 'female';
  firstName?: string;
  lastName?: string;
  studentId: UploadedDocument;
}

/** One free-text name → first/last for the provider. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

type KycFields = Pick<User, 'kycStatus' | 'walletAccountNumber' | 'studentIdStatus'>;

/** Can this rep's spaces take payments? Didit verified the rep, they have a wallet, and an admin approved the student ID. */
export function canCollect(user: KycFields): boolean {
  return user.kycStatus === 'verified' && !!user.walletAccountNumber && user.studentIdStatus === 'approved';
}

/** Can this rep withdraw? Withdrawals come out of the same wallet collections go into. */
export function canWithdraw(user: KycFields): boolean {
  return canCollect(user);
}

export interface KycState {
  kycStatus: KycStatus;
  payoutsActive: boolean;
  canCollect: boolean;
  canWithdraw: boolean;
  /** Didit's reference for the NIN check. */
  providerReference: string | null;
  phone: { number: string | null; verifiedAt: string | null };
  /** The rep's Bank78 wallet; `null` until the NIN is approved. */
  wallet: { accountNumber: string } | null;
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
  walletAccountNumber: true,
  diditNinRequestId: true,
  phone: true,
  phoneVerifiedAt: true,
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
    payoutsActive: canWithdraw(u),
    canCollect: canCollect(u),
    canWithdraw: canWithdraw(u),
    providerReference: u.diditNinRequestId,
    phone: { number: u.phone, verifiedAt: u.phoneVerifiedAt?.toISOString() ?? null },
    wallet: u.walletAccountNumber ? { accountNumber: u.walletAccountNumber } : null,
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
  phone: { number: null, verifiedAt: null },
  wallet: null,
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

/** KYC state of the space's lead rep — whose wallet its collections are routed into. */
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

function unavailable(): AppError {
  return new AppError(503, 'KYC_UNAVAILABLE', 'Verification is temporarily unavailable. Please try again in a few minutes.');
}

// ---------------------------------------------------------------------------
// Step 1 — phone
// ---------------------------------------------------------------------------

function parsePhone(input: string): string {
  const phone = normaliseNigerianPhone(input);
  if (!phone) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a Nigerian mobile number', [{ field: 'phone', issue: 'must be a Nigerian mobile number, e.g. 08012345678' }]);
  }
  return phone;
}

async function assertCanVerify(userId: string): Promise<User> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can verify their identity', 'REP_NOT_APPROVED');
  }
  return user;
}

/** Text a one-time code to the rep's phone. */
export async function sendPhoneVerification(userId: string, phoneInput: string): Promise<{ phone: string }> {
  await assertCanVerify(userId);
  const phone = parsePhone(phoneInput);
  let outcome;
  try {
    outcome = await sendPhoneCode(userId, phone);
  } catch (err) {
    if (err instanceof DiditError && !err.retryable) {
      throw new AppError(422, 'PHONE_REJECTED', 'We could not send a code to that number. Check it and try again.');
    }
    throw unavailable();
  }
  if (outcome === 'blocked') {
    throw new AppError(429, 'PHONE_BLOCKED', 'Too many attempts for this number. Try again later or use another number.');
  }
  return { phone };
}

/** Check the code. On success the number is saved as the rep's verified phone. */
export async function confirmPhoneVerification(userId: string, phoneInput: string, code: string): Promise<KycState> {
  await assertCanVerify(userId);
  const phone = parsePhone(phoneInput);
  let result;
  try {
    result = await checkPhoneCode(userId, phone, code);
  } catch (err) {
    if (err instanceof DiditError && !err.retryable) {
      throw new AppError(422, 'INVALID_CODE', 'That code is not valid', [{ field: 'code', issue: 'invalid' }]);
    }
    throw unavailable();
  }
  switch (result.outcome) {
    case 'approved': {
      const updated = await db.user.update({ where: { id: userId }, data: { phone, phoneVerifiedAt: new Date() } });
      logger.info({ userId }, 'kyc phone verified');
      return toState(updated);
    }
    case 'wrong_code':
      throw new AppError(422, 'INVALID_CODE', result.message ?? 'The code is incorrect', [{ field: 'code', issue: 'incorrect' }]);
    case 'declined':
      throw new AppError(422, 'PHONE_DECLINED', 'This number cannot be used for verification. Use your own mobile number, not a virtual or shared one.');
    case 'expired':
      throw new AppError(422, 'CODE_EXPIRED', 'That code has expired. Request a new one.');
  }
}

// ---------------------------------------------------------------------------
// Step 2 — NIN + BVN (with the student ID card)
// ---------------------------------------------------------------------------

/** Both numbers must pass; a decline wins over "the registry didn't answer". */
function combine(checks: IdCheckResult[]): IdCheckResult {
  return checks.find((c) => c.outcome === 'declined') ?? checks.find((c) => c.outcome === 'in_review') ?? checks[0]!;
}

export async function submitKyc(userId: string, input: KycSubmission): Promise<KycState> {
  const user = await assertCanVerify(userId);
  // A verified rep whose wallet Bank78 couldn't open may submit again: the BVN
  // that opens it is never kept, so only the rep can supply it a second time.
  const walletRetry = user.kycStatus === 'verified' && !user.walletAccountNumber;
  if (user.kycStatus === 'verified' && !walletRetry) throw conflict('ALREADY_VERIFIED', 'Your identity is already verified');
  if (!user.phoneVerifiedAt || !user.phone) {
    throw conflict('PHONE_NOT_VERIFIED', 'Verify your phone number first');
  }
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
      { field: 'nin', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
    ]);
  }

  // 1. The student ID goes to private storage first, so a failure there
  //    doesn't leave a half-finished verification behind. A wallet retry keeps
  //    the card already under (or past) review.
  const stored = walletRetry ? null : await storeStudentId(user.id, input.studentId);

  // 2. The NIN, then the BVN, each checked against the registry. The BVN
  //    check is skipped (and not billed) when the NIN already failed.
  const names = splitName(user.name);
  const firstName = input.firstName ?? names.firstName;
  const lastName = input.lastName ?? names.lastName;
  const ask = (kind: IdKind, number: string) => verifyIdNumber({ userId: user.id, kind, number, firstName, lastName, dob: input.dob });
  let check: IdCheckResult;
  let ninRequestId: string | null;
  try {
    const nin = await ask('nin', input.nin);
    ninRequestId = nin.requestId;
    check = nin.outcome === 'approved' ? combine([nin, await ask('bvn', input.bvn)]) : nin;
  } catch (err) {
    await discardFile(stored?.fileId);
    // A 4xx means Didit refused the details as given; count it. Anything else
    // is Didit being unavailable — not the rep's fault.
    if (err instanceof DiditError && !err.retryable) {
      await recordFailedAttempt(user, err.message);
      throw new AppError(422, 'KYC_REJECTED', 'The verification details were not accepted. Check them and try again.');
    }
    throw unavailable();
  }

  const kycStatus: KycStatus = check.outcome === 'approved' ? 'verified' : check.outcome === 'declined' ? 'rejected' : 'pending';
  const attempts = kycStatus === 'rejected' ? user.kycAttempts + 1 : kycStatus === 'verified' ? 0 : user.kycAttempts;

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus,
      diditNinRequestId: ninRequestId,
      kycSubmittedAt: new Date(),
      // Kept for admins (the rep directory and application review).
      gender: input.gender,
      kycResolvedAt: kycStatus === 'pending' ? null : new Date(),
      kycRejectionReason:
        kycStatus === 'rejected'
          ? check.reason
          : kycStatus === 'pending'
            ? `The ${check.kind.toUpperCase()} registry did not answer. Submit again in a few minutes.`
            : null,
      kycAttempts: attempts,
      kycRetryLockedUntil: kycStatus === 'rejected' && attempts >= MAX_KYC_ATTEMPTS ? new Date(Date.now() + KYC_RETRY_LOCK_MS) : null,
      ...(stored
        ? {
            studentIdFileId: stored.fileId,
            studentIdFilePath: stored.filePath,
            studentIdMimeType: input.studentId.mimeType,
            studentIdStatus: 'pending' as const,
            studentIdUploadedAt: new Date(),
            studentIdReviewedAt: null,
            studentIdReviewedById: null,
            studentIdReviewNote: null,
          }
        : {}),
    },
  });
  if (stored && user.studentIdFileId && user.studentIdFileId !== stored.fileId) await discardFile(user.studentIdFileId);
  logger.info({ userId, providerRef: ninRequestId, kycStatus, walletRetry }, 'kyc submitted');

  // 3. Both numbers approved: open the rep's wallet. Bank78 needs the BVN for
  //    it. If Bank78 is unavailable the rep stays verified without a wallet,
  //    and submitting again retries it.
  let final = updated;
  if (kycStatus === 'verified') {
    final = (await openWallet(updated, { nin: input.nin, bvn: input.bvn, firstName, lastName }).catch((err) => {
      logger.warn({ userId, err: (err as Error).message }, 'wallet could not be opened — the rep can submit again');
      return null;
    })) ?? updated;
  }

  if (kycStatus !== 'pending' && !walletRetry) {
    await notify({
      userId: user.id,
      kind: 'system',
      tone: kycStatus === 'verified' ? 'brand' : 'rose',
      title: kycStatus === 'verified' ? 'Identity verified' : 'Identity verification failed',
      detail:
        kycStatus === 'verified'
          ? !user.isRep
            ? 'Your identity is verified. An admin will now review your rep application.'
            : 'Your identity is verified. Collection opens once your student ID is approved.'
          : `We could not verify your identity${check.reason ? `: ${check.reason}` : ''}. Please try again.`,
      href: '/dashboard/kyc',
    }).catch(() => {});
  }
  return toState(final);
}

/**
 * Open the verified rep's Bank78 wallet. Idempotent: Bank78 keys the
 * sub-account on our user id, so a retry finds the same one. The NIN and BVN
 * are passed straight through (Bank78 requires the BVN) and never kept.
 */
async function openWallet(user: User, ids: { nin: string; bvn: string; firstName: string; lastName: string }): Promise<User> {
  const wallet = await getPaymentProvider().createWallet({
    userId: user.id,
    firstName: ids.firstName,
    lastName: ids.lastName,
    email: user.email,
    phone: user.phone!,
    nin: ids.nin,
    bvn: ids.bvn,
  });
  const updated = await db.user.update({ where: { id: user.id }, data: { walletAccountNumber: wallet.accountNumber } });
  logger.info({ userId: user.id, wallet: wallet.accountNumber }, 'rep wallet opened');
  return updated;
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

// ---------------------------------------------------------------------------
// Admin: student ID review
// ---------------------------------------------------------------------------

type AdminKycFields = Pick<
  User,
  | 'kycStatus'
  | 'kycRejectionReason'
  | 'kycSubmittedAt'
  | 'kycResolvedAt'
  | 'studentIdStatus'
  | 'studentIdFilePath'
  | 'studentIdMimeType'
  | 'studentIdUploadedAt'
  | 'studentIdReviewedAt'
  | 'studentIdReviewNote'
>;

/** The KYC picture an admin needs next to a rep application: the Didit NIN verdict and the student ID card. */
export function adminKycSummary(u: AdminKycFields) {
  return {
    identity: {
      status: u.kycStatus,
      rejectionReason: u.kycRejectionReason,
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
