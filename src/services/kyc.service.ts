import { createHmac } from 'node:crypto';
import { Prisma, type DocumentReviewStatus, type KycStatus, type User } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from '../lib/notifications';
import { getFileStore } from '../lib/storage';
import { maskAccountNumber } from '../lib/encryption';
import { resolveBankDetails } from './beneficiary.service';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { getIdentityVerifier } from '../providers/identity';

/**
 * Rep identity verification (KYC). Gated steps, each requiring the last:
 *
 *  1. Phone — Didit texts a one-time code; entering it proves the rep holds
 *     the number. VoIP and disposable numbers are declined. One verified
 *     number per account, one account per number.
 *  2. BVN — Didit checks the BVN against the rep's name and date of birth in
 *     the national registry. One BVN per rep account (bvnHash).
 *  3. Kredi — only then is the rep registered as a Kredi customer, with the
 *     verified phone and the matched BVN.
 *
 * Separately, Duevy checks the rep is a student: the student ID card uploaded
 * with step 2 is stored privately (ImageKit) and an admin approves it, along
 * with the rep application. A space collects only once both are done.
 *
 * The BVN, date of birth and one-time code are NEVER persisted or logged.
 * Only bvnHash, a keyed one-way fingerprint, is kept. For the student ID we
 * keep only the storage reference.
 *
 * Students never do KYC; rep applicants do it as part of their application.
 */

/** §9.2 — three failed attempts lock retries for 24 hours. */
const MAX_KYC_ATTEMPTS = 3;
const KYC_RETRY_LOCK_MS = 24 * 60 * 60 * 1000;
/** How long an admin's link to a student ID image stays valid. */
const REVIEW_URL_TTL_SECONDS = 10 * 60;

/** One-time codes: Didit's codes live 5 minutes and it caps 4 sends per number per hour. */
const OTP_TTL_SECONDS = 5 * 60;
const OTP_RESEND_MS = 60 * 1000;
const OTP_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;

export interface UploadedDocument {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

export interface KycSubmission {
  bvn: string;
  dob: string; // YYYY-MM-DD
  gender: 'male' | 'female';
  /** The rep's residential address, as Kredi records it. Not stored by Duevy. */
  address: string;
  /** NDPR: the rep agreed to the BVN check. Must be true. */
  consent: true;
  /** The names on the rep's BVN, when they differ from the profile name. */
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

/** 08012345678 | 2348012345678 | +2348012345678 → +2348012345678; null if not a Nigerian mobile number. */
export function normaliseNigerianPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  const national = digits.startsWith('234') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[789][01]\d{8}$/.test(national) ? `+234${national}` : null;
}

/** +2348012345678 → +234 801 ••• 5678 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `${phone.slice(0, 4)} ${phone.slice(4, 7)} ••• ${phone.slice(-4)}`;
}

/** A keyed one-way fingerprint of a BVN: comparable, never reversible. */
export function bvnFingerprint(bvn: string): string {
  return createHmac('sha256', env.BVN_HASH_PEPPER as string).update(`bvn:${bvn}`).digest('hex');
}

type KycFields = Pick<User, 'kycStatus' | 'providerAccountId' | 'studentIdStatus'>;

/** Can this rep's spaces take payments? Phone + BVN verified, registered at Kredi, AND an admin approved the student ID. */
export function canCollect(user: KycFields): boolean {
  return user.kycStatus === 'verified' && !!user.providerAccountId && user.studentIdStatus === 'approved';
}

/** Can this rep withdraw? (Can collect, and payouts are enabled for them.) */
export function canWithdraw(user: KycFields & Pick<User, 'payoutsActive'>): boolean {
  return canCollect(user) && user.payoutsActive;
}

export interface KycState {
  kycStatus: KycStatus;
  payoutsActive: boolean;
  canCollect: boolean;
  canWithdraw: boolean;
  /** Where the rep is in the gated flow. */
  steps: {
    phone: { verified: boolean; number: string | null; pendingNumber: string | null; verifiedAt: string | null };
    bvn: { verified: boolean; verifiedAt: string | null };
    account: { created: boolean };
  };
  /** The rep's own bank account, kept for their reference; `null` until sent. */
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

/** The user fields {@link toState} reads, for loads that only need the KYC state. */
const KYC_STATE_SELECT = {
  kycStatus: true,
  providerAccountId: true,
  payoutsActive: true,
  verifiedPhone: true,
  phoneVerifiedAt: true,
  pendingPhone: true,
  bvnVerifiedAt: true,
  payoutDestinationSubmittedAt: true,
  payoutDestinationBankCode: true,
  payoutDestinationBankName: true,
  payoutDestinationAccountMasked: true,
  payoutDestinationAccountName: true,
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
    payoutsActive: u.payoutsActive,
    canCollect: canCollect(u),
    canWithdraw: canWithdraw(u),
    steps: {
      phone: {
        verified: !!u.phoneVerifiedAt,
        number: maskPhone(u.verifiedPhone),
        pendingNumber: maskPhone(u.pendingPhone),
        verifiedAt: u.phoneVerifiedAt?.toISOString() ?? null,
      },
      bvn: { verified: !!u.bvnVerifiedAt, verifiedAt: u.bvnVerifiedAt?.toISOString() ?? null },
      account: { created: !!u.providerAccountId },
    },
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
  steps: {
    phone: { verified: false, number: null, pendingNumber: null, verifiedAt: null },
    bvn: { verified: false, verifiedAt: null },
    account: { created: false },
  },
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

function assertRepOrApplicant(user: Pick<User, 'isRep' | 'repApplicationStatus'>): void {
  if (!isRepOrApplicant(user)) {
    throw forbidden('Only reps and rep applicants can verify their identity', 'REP_NOT_APPROVED');
  }
}

export async function getKycState(userId: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return toState(user);
}

/** KYC state of the space's lead rep — the rep accountable for its withdrawals. */
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

function isUniqueViolation(err: unknown, field: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta?.target ?? '').includes(field)
  );
}

// ---------------------------------------------------------------------------
// Step 1: phone
// ---------------------------------------------------------------------------

export interface PhoneCodeSent {
  sentTo: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/** Text a one-time code to the rep's mobile number. */
export async function sendPhoneCode(userId: string, rawPhone: string, ctx: { ip?: string; userAgent?: string } = {}): Promise<PhoneCodeSent> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  assertRepOrApplicant(user);
  // The verified number is the one Kredi holds for the rep; changing it is a support job.
  if (user.kycStatus === 'verified') {
    throw conflict('PHONE_LOCKED', 'Your phone number is part of your verified identity. Contact support to change it.');
  }
  const phone = normaliseNigerianPhone(rawPhone);
  if (!phone) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a Nigerian mobile number', [{ field: 'phone', issue: 'must be a Nigerian mobile number, e.g. 08012345678' }]);
  }
  if (user.verifiedPhone === phone && user.phoneVerifiedAt) throw conflict('PHONE_ALREADY_VERIFIED', 'This number is already verified');
  const owner = await db.user.findUnique({ where: { verifiedPhone: phone }, select: { id: true } });
  if (owner && owner.id !== user.id) throw conflict('PHONE_IN_USE', 'This number is already verified on another Duevy account');

  const now = Date.now();
  if (user.phoneOtpSentAt && now - user.phoneOtpSentAt.getTime() < OTP_RESEND_MS) {
    throw new AppError(429, 'OTP_RESEND_TOO_SOON', 'Wait a minute before asking for another code');
  }
  const windowOpen = user.phoneOtpWindowStartedAt && now - user.phoneOtpWindowStartedAt.getTime() < OTP_WINDOW_MS;
  const sends = windowOpen ? user.phoneOtpSendCount : 0;
  if (sends >= OTP_MAX_SENDS_PER_WINDOW) {
    throw new AppError(429, 'OTP_LIMIT', 'Too many codes requested. Try again in an hour.');
  }

  const outcome = await getIdentityVerifier().sendPhoneCode({ phone, vendorData: user.id, ip: ctx.ip, userAgent: ctx.userAgent });
  if (outcome === 'blocked') {
    throw new AppError(422, 'PHONE_NOT_ACCEPTED', "We can't send a code to this number. Use a different mobile number.");
  }
  await db.user.update({
    where: { id: user.id },
    data: {
      pendingPhone: phone,
      phoneOtpSentAt: new Date(now),
      phoneOtpSendCount: sends + 1,
      phoneOtpWindowStartedAt: windowOpen ? user.phoneOtpWindowStartedAt : new Date(now),
    },
  });
  logger.info({ userId }, 'phone verification code sent');
  return { sentTo: maskPhone(phone) as string, expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: OTP_RESEND_MS / 1000 };
}

/** Check the code the rep typed. On success the number becomes their verified phone. */
export async function verifyPhoneCode(userId: string, code: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  assertRepOrApplicant(user);
  if (!user.pendingPhone) throw conflict('NO_PENDING_PHONE', 'Ask for a verification code first');

  const result = await getIdentityVerifier().checkPhoneCode(user.pendingPhone, code);
  switch (result.outcome) {
    case 'wrong_code':
      throw new AppError(422, 'INVALID_OTP', result.message ?? 'The code is incorrect');
    case 'expired':
      throw new AppError(410, 'OTP_EXPIRED', 'This code has expired. Ask for a new one.');
    case 'declined':
      await db.user.update({ where: { id: user.id }, data: { pendingPhone: null } });
      throw new AppError(422, 'PHONE_DECLINED', "This number can't be used. Virtual and temporary numbers aren't accepted — use your own SIM.");
    case 'approved':
      break;
  }

  const phone = normaliseNigerianPhone(result.phone ?? user.pendingPhone) ?? user.pendingPhone;
  try {
    const updated = await db.user.update({
      where: { id: user.id },
      data: { verifiedPhone: phone, phone, phoneVerifiedAt: new Date(), pendingPhone: null, phoneOtpSendCount: 0, phoneOtpWindowStartedAt: null },
    });
    logger.info({ userId }, 'phone verified');
    return toState(updated);
  } catch (err) {
    if (isUniqueViolation(err, 'verifiedPhone')) throw conflict('PHONE_IN_USE', 'This number is already verified on another Duevy account');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Steps 2 and 3: BVN, then the Kredi customer
// ---------------------------------------------------------------------------

export async function submitKyc(userId: string, input: KycSubmission): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  assertRepOrApplicant(user);
  if (user.kycStatus === 'verified') throw conflict('ALREADY_VERIFIED', 'Your identity is already verified');
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    throw new AppError(429, 'KYC_RETRY_LOCKED', 'Too many failed attempts. Try again later.', [
      { field: 'bvn', issue: `locked until ${user.kycRetryLockedUntil.toISOString()}` },
    ]);
  }
  if (!user.phoneVerifiedAt || !user.verifiedPhone) {
    throw conflict('PHONE_NOT_VERIFIED', 'Verify your phone number first');
  }
  if (input.consent !== true) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Consent is required to check your BVN', [{ field: 'consent', issue: 'must be true' }]);
  }

  const bvnHash = bvnFingerprint(input.bvn);
  const holder = await db.user.findUnique({ where: { bvnHash }, select: { id: true } });
  if (holder && holder.id !== user.id) throw conflict('BVN_IN_USE', 'This BVN is already linked to another Duevy rep account');

  const names = splitName(user.name);
  const firstName = input.firstName ?? names.firstName;
  const lastName = input.lastName ?? names.lastName;

  // The student ID goes to private storage first, so a storage failure
  // doesn't leave a half-finished verification behind.
  const stored = await storeStudentId(user.id, input.studentId);
  const studentIdData = {
    studentIdFileId: stored.fileId,
    studentIdFilePath: stored.filePath,
    studentIdMimeType: input.studentId.mimeType,
    studentIdStatus: 'pending' as const,
    studentIdUploadedAt: new Date(),
    studentIdReviewedAt: null,
    studentIdReviewedById: null,
    studentIdReviewNote: null,
  };

  // Step 2 — Didit BVN match. Skipped when this same BVN already matched
  // (a resubmission after Kredi was briefly unavailable): it is billed per check.
  let diditRequestId = user.diditBvnRequestId;
  const alreadyMatched = !!user.bvnVerifiedAt && user.bvnHash === bvnHash;
  if (!alreadyMatched) {
    let bvn;
    try {
      bvn = await getIdentityVerifier().validateBvn({ bvn: input.bvn, firstName, lastName, dob: input.dob, vendorData: user.id });
    } catch (err) {
      await discardFile(stored.fileId);
      if (err instanceof ProviderError && err.retryable) {
        throw new AppError(503, 'VERIFICATION_UNAVAILABLE', "We couldn't reach the BVN registry. Try again in a few minutes.");
      }
      throw err;
    }
    if (bvn.outcome === 'unavailable') {
      await discardFile(stored.fileId);
      throw new AppError(503, 'VERIFICATION_UNAVAILABLE', "We couldn't reach the BVN registry. Try again in a few minutes.");
    }
    if (bvn.outcome === 'invalid') {
      await discardFile(stored.fileId);
      throw new AppError(422, 'BVN_INVALID', "That BVN wasn't recognised. Check the 11 digits and try again.", [{ field: 'bvn', issue: 'not recognised' }]);
    }
    if (bvn.outcome !== 'match') {
      await discardFile(stored.fileId);
      await recordFailedAttempt(user, "Your name or date of birth doesn't match your BVN record");
      logger.info({ userId, outcome: bvn.outcome, requestId: bvn.requestId }, 'bvn did not match');
      throw new AppError(
        422,
        'KYC_REJECTED',
        "Your name or date of birth doesn't match your BVN record. Check them (use the names on your BVN) and try again.",
      );
    }
    diditRequestId = bvn.requestId;
  }

  const verifiedFields = {
    bvnHash,
    bvnVerifiedAt: alreadyMatched ? user.bvnVerifiedAt : new Date(),
    diditBvnRequestId: diditRequestId,
    kycConsentAt: new Date(),
    kycSubmittedAt: new Date(),
    // Kept for admins (the rep directory and application review).
    gender: input.gender,
    ...studentIdData,
  };

  // Step 3 — the Kredi customer. Only ever reached with a verified phone and a matched BVN.
  let result;
  try {
    result = await getPaymentProvider().verifyIdentity({
      profile: {
        userId: user.id,
        email: user.email,
        firstName,
        lastName,
        displayName: user.name,
        phone: user.verifiedPhone,
      },
      idNumbers: [{ type: 'bvn', value: input.bvn }],
      gender: input.gender,
      address: input.address,
    });
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      // Kredi refused the details. The BVN match stands; the rep can fix and resubmit.
      await saveVerification(user, { ...verifiedFields, kycStatus: 'rejected', kycRejectionReason: err.message.slice(0, 300) });
      await recordFailedAttempt(user, err.message);
      await discardSuperseded(user, stored.fileId);
      throw new AppError(422, 'KYC_REJECTED', 'Our payment partner did not accept these details. Check them and try again.');
    }
    // Unavailable: keep the BVN match so resubmitting doesn't pay for a second check.
    await saveVerification(user, { ...verifiedFields, kycStatus: 'pending', kycRejectionReason: null });
    await discardSuperseded(user, stored.fileId);
    throw new AppError(503, 'ACCOUNT_SETUP_PENDING', "Your BVN is verified, but we couldn't finish setting up your account. Submit again in a few minutes.");
  }

  const updated = await saveVerification(user, {
    ...verifiedFields,
    providerAccountId: result.accountId,
    providerAccountNumber: result.accountNumber,
    kycStatus: 'verified',
    payoutsActive: result.payoutsActive,
    kycResolvedAt: new Date(),
    kycRejectionReason: null,
    kycAttempts: 0,
    kycRetryLockedUntil: null,
  });
  await discardSuperseded(user, stored.fileId);
  logger.info({ userId, providerRef: result.accountId, diditRequestId }, 'kyc verified');

  await notify({
    userId: user.id,
    kind: 'system',
    tone: 'brand',
    title: 'Identity verified',
    detail: !updated.isRep
      ? 'Your identity is verified. An admin will now review your student ID and rep application.'
      : updated.studentIdStatus === 'approved'
        ? 'Your spaces can now collect payments.'
        : 'Your identity is verified. Collection opens once your student ID is approved.',
    href: '/dashboard/kyc',
  }).catch(() => {});
  return toState(updated);
}

async function saveVerification(user: User, data: Prisma.UserUpdateInput): Promise<User> {
  try {
    return await db.user.update({ where: { id: user.id }, data });
  } catch (err) {
    if (isUniqueViolation(err, 'bvnHash')) throw conflict('BVN_IN_USE', 'This BVN is already linked to another Duevy rep account');
    throw err;
  }
}

async function discardSuperseded(user: User, keptFileId: string): Promise<void> {
  if (user.studentIdFileId && user.studentIdFileId !== keptFileId) await discardFile(user.studentIdFileId);
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

/**
 * Save the rep's own bank account, name-checked — the bank's name is what is
 * kept, with the number masked. For the rep's reference and the onboarding
 * checklist; withdrawals go to the space's beneficiaries.
 */
export async function submitPayoutDestination(userId: string, bankCode: string, accountNumber: string): Promise<KycState> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  assertRepOrApplicant(user);
  const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
  const updated = await db.user.update({
    where: { id: userId },
    data: {
      payoutDestinationBankCode: bankCode,
      payoutDestinationBankName: bankName,
      payoutDestinationAccountMasked: maskAccountNumber(accountNumber),
      payoutDestinationAccountName: accountName,
      payoutDestinationSubmittedAt: new Date(),
    },
  });
  logger.info({ userId, bank: bankCode, account: maskAccountNumber(accountNumber) }, 'payout destination saved');
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
      kycResolvedAt: new Date(),
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
  | 'verifiedPhone'
  | 'phoneVerifiedAt'
  | 'bvnVerifiedAt'
  | 'diditBvnRequestId'
  | 'providerAccountId'
  | 'kycResolvedAt'
  | 'studentIdStatus'
  | 'studentIdFilePath'
  | 'studentIdMimeType'
  | 'studentIdUploadedAt'
  | 'studentIdReviewedAt'
  | 'studentIdReviewNote'
>;

/**
 * The KYC picture an admin needs next to a rep application: the phone and BVN
 * checks (Didit — `diditBvnRequestId` opens the check in the Didit console),
 * the Kredi registration, and the student ID card.
 */
export function adminKycSummary(u: AdminKycFields) {
  return {
    identity: {
      status: u.kycStatus,
      rejectionReason: u.kycRejectionReason,
      submittedAt: u.kycSubmittedAt?.toISOString() ?? null,
      resolvedAt: u.kycResolvedAt?.toISOString() ?? null,
      phone: { number: maskPhone(u.verifiedPhone), verifiedAt: u.phoneVerifiedAt?.toISOString() ?? null },
      bvn: { verifiedAt: u.bvnVerifiedAt?.toISOString() ?? null, diditRequestId: u.diditBvnRequestId },
      kredi: { registered: !!u.providerAccountId },
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
