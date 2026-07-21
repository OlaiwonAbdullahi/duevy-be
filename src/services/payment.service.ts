import { type Due, type Transaction, type User } from '@prisma/client';
import { db } from '../config/db';
import { computeCharge, computeSubaccountSplit, generateReference } from '../lib/money';
import { initTransaction, createInvoice, chargeCardToken, getCardDetails, getGatewayLabel } from '../lib/paymentGateway';
import { notify, notifyMany } from '../lib/notifications';
import { sendDuePaymentReceiptEmail } from '../lib/email';
import { applyPollVotes, type VoteSelection } from './poll.service';
import { maybeAwardReferral } from './referral.service';

// ₦50 verification charge used to tokenize a card during the redirect add-card flow (§8.4).
const CARD_VERIFICATION_AMOUNT = 5000; // kobo

function normalizeCardBrand(monnifyCardType: string): string {
  const upper = monnifyCardType.toUpperCase();
  if (upper.includes('VISA')) return 'Visa';
  if (upper.includes('MASTERCARD')) return 'Mastercard';
  if (upper.includes('VERVE')) return 'Verve';
  return monnifyCardType;
}

/** After a space records a payment, pay any pending referral bounty for its lead rep. */
async function triggerReferralReward(spaceId: string): Promise<void> {
  const lead = await db.spaceRep.findFirst({ where: { spaceId, role: 'lead' }, select: { userId: true } });
  if (lead) await maybeAwardReferral(lead.userId).catch(() => {});
}

/** Generate a transaction reference that isn't already taken. */
export async function uniqueReference(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = generateReference();
    const clash = await db.transaction.findUnique({ where: { reference: ref } });
    if (!clash) return ref;
  }
  // Astronomically unlikely; fall back to a timestamped ref.
  return `DVY-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Card — synchronous charge of a saved, tokenized card (§6.3/§8.2/§11.6, method=card)
// ---------------------------------------------------------------------------
export interface CardChargeResult {
  reference: string;
  methodLabel: string;
}

/** Charge a saved card for `amount` kobo. Looks up the card, hits Monnify, and
 * returns a reference the caller can use to write its own ledger rows. */
export async function chargeSavedCard(
  userId: string,
  cardId: string,
  amount: number,
  description: string,
): Promise<CardChargeResult> {
  const [card, user] = await Promise.all([
    db.card.findFirst({ where: { id: cardId, userId } }),
    db.user.findUnique({ where: { id: userId } }),
  ]);
  if (!card || !user) throw new CardNotFoundError();

  const reference = await uniqueReference();
  const result = await chargeCardToken({
    amount,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description,
    cardToken: card.providerToken,
  });
  if (!result.paid) throw new CardChargeFailedError();

  return { reference, methodLabel: `${card.brand} •••• ${card.last4}` };
}

export interface RedeemedDiscount {
  id: string;
  amountKobo: number;
}

export async function settleDueFromCard(
  user: User,
  due: Due & { space: { name: string } },
  cardId: string,
  discount?: RedeemedDiscount,
): Promise<Transaction> {
  const charge = computeCharge(due.amount, discount?.amountKobo ?? 0);
  const { reference, methodLabel } = await chargeSavedCard(user.id, cardId, charge.totalCharged, due.title);

  const txn = await db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: methodLabel,
        status: 'completed',
        reference,
        spaceId: due.spaceId,
      },
    });

    await tx.duePayment.create({
      data: {
        userId: user.id,
        dueId: due.id,
        txnId: transaction.id,
        reference,
        amountPaid: charge.totalCharged,
        monnifyFee: charge.monnifyFee,
        duevyFee: charge.duevyFee,
        netToSpace: charge.netToSpace,
      },
    });

    if (discount) {
      await tx.discountCode.update({ where: { id: discount.id }, data: { redeemedAt: new Date(), dueId: due.id } });
    }

    return transaction;
  });

  await notifyRepsOfPayment(due.spaceId, user.name, due.title, due.amount).catch(() => {});
  await sendDuePaymentReceiptEmail(user.email, user.name, {
    dueTitle: due.title,
    spaceName: due.space.name,
    amountPaidKobo: charge.totalCharged,
    reference,
    dueId: due.id,
  }).catch(() => {});
  await triggerReferralReward(due.spaceId);
  return txn;
}

// ---------------------------------------------------------------------------
// Online — in-app invoice (§6.3 method=online) / hosted checkout (card-save only)
// ---------------------------------------------------------------------------
export interface CheckoutResult {
  checkoutUrl: string;
  reference: string;
}

export interface InvoiceResult {
  reference: string;
  amount: number; // kobo, totalCharged
  checkoutUrl: string;
  /** Only Monnify's Create Invoice returns this directly; null on Paystack (transfer lives on the hosted checkout page instead). */
  bankTransfer: { accountNumber: string; bankName: string; accountName: string; expiresAt: string | null } | null;
}

const INVOICE_EXPIRY_MS = 60 * 60 * 1000; // 1h

/**
 * "Invoice" flow (payment architecture migration) — Monnify's Create Invoice
 * returns a transfer account *and* a checkoutUrl in one response; Paystack's
 * equivalent is Initialize Transaction with a subaccount attached (transfer
 * lives on that hosted page, not as a separate field — see createInvoice()
 * in paystack.ts). Either way the payer lands on callbackPath after paying,
 * but the charge.success webhook (routed through fulfilByReference below)
 * remains the actual source of truth, not the redirect itself.
 */
export async function initOnlineDuePayment(
  user: User,
  due: Due & { space: { name: string; paystackSubaccountCode: string | null } },
  discount?: RedeemedDiscount,
): Promise<InvoiceResult> {
  const charge = computeCharge(due.amount, discount?.amountKobo ?? 0);
  const reference = await uniqueReference();
  const gatewayLabel = await getGatewayLabel();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'due',
        title: due.title,
        detail: due.space.name,
        amount: -charge.totalCharged,
        method: gatewayLabel,
        status: 'pending',
        reference,
        spaceId: due.spaceId,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'due_payment',
        // discountCodeId is only redeemed once this actually completes (fulfilByReference)
        // — a failed/expired/abandoned charge leaves the code untouched for reuse.
        // discountAmountKobo is snapshotted here (not re-looked-up) so fulfilment
        // recomputes the exact same totalCharged that was actually invoiced.
        metadata: {
          dueId: due.id,
          amount: charge.totalCharged,
          discountCodeId: discount?.id ?? null,
          discountAmountKobo: discount?.amountKobo ?? 0,
        },
        expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
      },
    });
  });

  const split = computeSubaccountSplit(due.amount);
  // The payer is charged the full amount (face + fee) at checkout.
  const charged = await createInvoice({
    amount: charge.totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: due.title,
    callbackPath: `/dashboard/pay/${reference}?dueId=${due.id}`,
    expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
    ...(due.space.paystackSubaccountCode
      ? { subaccountCode: due.space.paystackSubaccountCode, subaccountShareKobo: split.subaccountShareKobo }
      : {}),
  });

  // Persist so GET /payments/:reference/status (and a reload of the dedicated
  // payment page) can render the same invoice without needing this closure —
  // notably bankTransfer, which only Monnify's Create Invoice returns.
  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        dueId: due.id,
        amount: charge.totalCharged,
        discountCodeId: discount?.id ?? null,
        discountAmountKobo: discount?.amountKobo ?? 0,
        checkoutUrl: charged.checkoutUrl,
        bankTransfer: charged.bankTransfer,
      },
    },
  });

  return { reference, amount: charge.totalCharged, checkoutUrl: charged.checkoutUrl, bankTransfer: charged.bankTransfer };
}

/**
 * Same in-app invoice flow as `initOnlineDuePayment`, for a paid poll vote.
 * Extracted out of routes/polls.ts (which used to duplicate this pending/init
 * logic inline against the old hosted-checkout call) so both payment surfaces
 * share one invoice + subaccount-split implementation.
 */
export async function initOnlinePollVote(
  user: User,
  poll: { id: string; title: string; spaceId: string; amountPerVote: number; space: { paystackSubaccountCode: string | null } },
  selections: VoteSelection[],
  totalCharged: number,
): Promise<InvoiceResult> {
  const reference = await uniqueReference();
  const gatewayLabel = await getGatewayLabel();

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'vote',
        title: `Votes: ${poll.title}`,
        detail: 'Poll',
        amount: -totalCharged,
        method: gatewayLabel,
        status: 'pending',
        reference,
        spaceId: poll.spaceId,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'poll_vote',
        metadata: { pollId: poll.id, amountPerVote: poll.amountPerVote, selections },
        expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
      },
    });
  });

  // Gross face value (before the payer's 3% charge) drives the subaccount split, same as a due.
  const grossFace = poll.amountPerVote * selections.reduce((s, sel) => s + sel.quantity, 0);
  const split = computeSubaccountSplit(grossFace);
  const charged = await createInvoice({
    amount: totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: `Votes: ${poll.title}`,
    callbackPath: `/dashboard/pay/${reference}`,
    expiresAt: new Date(Date.now() + INVOICE_EXPIRY_MS),
    ...(poll.space.paystackSubaccountCode
      ? { subaccountCode: poll.space.paystackSubaccountCode, subaccountShareKobo: split.subaccountShareKobo }
      : {}),
  });

  // See initOnlineDuePayment's identical follow-up update for why this exists.
  await db.pendingPayment.update({
    where: { reference },
    data: {
      metadata: {
        pollId: poll.id,
        amountPerVote: poll.amountPerVote,
        selections,
        amount: totalCharged,
        checkoutUrl: charged.checkoutUrl,
        bankTransfer: charged.bankTransfer,
      },
    },
  });

  return { reference, amount: totalCharged, checkoutUrl: charged.checkoutUrl, bankTransfer: charged.bankTransfer };
}

// ---------------------------------------------------------------------------
// Card save — redirect flow (§8.4). The payer completes a small verification
// charge on the active gateway's hosted checkout; the webhook/reconciliation
// fulfilment path below exchanges the completed transaction for a reusable card token.
// ---------------------------------------------------------------------------
export async function initCardSave(user: User, isDefault: boolean): Promise<CheckoutResult> {
  const reference = await uniqueReference();
  const gatewayLabel = await getGatewayLabel();

  const init = await initTransaction({
    amount: CARD_VERIFICATION_AMOUNT,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: 'Card verification',
    callbackPath: '/dashboard/wallet/callback',
  });

  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: 'card_verification',
        title: 'Card verification',
        detail: gatewayLabel,
        amount: -CARD_VERIFICATION_AMOUNT,
        method: gatewayLabel,
        status: 'pending',
        reference,
      },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId: user.id,
        type: 'card_save',
        metadata: { isDefault, transactionReference: init.transactionReference },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  return { checkoutUrl: init.checkoutUrl, reference };
}

// ---------------------------------------------------------------------------
// Fulfilment — invoked by the webhook (§15) and the status poller (§6.4)
// ---------------------------------------------------------------------------
export type FulfilOutcome = 'fulfilled' | 'already' | 'failed' | 'unknown';

export async function fulfilByReference(reference: string, success: boolean): Promise<FulfilOutcome> {
  const pending = await db.pendingPayment.findUnique({ where: { reference } });
  if (!pending) return 'unknown';
  if (pending.status === 'completed') return 'already';
  if (pending.status === 'failed') return 'already';

  if (!success) {
    await db.$transaction([
      db.pendingPayment.update({ where: { reference }, data: { status: 'failed' } }),
      db.transaction.updateMany({ where: { reference }, data: { status: 'failed' } }),
    ]);
    return 'failed';
  }

  const meta = (pending.metadata ?? {}) as {
    amount?: number;
    dueId?: string;
    discountCodeId?: string | null;
    discountAmountKobo?: number;
  };

  if (pending.type === 'due_payment' && meta.dueId) {
    const due = await db.due.findUnique({ where: { id: meta.dueId }, include: { space: { select: { name: true } } } });
    if (!due) return 'unknown';

    // Guard against a duplicate DuePayment (webhook + reconciliation racing).
    const existing = await db.duePayment.findUnique({
      where: { userId_dueId: { userId: pending.userId, dueId: due.id } },
    });

    const charge = computeCharge(due.amount, meta.discountAmountKobo ?? 0);
    const txn = await db.transaction.findUnique({ where: { reference } });

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      if (!existing) {
        await tx.duePayment.create({
          data: {
            userId: pending.userId,
            dueId: due.id,
            txnId: txn?.id,
            reference,
            amountPaid: charge.totalCharged,
            monnifyFee: charge.monnifyFee,
            duevyFee: charge.duevyFee,
            netToSpace: charge.netToSpace,
          },
        });
        if (meta.discountCodeId) {
          await tx.discountCode.update({ where: { id: meta.discountCodeId }, data: { redeemedAt: new Date(), dueId: due.id } });
        }
      }
    });

    const payer = await db.user.findUnique({ where: { id: pending.userId }, select: { name: true, email: true } });
    await notifyRepsOfPayment(due.spaceId, payer?.name ?? 'A member', due.title, due.amount).catch(() => {});
    if (payer) {
      await sendDuePaymentReceiptEmail(payer.email, payer.name, {
        dueTitle: due.title,
        spaceName: due.space.name,
        amountPaidKobo: charge.totalCharged,
        reference,
        dueId: due.id,
      }).catch(() => {});
    }
    await triggerReferralReward(due.spaceId);
    return 'fulfilled';
  }

  if (pending.type === 'poll_vote') {
    const voteMeta = (pending.metadata ?? {}) as {
      pollId?: string;
      amountPerVote?: number;
      selections?: VoteSelection[];
    };
    if (!voteMeta.pollId || !voteMeta.selections) return 'unknown';

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      await applyPollVotes(tx, {
        pollId: voteMeta.pollId as string,
        userId: pending.userId,
        selections: voteMeta.selections as VoteSelection[],
        amountPerVote: voteMeta.amountPerVote ?? 0,
        reference,
      });
    });
    return 'fulfilled';
  }

  if (pending.type === 'card_save') {
    const cardMeta = (pending.metadata ?? {}) as { isDefault?: boolean; transactionReference?: string };
    const details = await getCardDetails(cardMeta.transactionReference ?? reference);

    if (!details) {
      // Verification charge succeeded but we couldn't retrieve a reusable token —
      // leave the pending row unresolved so reconciliation retries rather than
      // silently losing the ₦50 charge with no card to show for it.
      console.error(`[card-save] no card details returned for ref=${reference}; will retry`);
      return 'unknown';
    }

    const existing = await db.card.findUnique({ where: { providerToken: details.cardToken } });
    if (existing) {
      await db.$transaction([
        db.pendingPayment.update({ where: { reference }, data: { status: 'completed' } }),
        db.transaction.updateMany({ where: { reference }, data: { status: 'completed' } }),
      ]);
      return 'fulfilled';
    }

    const count = await db.card.count({ where: { userId: pending.userId } });
    const makeDefault = !!cardMeta.isDefault || count === 0;

    await db.$transaction(async (tx) => {
      await tx.pendingPayment.update({ where: { reference }, data: { status: 'completed' } });
      await tx.transaction.updateMany({ where: { reference }, data: { status: 'completed' } });
      if (makeDefault) {
        await tx.card.updateMany({ where: { userId: pending.userId, isDefault: true }, data: { isDefault: false } });
      }
      await tx.card.create({
        data: {
          userId: pending.userId,
          providerToken: details.cardToken,
          brand: normalizeCardBrand(details.cardType),
          last4: details.last4,
          expiry: `${details.expMonth.padStart(2, '0')}/${details.expYear.slice(-2)}`,
          isDefault: makeDefault,
        },
      });
    });

    await notify({
      userId: pending.userId,
      kind: 'payment_received',
      title: 'Card added',
      detail: `Your ${normalizeCardBrand(details.cardType)} card ending in ${details.last4} was saved.`,
      href: '/dashboard/wallet',
    }).catch(() => {});

    return 'fulfilled';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
async function notifyRepsOfPayment(spaceId: string, payerName: string, dueTitle: string, amount: number): Promise<void> {
  const reps = await db.spaceRep.findMany({ where: { spaceId }, select: { userId: true } });
  await notifyMany(
    reps.map((r) => r.userId),
    {
      kind: 'payment_received',
      title: 'Payment received',
      detail: `${payerName} paid ₦${(amount / 100).toLocaleString('en-NG')} for "${dueTitle}".`,
      href: '/dashboard/collections',
    },
  );
}

export class CardNotFoundError extends Error {
  constructor() {
    super('Card not found');
    this.name = 'CardNotFoundError';
  }
}

export class CardChargeFailedError extends Error {
  constructor() {
    super('Card charge was declined');
    this.name = 'CardChargeFailedError';
  }
}
