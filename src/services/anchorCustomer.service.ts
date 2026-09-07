import { type KycTier } from '@prisma/client';
import { db } from '../config/db';
import {
  AnchorApiError,
  createDepositAccount,
  createIndividualCustomer,
  getAccount,
  getCustomer,
  submitTier2Verification,
  submitTier3Verification,
  type AnchorIdType,
  type AnchorAddress,
  type Gender,
  type NigerianState,
} from '../lib/anchor';
import { notifyMany } from '../lib/notifications';

/**
 * Rep identity on Anchor.
 *
 * The rep is an Anchor IndividualCustomer; the space's deposit account is owned
 * by that customer record. Nothing can be collected until the customer clears
 * BVN verification, so this is the gate in front of the whole money path.
 *
 * Replaces connectAccount.service.ts, which was built on Bachs's
 * requirements/checklist/tasks/uploads/NIN model. Anchor needs none of that —
 * a customer record plus BVN + date of birth + gender.
 *
 * THE BVN IS NEVER PERSISTED (PRD §8). That is a deliberate constraint with a
 * consequence: we cannot silently re-submit a verification on the rep's behalf,
 * so `customer.identification.error` is recovered by re-reading Anchor's own
 * record rather than by replaying stored data.
 */

export class NoAnchorCustomerError extends Error {
  constructor() {
    super('This rep has not started identity verification yet');
    this.name = 'NoAnchorCustomerError';
  }
}

export class KycNotVerifiedError extends Error {
  constructor() {
    super('Identity verification must be completed before this space can collect payments');
    this.name = 'KycNotVerifiedError';
  }
}

/** §9.2 — three consecutive failures lock retries for 24 hours. */
const MAX_KYC_ATTEMPTS = 3;
const KYC_RETRY_LOCK_MS = 24 * 60 * 60 * 1000;

/** Anchor takes a first/last name pair; our User model carries one free-text name. */
function splitName(fullName: string): { firstName: string; lastName: string; middleName?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Unknown', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return {
    firstName: parts[0] as string,
    lastName: parts[parts.length - 1] as string,
    ...(parts.length > 2 ? { middleName: parts.slice(1, -1).join(' ') } : {}),
  };
}

export interface KycSubmission {
  bvn: string;
  dateOfBirth: string; // YYYY-MM-DD
  gender: Gender;
  phone: string;
  address: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: NigerianState;
    postalCode?: string;
  };
}

export type KycSubmitOutcome =
  | { ok: true }
  | { ok: false; code: 'RETRY_LOCKED'; retryAfter: Date }
  | { ok: false; code: 'ALREADY_VERIFIED' }
  | { ok: false; code: 'PROVIDER_ERROR'; message: string };

/**
 * Creates the rep's Anchor customer if needed, then submits BVN verification.
 *
 * The customer is created here rather than at admin approval because Anchor
 * requires a full address at creation, and KYC submission is the first point we
 * hold one.
 *
 * Asynchronous by design: a success here only means Anchor accepted the check.
 * The outcome lands on the customer.identification.* webhooks.
 */
export async function submitRepKyc(userId: string, input: KycSubmission): Promise<KycSubmitOutcome> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('user not found');

  if (user.kycStatus === 'verified') return { ok: false, code: 'ALREADY_VERIFIED' };
  if (user.kycRetryLockedUntil && user.kycRetryLockedUntil > new Date()) {
    return { ok: false, code: 'RETRY_LOCKED', retryAfter: user.kycRetryLockedUntil };
  }

  const address: AnchorAddress = {
    addressLine_1: input.address.addressLine1,
    ...(input.address.addressLine2 ? { addressLine_2: input.address.addressLine2 } : {}),
    country: 'NG',
    city: input.address.city,
    state: input.address.state,
    // Anchor requires the field but accepts "NA"; most Nigerian addresses have none.
    postalCode: input.address.postalCode ?? 'NA',
  };

  try {
    let customerId = user.anchorCustomerId;
    if (!customerId) {
      const created = await createIndividualCustomer({
        ...splitName(user.name),
        email: user.email,
        phoneNumber: input.phone,
        address,
      });
      customerId = created.id;
    }

    // Persist the customer id and address BEFORE submitting, so a crash between
    // the two calls doesn't orphan a customer we'd then recreate on retry.
    await db.user.update({
      where: { id: userId },
      data: {
        anchorCustomerId: customerId,
        phone: input.phone,
        addressLine1: input.address.addressLine1,
        addressLine2: input.address.addressLine2 ?? null,
        city: input.address.city,
        state: input.address.state,
        postalCode: address.postalCode,
      },
    });

    await submitTier2Verification(customerId, {
      bvn: input.bvn,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
    });

    await db.user.update({
      where: { id: userId },
      data: {
        kycStatus: 'pending',
        kycPendingTier: 'tier_2',
        kycSubmittedAt: new Date(),
        kycRejectionReason: null,
        kycAttempts: { increment: 1 },
      },
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof AnchorApiError) {
      console.error(`[kyc] submission failed for user ${userId}:`, err.message);
      return { ok: false, code: 'PROVIDER_ERROR', message: err.detail ?? err.message };
    }
    throw err;
  }
}

export type KycUpgradeOutcome =
  | { ok: true }
  | { ok: false; code: 'NOT_VERIFIED' }
  | { ok: false; code: 'ALREADY_AT_TIER' }
  | { ok: false; code: 'UPGRADE_PENDING' }
  | { ok: false; code: 'PROVIDER_ERROR'; message: string };

/**
 * Raise a verified rep from tier_2 to tier_3 (PRD §3.4 / §12 — the deferred
 * tier-upgrade path, whose trigger is reps repeatedly hitting the balance
 * ceiling).
 *
 * Unlike the initial check this is a MANUAL review at Anchor, so it can sit
 * unresolved for days. Everything here is therefore additive: the rep keeps
 * collecting on tier_2 throughout, and only `kycPendingTier` moves. A rejection
 * clears that and leaves the account exactly as it was.
 *
 * The document number is sent to Anchor and never persisted, for the same
 * reason the BVN is not (PRD §8).
 */
export async function submitKycUpgrade(
  userId: string,
  input: { idType: AnchorIdType; idNumber: string; expiryDate?: string },
): Promise<KycUpgradeOutcome> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('user not found');

  // An upgrade builds on an existing verified customer; there is nothing to
  // raise otherwise, and the rep should complete tier_2 first.
  if (user.kycStatus !== 'verified' || !user.anchorCustomerId) return { ok: false, code: 'NOT_VERIFIED' };
  if (user.kycTier === 'tier_3') return { ok: false, code: 'ALREADY_AT_TIER' };
  if (user.kycPendingTier === 'tier_3') return { ok: false, code: 'UPGRADE_PENDING' };

  try {
    await submitTier3Verification(user.anchorCustomerId, input);
    await db.user.update({
      where: { id: userId },
      // kycStatus deliberately untouched — see the note above.
      data: { kycPendingTier: 'tier_3', kycSubmittedAt: new Date(), kycRejectionReason: null },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AnchorApiError) {
      console.error(`[kyc] upgrade failed for user ${userId}:`, err.message);
      return { ok: false, code: 'PROVIDER_ERROR', message: err.detail ?? err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Webhook appliers. Anchor addresses these by customer id, so each resolves the
// user first and no-ops on a customer we don't know — a webhook for another
// integration on the same organisation must not throw.
// ---------------------------------------------------------------------------

async function userByCustomerId(customerId: string) {
  return db.user.findUnique({ where: { anchorCustomerId: customerId } });
}

export async function applyKycApproved(customerId: string): Promise<void> {
  const user = await userByCustomerId(customerId);
  if (!user) return;

  // An approval promotes the rep to whatever tier was awaiting a decision. An
  // already-verified rep is NOT an early return here: that is exactly the
  // tier_2 → tier_3 upgrade case, and skipping it would leave them capped.
  const promotedTo = user.kycPendingTier ?? (user.kycStatus === 'verified' ? user.kycTier : 'tier_2');
  const wasUpgrade = user.kycStatus === 'verified';
  if (wasUpgrade && promotedTo === user.kycTier) return; // nothing changed

  await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus: 'verified',
      kycTier: promotedTo,
      kycPendingTier: null,
      kycResolvedAt: new Date(),
      kycRejectionReason: null,
      kycAttempts: 0,
      kycRetryLockedUntil: null,
    },
  });

  if (wasUpgrade) {
    await notifyMany([user.id], {
      kind: 'system',
      title: 'Verification upgraded',
      detail: 'Your account limits have been raised.',
      href: '/dashboard/payout',
    });
    return; // the space is already provisioned; nothing else to do
  }

  // Provision every space this rep leads. Driven from here rather than the
  // client so a rep who closed the tab still ends up set up (PRD §6.2).
  const led = await db.spaceRep.findMany({ where: { userId: user.id, role: 'lead' }, select: { spaceId: true } });
  for (const { spaceId } of led) {
    await provisionSpaceAccount(spaceId).catch((err) =>
      console.error(`[kyc] provisioning space ${spaceId} failed:`, err),
    );
  }

  await notifyMany([user.id], {
    kind: 'system',
    title: "You're verified",
    detail: 'Your space can now collect payments.',
    href: '/dashboard/payout',
  });
}

export async function applyKycRejected(customerId: string, reason?: string): Promise<void> {
  const user = await userByCustomerId(customerId);
  if (!user) return;

  // A failed UPGRADE must not revoke a working account: the rep stays verified
  // at the tier they already hold, and only the pending upgrade is cleared.
  if (user.kycStatus === 'verified' && user.kycPendingTier && user.kycPendingTier !== user.kycTier) {
    await db.user.update({
      where: { id: user.id },
      data: { kycPendingTier: null, kycRejectionReason: reason ?? 'The document could not be verified.' },
    });
    await notifyMany([user.id], {
      kind: 'system',
      tone: 'amber',
      title: 'Upgrade declined',
      detail: 'Your existing verification is unaffected. You can try again with a different document.',
      href: '/dashboard/payout',
    });
    return;
  }

  const attempts = user.kycAttempts;
  const locked = attempts >= MAX_KYC_ATTEMPTS;

  await db.user.update({
    where: { id: user.id },
    data: {
      kycStatus: 'rejected',
      kycPendingTier: null,
      kycResolvedAt: new Date(),
      // BVN name/phone mismatch is the dominant rejection cause, and Anchor's
      // own comment is rarely specific enough to act on (PRD §9.2).
      kycRejectionReason:
        reason ??
        'The details did not match your BVN. Use the name and phone number registered on your BVN and try again.',
      ...(locked ? { kycRetryLockedUntil: new Date(Date.now() + KYC_RETRY_LOCK_MS) } : {}),
    },
  });

  await notifyMany([user.id], {
    kind: 'system',
    tone: 'rose',
    title: 'Verification failed',
    detail: locked
      ? 'Too many attempts. You can try again in 24 hours.'
      : 'We could not verify your identity. Check your details and try again.',
    href: '/dashboard/payout',
  });

  if (locked) console.error(`[kyc] user ${user.id} locked out after ${attempts} failed attempts`);
}

export async function applyKycPending(customerId: string): Promise<void> {
  const user = await userByCustomerId(customerId);
  // A verified rep mid-upgrade stays verified — tier_3 is a manual review and
  // can sit at .manualReview / .awaitingDocument for days. Flipping them to
  // `pending` would stop their space collecting for the duration.
  if (!user || user.kycStatus === 'verified') return;
  await db.user.update({ where: { id: user.id }, data: { kycStatus: 'pending' } });
}

/**
 * `customer.identification.error` is transient — the check itself failed, not
 * the rep's details. Because we hold no BVN we cannot re-submit, so recovery is
 * to re-read Anchor's own record on a backoff and adopt whatever it settled on.
 * If it is still unresolved after the last attempt the rep stays `pending` and
 * sees "Still verifying", never a demand to do something (PRD §3.4).
 */
const KYC_RECHECK_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

export async function scheduleKycRecheck(customerId: string, attempt = 0): Promise<void> {
  const delay = KYC_RECHECK_DELAYS_MS[attempt];
  if (delay === undefined) return;

  setTimeout(() => {
    void recheckKyc(customerId, attempt);
  }, delay).unref();
}

async function recheckKyc(customerId: string, attempt: number): Promise<void> {
  try {
    const customer = await getCustomer(customerId);
    const status = customer?.attributes.verification?.status;

    if (status === 'approved') return void (await applyKycApproved(customerId));
    if (status === 'rejected') {
      return void (await applyKycRejected(customerId, customer?.attributes.verification?.comment));
    }
    await scheduleKycRecheck(customerId, attempt + 1);
  } catch (err) {
    console.error(`[kyc] recheck for ${customerId} failed:`, err);
    await scheduleKycRecheck(customerId, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// Deposit account provisioning
// ---------------------------------------------------------------------------

/**
 * Creates the space's collecting account against its lead rep's verified
 * customer. Idempotent — returns the existing account id if one is already
 * stored. The account NUMBER is assigned asynchronously by Anchor, so a null
 * `anchorAccountNumber` here is normal and is filled in by the account.opened
 * webhook or by resolveSpaceAccountNumber().
 */
export async function provisionSpaceAccount(spaceId: string): Promise<string | null> {
  const space = await db.space.findUnique({ where: { id: spaceId }, select: { id: true, anchorAccountId: true } });
  if (!space) return null;
  if (space.anchorAccountId) {
    await resolveSpaceAccountNumber(spaceId).catch(() => {});
    return space.anchorAccountId;
  }

  const lead = await db.spaceRep.findFirst({
    where: { spaceId, role: 'lead' },
    include: { user: { select: { id: true, anchorCustomerId: true, kycStatus: true } } },
  });
  if (!lead?.user.anchorCustomerId || lead.user.kycStatus !== 'verified') return null;

  try {
    const account = await createDepositAccount(lead.user.anchorCustomerId);
    await db.space.update({
      where: { id: spaceId },
      data: {
        anchorAccountId: account.id,
        anchorAccountStatus: account.attributes.status,
        anchorAccountNumber: account.attributes.accountNumber ?? null,
        anchorBankName: account.attributes.bank?.name ?? account.attributes.bankName ?? null,
      },
    });
    await resolveSpaceAccountNumber(spaceId).catch(() => {});
    return account.id;
  } catch (err) {
    if (err instanceof AnchorApiError && err.isKycIncomplete) {
      console.error(`[anchor] space ${spaceId} not provisioned — customer KYC incomplete`);
      return null;
    }
    throw err;
  }
}

/** Fills in the NUBAN once Anchor has assigned it. Safe to call repeatedly. */
export async function resolveSpaceAccountNumber(spaceId: string): Promise<string | null> {
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: { anchorAccountId: true, anchorAccountNumber: true },
  });
  if (!space?.anchorAccountId) return null;
  if (space.anchorAccountNumber) return space.anchorAccountNumber;

  const account = await getAccount(space.anchorAccountId);
  const accountNumber = account?.attributes.accountNumber;
  if (!accountNumber) return null;

  await db.space.update({
    where: { id: spaceId },
    data: {
      anchorAccountNumber: accountNumber,
      anchorBankName: account?.attributes.bank?.name ?? account?.attributes.bankName ?? null,
      anchorAccountStatus: account?.attributes.status ?? null,
    },
  });
  return accountNumber;
}

/** account.opened / accountNumber.created — Anchor addresses these by account id. */
export async function applyAccountOpened(accountId: string): Promise<void> {
  const space = await db.space.findUnique({ where: { anchorAccountId: accountId }, select: { id: true } });
  if (!space) return;
  await resolveSpaceAccountNumber(space.id);
}

// ---------------------------------------------------------------------------
// Read model for the dashboard's verification banner
// ---------------------------------------------------------------------------

export interface KycState {
  kycStatus: string;
  /** The tier actually verified, and the one under review (null when none is). */
  kycTier: KycTier;
  pendingTier: KycTier | null;
  /** True once tier_3 is available to submit — i.e. verified and not already there. */
  canUpgrade: boolean;
  rejectionReason: string | null;
  retryLockedUntil: string | null;
  submittedAt: string | null;
  accountProvisioned: boolean;
  accountNumber: string | null;
  bankName: string | null;
  canCollect: boolean;
}

export async function getSpaceKycState(spaceId: string): Promise<KycState> {
  const [space, lead] = await Promise.all([
    db.space.findUnique({
      where: { id: spaceId },
      select: { anchorAccountId: true, anchorAccountNumber: true, anchorBankName: true },
    }),
    db.spaceRep.findFirst({
      where: { spaceId, role: 'lead' },
      include: {
        user: {
          select: {
            kycStatus: true,
            kycTier: true,
            kycPendingTier: true,
            kycRejectionReason: true,
            kycRetryLockedUntil: true,
            kycSubmittedAt: true,
          },
        },
      },
    }),
  ]);

  const kycStatus = lead?.user.kycStatus ?? 'unverified';
  const kycTier = lead?.user.kycTier ?? 'tier_0';
  const pendingTier = lead?.user.kycPendingTier ?? null;
  return {
    kycStatus,
    kycTier,
    pendingTier,
    canUpgrade: kycStatus === 'verified' && kycTier !== 'tier_3' && pendingTier === null,
    rejectionReason: lead?.user.kycRejectionReason ?? null,
    retryLockedUntil: lead?.user.kycRetryLockedUntil?.toISOString() ?? null,
    submittedAt: lead?.user.kycSubmittedAt?.toISOString() ?? null,
    accountProvisioned: !!space?.anchorAccountId,
    accountNumber: space?.anchorAccountNumber ?? null,
    bankName: space?.anchorBankName ?? null,
    // The single gate the rest of the app checks before taking money.
    canCollect: kycStatus === 'verified' && !!space?.anchorAccountId,
  };
}

/** Throws unless the space is fully provisioned — used ahead of any collection. */
export async function requireCollectableAccount(
  spaceId: string,
): Promise<{ accountId: string; customerId: string }> {
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: {
      anchorAccountId: true,
      reps: { where: { role: 'lead' }, select: { user: { select: { anchorCustomerId: true } } }, take: 1 },
    },
  });
  // Both are required by POST /api/v2/virtual-nubans. They are provisioned
  // together by the KYC webhook, so one without the other means a partial
  // provision rather than an un-onboarded space — either way, not collectable.
  const customerId = space?.reps[0]?.user.anchorCustomerId;
  if (!space?.anchorAccountId || !customerId) throw new KycNotVerifiedError();
  return { accountId: space.anchorAccountId, customerId };
}
