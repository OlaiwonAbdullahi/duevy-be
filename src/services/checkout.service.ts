import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type Checkout, type CheckoutItem, type CheckoutStatus } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { allocate, checkoutFee, generateReceiptNumber, generateReference } from '../lib/money';
import { assertCheckoutTransition, canTransitionCheckout } from '../lib/stateMachine';
import { notifyMany } from '../lib/notifications';
import { sendDuePaymentReceiptEmail } from '../lib/email';
import { generateId } from '../lib/id';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { appendLedgerEntry, lockSpace } from './ledger.service';
import { canCollect } from './kyc.service';

/**
 * Checkout: a student selects one or more dues from ONE space and pays them
 * with ONE bank transfer into a one-time Bank78 account opened for this checkout.
 *
 *   face  = Σ due amounts            → credited to the space in full
 *   fee   = 1.5% of face + Bank78's  → paid by the student on top
 *   total = face + fee               → what the student transfers
 *
 * The transfer lands in Duevy's Bank78 merchant account. Once paid, the face
 * amount is routed into the lead rep's wallet (routeCheckoutFunds); the fee
 * stays behind.
 *
 * Every amount is computed here, from the dues in the database. Nothing about
 * money is read from the request.
 *
 * Status: pending → paid | expired | underpaid (src/lib/stateMachine.ts).
 * The webhook is the source of truth for the outcome; the reconciliation job
 * is its backstop. Both funnel into the idempotent functions at the bottom.
 */

type Tx = Prisma.TransactionClient;
type CheckoutWithItems = Checkout & { items: (CheckoutItem & { due: { title: string } })[] };

const MAX_DUES_PER_CHECKOUT = 20;
/** A pending checkout younger than this with no bank account yet is still being opened. */
const OPENING_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeCheckout(c: CheckoutWithItems) {
  const open = c.status === 'pending' && !!c.vaAccountNumber;
  const hosted = c.status === 'pending' && !!c.checkoutUrl;
  return {
    reference: c.reference,
    status: c.status,
    spaceId: c.spaceId,
    amount: c.totalKobo,
    breakdown: { face: c.faceKobo, fee: c.feeKobo, total: c.totalKobo },
    items: c.items.map((i) => ({ dueId: i.dueId, title: i.due.title, amount: i.faceKobo, fee: i.feeKobo })),
    // Set on a hosted checkout: redirect the student here to pay.
    checkoutUrl: hosted ? c.checkoutUrl : null,
    bankTransfer: open
      ? {
          accountNumber: c.vaAccountNumber,
          bankName: c.vaBankName ?? '',
          accountName: c.vaAccountName ?? '',
          amountKobo: c.totalKobo,
          expiresAt: c.expiresAt.toISOString(),
        }
      : null,
    receivedKobo: c.receivedKobo,
    overpaidKobo: c.overpaidKobo,
    expiresAt: c.expiresAt.toISOString(),
    paidAt: c.paidAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

const withItems = { items: { include: { due: { select: { title: true } } } } } as const;

/** Pass the transaction client when inside one, so this doesn't hold a second pool connection. */
async function uniqueCheckoutReference(client: Tx = db): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generateReference();
    const [c, t] = await Promise.all([
      client.checkout.findUnique({ where: { reference: ref }, select: { id: true } }),
      client.transaction.findUnique({ where: { reference: ref }, select: { id: true } }),
    ]);
    if (!c && !t) return ref;
  }
  throw new Error('could not allocate a unique checkout reference');
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CheckoutResult {
  checkout: ReturnType<typeof serializeCheckout>;
  reused: boolean;
}

/**
 * Proof that the caller started this guest checkout. Guests have no session,
 * so the status page and receipt are unlocked by this token instead: an HMAC
 * of the reference, handed back only to whoever created the checkout.
 */
export function guestCheckoutToken(reference: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(`guest-checkout:${reference}`).digest('base64url');
}

export function isValidGuestCheckoutToken(reference: string, token: string): boolean {
  const expected = Buffer.from(guestCheckoutToken(reference));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface CreateCheckoutOptions {
  /**
   * A guest payer (no account, no membership). Allowed only on dues the rep
   * has opened to guests.
   */
  guest?: boolean;
}

export async function createCheckout(
  userId: string,
  requestedDueIds: string[],
  opts: CreateCheckoutOptions = {},
): Promise<CheckoutResult> {
  const dueIds = [...new Set(requestedDueIds)];
  if (dueIds.length === 0 || dueIds.length > MAX_DUES_PER_CHECKOUT) {
    throw new AppError(400, 'VALIDATION_ERROR', `Select between 1 and ${MAX_DUES_PER_CHECKOUT} dues`);
  }

  const [user, dues] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    db.due.findMany({
      where: { id: { in: dueIds } },
      include: { space: { select: { id: true, name: true, isArchived: true } } },
    }),
  ]);
  if (!user) throw notFound('User not found');
  if (dues.length !== dueIds.length) throw notFound('One or more dues could not be found');

  const spaceIds = new Set(dues.map((d) => d.spaceId));
  if (spaceIds.size > 1) {
    throw new AppError(422, 'MIXED_SPACES', 'Dues from different spaces must be paid separately');
  }
  const space = dues[0]!.space;
  if (space.isArchived) throw conflict('SPACE_ARCHIVED', 'This space is no longer collecting payments');

  const notPayable = dues.find((d) => d.status !== 'active');
  if (notPayable) throw conflict('DUE_NOT_PAYABLE', `"${notPayable.title}" is not open for payment`);

  // Independent lookups, checked below in the same order as before.
  const [member, paid, lead] = await Promise.all([
    db.spaceMembership.findUnique({ where: { userId_spaceId: { userId, spaceId: space.id } }, select: { userId: true } }),
    db.duePayment.findFirst({
      where: { userId, dueId: { in: dueIds } },
      include: { due: { select: { title: true } } },
    }),
    db.spaceRep.findFirst({
      where: { spaceId: space.id, role: 'lead' },
      include: { user: { select: { kycStatus: true, walletAccountNumber: true, studentIdStatus: true } } },
    }),
  ]);

  if (opts.guest) {
    // Guests skip membership, but only for dues the rep opened to guests.
    const closed = dues.find((d) => !d.allowGuests);
    if (closed) throw forbidden(`"${closed.title}" can only be paid by members of ${space.name}`, 'GUESTS_NOT_ALLOWED');
  } else if (!member) {
    // Members only: the payer must have joined the space.
    throw forbidden('Join this space with its code before paying', 'NOT_A_MEMBER');
  }

  if (paid) throw conflict('DUE_ALREADY_PAID', `"${paid.due.title}" has already been paid`);

  // Collections are routed into the lead rep's wallet, so the space can only
  // collect once that rep has passed KYC.
  if (!lead || !canCollect(lead.user)) {
    throw conflict('SPACE_NOT_VERIFIED', "This space can't take payments yet — its rep hasn't completed verification");
  }

  const dueSetKey = [...dueIds].sort().join(',');

  // Serialise checkout creation per student so two tabs can't open two
  // accounts for the same due.
  const outcome = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'checkout:' + userId}, 0))`;

    const open = await tx.checkout.findMany({
      where: { userId, status: 'pending', expiresAt: { gt: new Date() }, items: { some: { dueId: { in: dueIds } } } },
      include: withItems,
    });
    const same = open.find((c) => c.dueSetKey === dueSetKey);
    if (same) return { checkout: same, reused: true };
    if (open.length > 0) {
      throw conflict(
        'CHECKOUT_OVERLAP',
        `Some of these dues are already in an open payment (${open[0]!.reference}). Pay or wait for it to expire first.`,
      );
    }

    const face = dues.reduce((sum, d) => sum + d.amount, 0);
    const fee = checkoutFee(face);
    const ordered = dueIds.map((id) => dues.find((d) => d.id === id)!);
    const feeShares = allocate(fee, ordered.map((d) => d.amount));
    const reference = await uniqueCheckoutReference(tx);
    const title = ordered.length === 1 ? ordered[0]!.title : `${ordered.length} dues`;

    const checkout = await tx.checkout.create({
      data: {
        id: generateId('checkout'),
        reference,
        userId,
        spaceId: space.id,
        faceKobo: face,
        feeKobo: fee,
        totalKobo: face + fee,
        dueSetKey,
        provider: getPaymentProvider().name,
        // Provisional; replaced by the provider's own expiry once the account opens.
        expiresAt: new Date(Date.now() + env.CHECKOUT_EXPIRY_MINUTES * 60_000),
        items: {
          create: ordered.map((d, i) => ({ dueId: d.id, faceKobo: d.amount, feeKobo: feeShares[i]! })),
        },
      },
      include: withItems,
    });
    // The student's transaction history row, completed on payment.
    await tx.transaction.create({
      data: {
        userId,
        type: 'due',
        title,
        detail: space.name,
        amount: -(face + fee),
        method: 'Bank transfer',
        status: 'pending',
        reference,
        spaceId: space.id,
      },
    });
    return { checkout, reused: false };
  });

  const checkout = outcome.checkout.vaAccountNumber
    ? outcome.checkout
    : await openCollectionAccount(outcome.checkout, user, outcome.reused);

  logger.info({ ref: checkout.reference, userId, spaceId: checkout.spaceId, total: checkout.totalKobo, reused: outcome.reused }, 'checkout ready');
  return { checkout: serializeCheckout(checkout), reused: outcome.reused };
}

/**
 * Ask the provider for the one-time account. Safe to call again for the same
 * checkout: the account is reserved under our reference, so a retry picks up
 * the same account rather than opening a second one.
 */
async function openCollectionAccount(
  checkout: CheckoutWithItems,
  user: { email: string; name: string },
  reused: boolean,
): Promise<CheckoutWithItems> {
  if (reused && Date.now() - checkout.createdAt.getTime() < OPENING_GRACE_MS) {
    throw conflict('CHECKOUT_OPENING', 'This payment is still being set up. Try again in a few seconds.');
  }

  try {
    const account = await getPaymentProvider().createCollectionAccount({
      reference: checkout.reference,
      faceKobo: checkout.faceKobo,
      platformFeeKobo: checkout.feeKobo,
      customer: { email: user.email, name: user.name },
      expiresInMinutes: env.CHECKOUT_EXPIRY_MINUTES,
      metadata: { checkoutId: checkout.id, spaceId: checkout.spaceId, dueCount: String(checkout.items.length) },
    });
    if (account.totalKobo !== checkout.totalKobo) {
      throw new ProviderError('Provider total does not match the checkout total', null, 'PRICE_MISMATCH', false);
    }
    return await db.checkout.update({
      where: { id: checkout.id },
      data: {
        providerCheckoutId: account.providerCheckoutId,
        providerChargeId: account.providerChargeId,
        vaAccountNumber: account.accountNumber,
        vaBankName: account.bankName,
        vaAccountName: account.accountName,
        expiresAt: account.expiresAt,
      },
      include: withItems,
    });
  } catch (err) {
    // A definite refusal closes the checkout so the student can start again.
    // A timeout/5xx leaves it pending: the account may exist, and the next
    // attempt (or reconciliation) replays the same idempotent calls.
    if (err instanceof ProviderError && !err.retryable) {
      await expireCheckout(checkout.id, `provider refused: ${err.code ?? err.message}`).catch(() => {});
    }
    logger.error({ ref: checkout.reference, code: err instanceof ProviderError ? err.code : undefined }, 'could not open checkout account');
    throw err;
  }
}

/** A guest checkout's status, for whoever holds its token. */
export async function getGuestCheckout(reference: string, token: string) {
  if (!isValidGuestCheckoutToken(reference, token)) throw notFound('Payment not found');
  const checkout = await db.checkout.findUnique({
    where: { reference },
    include: { ...withItems, receipt: { select: { number: true } } },
  });
  if (!checkout) throw notFound('Payment not found');
  return { ...serializeCheckout(checkout), receiptNumber: checkout.receipt?.number ?? null, userId: checkout.userId };
}

export async function getCheckoutForUser(reference: string, userId: string) {
  const checkout = await db.checkout.findUnique({ where: { reference }, include: withItems });
  if (!checkout || checkout.userId !== userId) throw notFound('Payment not found');
  return serializeCheckout(checkout);
}

// ---------------------------------------------------------------------------
// Outcomes — shared by the webhook processor and reconciliation. Every one is
// idempotent: it locks the checkout row, checks the state machine, and
// no-ops if the transition has already happened.
// ---------------------------------------------------------------------------

export class CheckoutNotFoundError extends Error {
  constructor(public readonly lookup: string) {
    super(`No checkout matches ${lookup}`);
    this.name = 'CheckoutNotFoundError';
  }
}

export async function findCheckoutId(reference: string | null, providerCheckoutId: string | null): Promise<string> {
  if (reference) {
    const c = await db.checkout.findUnique({ where: { reference }, select: { id: true } });
    if (c) return c.id;
  }
  if (providerCheckoutId) {
    const c = await db.checkout.findUnique({ where: { providerCheckoutId }, select: { id: true } });
    if (c) return c.id;
  }
  throw new CheckoutNotFoundError(reference ?? providerCheckoutId ?? 'an event with no reference');
}

async function lockCheckout(tx: Tx, checkoutId: string): Promise<Checkout> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "checkouts" WHERE "id" = ${checkoutId} FOR UPDATE`;
  if (rows.length === 0) throw new CheckoutNotFoundError(checkoutId);
  return tx.checkout.findUniqueOrThrow({ where: { id: checkoutId } });
}

export type FulfilOutcome = 'paid' | 'already_paid' | 'underpaid';

/**
 * Money arrived. If it covers the total: mark every due paid, credit the
 * space's ledger at face value, complete the transaction, issue the receipt.
 *
 * - Overpaid: honoured, the excess recorded and flagged (no self-service refunds).
 * - Short (an ACCEPTED partial): treated as underpaid, dues stay unpaid.
 * - After expiry: honoured (the money left the student's bank), flagged.
 * - A due already paid through another checkout: skipped, flagged as a
 *   duplicate payment for a manual refund.
 */
export async function fulfilCheckout(
  checkoutId: string,
  receivedKobo: number,
  overpaidKobo = 0,
  source = 'webhook',
  /** The provider charge the money arrived on, when the event names one. */
  providerChargeId: string | null = null,
): Promise<FulfilOutcome> {
  const result = await db.$transaction(
    async (tx) => {
      const checkout = await lockCheckout(tx, checkoutId);
      if (checkout.status === 'paid') {
        // A payment on a different charge than the one that paid this checkout
        // is a second payment, not a replay: keep it in front of an admin.
        if (providerChargeId && checkout.providerChargeId && providerChargeId !== checkout.providerChargeId) {
          const flag = `another payment of ${receivedKobo} kobo arrived on charge ${providerChargeId} after it was paid`;
          await tx.checkout.update({
            where: { id: checkoutId },
            data: { needsReview: true, reviewReason: checkout.reviewReason ? `${checkout.reviewReason}; ${flag}` : flag },
          });
          return { outcome: 'already_paid' as const, checkout, flags: [flag] };
        }
        return { outcome: 'already_paid' as const, checkout, flags: [] as string[] };
      }

      if (receivedKobo < checkout.totalKobo) {
        return { outcome: 'short' as const, checkout, flags: [] as string[] };
      }
      assertCheckoutTransition(checkout.status, 'paid');

      const flags: string[] = [];
      const excess = Math.max(overpaidKobo, receivedKobo - checkout.totalKobo);
      if (excess > 0) flags.push(`overpaid by ${excess} kobo`);
      if (checkout.status === 'expired') flags.push('paid after the checkout expired');
      if (checkout.status === 'underpaid') flags.push('previously underpaid, later accepted');

      await lockSpace(tx, checkout.spaceId);
      const items = await tx.checkoutItem.findMany({ where: { checkoutId }, include: { due: true } });
      const txn = await tx.transaction.findUnique({ where: { reference: checkout.reference } });
      // DuePayment.txnId is unique, so the checkout's one transaction row is
      // linked to its first due line only (the legacy receipt route reads it).
      let txnToLink = txn && !(await tx.duePayment.findUnique({ where: { txnId: txn.id } })) ? txn.id : null;

      // One query for every line's existing payment, instead of one per due.
      const existingByDue = new Map(
        (
          await tx.duePayment.findMany({
            where: { userId: checkout.userId, dueId: { in: items.map((i) => i.dueId) } },
            select: { dueId: true, checkoutId: true, reference: true },
          })
        ).map((p) => [p.dueId, p]),
      );

      for (const item of items) {
        const existing = existingByDue.get(item.dueId);
        if (existing) {
          if (existing.checkoutId !== checkoutId) flags.push(`"${item.due.title}" was already paid (${existing.reference})`);
          continue;
        }
        const duePayment = await tx.duePayment.create({
          data: {
            userId: checkout.userId,
            dueId: item.dueId,
            checkoutId,
            txnId: txnToLink,
            reference: checkout.reference,
            amountPaid: item.faceKobo + item.feeKobo,
            processingFee: 0,
            duevyFee: item.feeKobo,
            netToSpace: item.faceKobo,
            paidAt: new Date(),
          },
        });
        txnToLink = null;
        await appendLedgerEntry(tx, {
          spaceId: checkout.spaceId,
          dueId: item.dueId,
          txnId: txn?.id ?? null,
          duePaymentId: duePayment.id,
          type: 'due_payment',
          direction: 'credit',
          amountKobo: item.faceKobo,
          grossKobo: item.faceKobo + item.feeKobo,
          feeKobo: item.feeKobo,
          netKobo: item.faceKobo,
          reference: checkout.reference,
          description: `Payment for "${item.due.title}"`,
        });
      }

      if (txn) await tx.transaction.update({ where: { id: txn.id }, data: { status: 'completed' } });

      const updated = await tx.checkout.update({
        where: { id: checkoutId },
        data: {
          status: 'paid',
          paidAt: new Date(),
          receivedKobo,
          overpaidKobo: excess,
          // The credit that paid it (Bank78's sessionId), so a later credit
          // on a different session is recognised as a second payment.
          providerChargeId: checkout.providerChargeId ?? providerChargeId,
          needsReview: flags.length > 0 || checkout.needsReview,
          reviewReason: flags.length ? flags.join('; ') : checkout.reviewReason,
        },
      });

      await tx.receipt.upsert({
        where: { checkoutId },
        update: {},
        create: {
          number: generateReceiptNumber(),
          checkoutId,
          userId: checkout.userId,
          spaceId: checkout.spaceId,
          totalKobo: receivedKobo,
        },
      });

      return { outcome: 'paid' as const, checkout: updated, flags };
    },
    { timeout: 20_000 },
  );

  if (result.outcome === 'short') {
    await markUnderpaid(checkoutId, receivedKobo, result.checkout.totalKobo, `${source}: accepted short`);
    return 'underpaid';
  }
  if (result.outcome === 'already_paid') {
    if (result.flags.length) {
      logger.warn({ ref: result.checkout.reference, source, providerChargeId }, 'payment on a different charge for a paid checkout');
      await flagToAdmins('Payment needs review', `${result.checkout.reference}: ${result.flags.join('; ')}`);
    } else {
      logger.info({ ref: result.checkout.reference, source }, 'checkout already paid — duplicate outcome ignored');
    }
    return 'already_paid';
  }

  logger.info({ ref: result.checkout.reference, source, received: receivedKobo, flags: result.flags }, 'checkout paid');
  // Fire-and-forget: notifications and the receipt email must not hold up the
  // webhook worker. The payment itself is already committed.
  void afterPaid(result.checkout).catch((err) => logger.warn({ err, ref: result.checkout.reference }, 'post-payment side effects failed'));
  // Move the money into the rep's wallet. Reconciliation retries it if this fails.
  void routeCheckoutFunds(checkoutId).catch((err) => logger.warn({ ref: result.checkout.reference, err: (err as Error).message }, 'routing to rep wallet deferred'));
  if (result.flags.length) await flagToAdmins('Payment needs review', `${result.checkout.reference}: ${result.flags.join('; ')}`);
  return 'paid';
}

export type RouteOutcome = 'routed' | 'skipped';

/**
 * Credit a paid checkout's collections to the lead rep's wallet. What moves is
 * exactly what the space's ledger was credited (a due already paid elsewhere
 * isn't); any excess and Duevy's fee stay in the merchant account. Idempotent:
 * the transfer reference is derived from ours, and routedAt is set once.
 */
export async function routeCheckoutFunds(checkoutId: string): Promise<RouteOutcome> {
  // The row lock is held across the transfer so the webhook path and the
  // reconciliation sweep can never send it twice; a concurrent caller skips.
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "checkouts" WHERE "id" = ${checkoutId} FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return 'skipped';
      const c = await tx.checkout.findUniqueOrThrow({
        where: { id: checkoutId },
        select: { id: true, reference: true, spaceId: true, status: true, routedAt: true },
      });
      if (c.status !== 'paid' || c.routedAt) return 'skipped';

      const lead = await tx.spaceRep.findFirst({
        where: { spaceId: c.spaceId, role: 'lead' },
        include: { user: { select: { walletAccountNumber: true } } },
      });
      const wallet = lead?.user.walletAccountNumber;
      if (!wallet) {
        logger.error({ ref: c.reference, spaceId: c.spaceId }, 'paid checkout has no lead rep wallet to route to');
        return 'skipped';
      }

      const credited = await tx.ledgerEntry.aggregate({
        where: { reference: c.reference, type: 'due_payment', spaceId: c.spaceId },
        _sum: { amountKobo: true },
      });
      const amountKobo = credited._sum.amountKobo ?? 0;
      const reference = `RT-${c.reference}`;

      let transferId: string | null = null;
      if (amountKobo > 0) {
        try {
          ({ transferId } = await getPaymentProvider().routeCollection({ accountId: wallet, amountKobo, reference }));
        } catch (err) {
          // Bank78 answering "duplicate" means an earlier attempt already went through.
          if (!(err instanceof ProviderError && (err.code === '94' || err.code === '26'))) throw err;
          transferId = reference;
        }
      }
      await tx.checkout.update({ where: { id: c.id }, data: { routedAt: new Date(), routeTransferId: transferId } });
      logger.info({ ref: c.reference, wallet, amountKobo, transferId }, 'collection routed to rep wallet');
      return 'routed' as const;
    },
    { timeout: 30_000 },
  );
}

/** Less than the total arrived. No due is marked paid; an admin decides. */
export async function markUnderpaid(checkoutId: string, receivedKobo: number, expectedKobo: number, source = 'webhook'): Promise<boolean> {
  const changed = await db.$transaction(async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    if (!canTransitionCheckout(c.status, 'underpaid')) {
      // Money arrived on an expired (or already underpaid) checkout. The
      // status can't move, but the money is real: record it and flag it
      // rather than dropping it. A replay of the same amount is a no-op.
      if (c.status === 'paid' || (c.status === 'underpaid' && c.receivedKobo === receivedKobo)) return null;
      const flagged = await tx.checkout.update({
        where: { id: checkoutId },
        data: {
          receivedKobo,
          needsReview: true,
          reviewReason: `short payment on a ${c.status} checkout: received ${receivedKobo} of ${expectedKobo} kobo`,
        },
      });
      return { checkout: flagged, transitioned: false };
    }
    const updated = await tx.checkout.update({
      where: { id: checkoutId },
      data: {
        status: 'underpaid',
        underpaidAt: new Date(),
        receivedKobo,
        needsReview: true,
        reviewReason: `underpaid: received ${receivedKobo} of ${expectedKobo} kobo`,
      },
    });
    return { checkout: updated, transitioned: true };
  });
  if (!changed) return false;
  if (!changed.transitioned) {
    logger.warn({ ref: changed.checkout.reference, received: receivedKobo, expected: expectedKobo, source }, 'short payment on a closed checkout');
    await flagToAdmins('Payment needs review', `${changed.checkout.reference}: ${changed.checkout.reviewReason}`);
    return false;
  }
  logger.warn({ ref: changed.checkout.reference, received: receivedKobo, expected: expectedKobo, source }, 'checkout underpaid');
  await flagToAdmins(
    'Underpaid transfer',
    `${changed.checkout.reference}: received ₦${(receivedKobo / 100).toLocaleString('en-NG')} of ₦${(expectedKobo / 100).toLocaleString('en-NG')}.`,
  );
  await notifyMany([changed.checkout.userId], {
    kind: 'system',
    tone: 'amber',
    title: 'Payment incomplete',
    detail: `We received ₦${(receivedKobo / 100).toLocaleString('en-NG')} of ₦${(expectedKobo / 100).toLocaleString('en-NG')}. Support will contact you about the balance.`,
    href: '/dashboard/dues',
  }).catch(() => {});
  return true;
}

/** The window closed with nothing paid. Idempotent; never touches a paid checkout. */
export async function expireCheckout(checkoutId: string, reason = 'expired'): Promise<boolean> {
  const changed = await db.$transaction(async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    if (!canTransitionCheckout(c.status, 'expired')) return null;
    const u = await tx.checkout.update({
      where: { id: checkoutId },
      data: { status: 'expired', expiredAt: new Date(), reviewReason: reason === 'expired' ? c.reviewReason : reason },
    });
    await tx.transaction.updateMany({ where: { reference: c.reference, status: 'pending' }, data: { status: 'failed' } });
    return u;
  });
  if (changed) logger.info({ ref: changed.reference, reason }, 'checkout expired');
  return !!changed;
}

export async function statusOf(checkoutId: string): Promise<CheckoutStatus> {
  return (await db.checkout.findUniqueOrThrow({ where: { id: checkoutId }, select: { status: true } })).status;
}

// ---------------------------------------------------------------------------

/** "Dues A", "A and B", "A, B and C", "A, B and 2 more" — for notifications. */
function listTitles(titles: string[]): string {
  const quoted = titles.map((t) => `"${t}"`);
  if (quoted.length <= 2) return quoted.join(' and ');
  if (quoted.length === 3) return `${quoted[0]}, ${quoted[1]} and ${quoted[2]}`;
  return `${quoted[0]}, ${quoted[1]} and ${quoted.length - 2} more`;
}

async function afterPaid(checkout: Checkout): Promise<void> {
  const [payer, items, space, reps, receipt] = await Promise.all([
    db.user.findUnique({ where: { id: checkout.userId }, select: { name: true, email: true, isGuest: true } }),
    db.checkoutItem.findMany({ where: { checkoutId: checkout.id }, include: { due: { select: { title: true } } } }),
    db.space.findUnique({ where: { id: checkout.spaceId }, select: { name: true } }),
    db.spaceRep.findMany({ where: { spaceId: checkout.spaceId }, select: { userId: true } }),
    // Issued in the same transaction that marked the checkout paid.
    db.receipt.findFirst({ where: { checkoutId: checkout.id }, select: { number: true } }),
  ]);
  const what = listTitles(items.map((i) => i.due.title));
  await notifyMany(
    reps.map((r) => r.userId),
    {
      kind: 'payment_received',
      title: 'Payment received',
      detail: `${payer?.name ?? 'A member'}${payer?.isGuest ? ' (guest)' : ''} paid ₦${(checkout.faceKobo / 100).toLocaleString('en-NG')} for ${what}.`,
      // One due opens its collections roster; a basket goes to the dues list.
      href: items.length === 1 ? `/dashboard/create-dues?due=${items[0]!.dueId}` : '/dashboard/create-dues',
    },
  );
  // Guests have no dashboard to see an in-app notice — the email is theirs.
  if (!payer?.isGuest) await notifyMany([checkout.userId], {
    kind: 'payment_received',
    title: 'Payment confirmed',
    detail: `Your payment for ${what} was received.`,
    href: `/dashboard/pay/${checkout.reference}`,
  });
  if (payer) {
    await sendDuePaymentReceiptEmail(payer.email, payer.name, {
      spaceName: space?.name ?? '',
      reference: checkout.reference,
      receiptNumber: receipt?.number ?? null,
      items: items.map((i) => ({ title: i.due.title, amountKobo: i.faceKobo })),
      faceKobo: checkout.faceKobo,
      feeKobo: checkout.feeKobo,
      amountPaidKobo: checkout.receivedKobo ?? checkout.totalKobo,
      paidAt: checkout.paidAt ?? new Date(),
    });
  }
}

async function flagToAdmins(title: string, detail: string): Promise<void> {
  const admins = await db.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  await notifyMany(
    admins.map((a) => a.id),
    { kind: 'system', tone: 'rose', title, detail, href: '/admin/checkouts' },
  ).catch(() => {});
}
