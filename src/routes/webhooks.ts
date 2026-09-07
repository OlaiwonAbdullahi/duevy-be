import { Router, type Request, type Response } from 'express';
import { verifyWebhookSignature, fromAnchorRef, getPayIn } from '../lib/anchor';
import { fulfilByReference, markPaymentSettled } from '../services/payment.service';
import { settlePayout } from '../services/payout.service';
import {
  applyAccountOpened,
  applyKycApproved,
  applyKycPending,
  applyKycRejected,
  scheduleKycRecheck,
} from '../services/anchorCustomer.service';
import { db } from '../config/db';

export const webhooksRouter = Router();

/**
 * POST /webhooks/anchor — public, signature-verified, the single ingestion
 * point for every Anchor event.
 *
 * Handler rules (PRD §6.4), all non-negotiable:
 *  - Reject anything failing the x-anchor-signature check.
 *  - Persist by Anchor's event id BEFORE processing; a repeated id is
 *    acknowledged and dropped.
 *  - Always return 200 — Anchor retries on non-200, and a duplicate delivery is
 *    worse than a slow handler. Reconciliation is the backstop for a genuinely
 *    dropped event.
 *
 * ENVELOPE CAVEAT: Anchor publishes the event type list and one worked payload,
 * but not a per-event field map. The extractors below read the documented
 * JSON:API shape and fall back across the plausible field names rather than
 * assuming one. Confirm each event against a real sandbox delivery before
 * go-live — the shape, not the logic, is the uncertain part here.
 */

interface AnchorEvent {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, { data?: { id?: string; type?: string } }>;
}

/** Anchor sends events flat for some products and wrapped in `data` for others. */
function parseEvent(body: unknown): AnchorEvent | null {
  const raw = body as { data?: Record<string, unknown> } & Record<string, unknown>;
  const node = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
  const id = typeof node?.id === 'string' ? node.id : undefined;
  const type = typeof node?.type === 'string' ? node.type : undefined;
  if (!id || !type) return null;
  return {
    id,
    type,
    attributes: (node.attributes as Record<string, unknown>) ?? {},
    relationships: (node.relationships as AnchorEvent['relationships']) ?? {},
  };
}

function relId(event: AnchorEvent, ...names: string[]): string | undefined {
  for (const name of names) {
    const id = event.relationships[name]?.data?.id;
    if (id) return id;
  }
  return undefined;
}

function attrString(event: AnchorEvent, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = event.attributes[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function attrNumber(event: AnchorEvent, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = event.attributes[name];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Our own payment reference for an inflow event.
 *
 * Three routes, in decreasing order of directness: the echoed `reference`; the
 * PayIn, which `payin.received` carries and which must be fetched because the
 * event itself holds only an id; and finally the checkout id, which works
 * because we stored it on the pending payment when the checkout was opened.
 */
async function resolvePaymentReference(event: AnchorEvent): Promise<string | undefined> {
  const echoed = attrString(event, 'reference', 'paymentReference', 'narration');
  if (echoed) {
    const normalised = fromAnchorRef(echoed);
    if (await db.pendingPayment.findUnique({ where: { reference: normalised } })) return normalised;
  }

  // payin.received carries only a payIn id, so the reference has to be fetched.
  const payInId = relId(event, 'payIn');
  if (payInId) {
    const payIn = await getPayIn(payInId);
    if (payIn && (await db.pendingPayment.findUnique({ where: { reference: payIn.reference } }))) {
      return payIn.reference;
    }
  }

  const checkoutId = relId(event, 'payWithTransfer', 'virtualNuban', 'account', 'reservedAccount');
  if (!checkoutId) return undefined;
  const pending = await db.pendingPayment.findFirst({
    where: { metadata: { path: ['payWithTransferId'], equals: checkoutId } },
    select: { reference: true },
  });
  return pending?.reference;
}

/** Our own payout reference for a transfer event. */
async function resolveTransferReference(event: AnchorEvent): Promise<string | undefined> {
  const echoed = attrString(event, 'reference');
  if (echoed) return fromAnchorRef(echoed);

  const transferId = relId(event, 'transfer');
  if (!transferId) return undefined;
  const payout = await db.payout.findFirst({ where: { anchorTransferId: transferId }, select: { reference: true } });
  return payout?.reference;
}

async function handleEvent(event: AnchorEvent): Promise<void> {
  switch (event.type) {
    // --- Rep identity -----------------------------------------------------
    case 'customer.identification.approved': {
      const customerId = relId(event, 'customer');
      if (customerId) await applyKycApproved(customerId);
      break;
    }
    case 'customer.identification.rejected': {
      const customerId = relId(event, 'customer');
      if (customerId) await applyKycRejected(customerId, attrString(event, 'comment', 'reason'));
      break;
    }
    case 'customer.identification.error': {
      // Transient — the check errored, the rep's details are not necessarily
      // wrong. We hold no BVN to resubmit with, so recovery is to re-read
      // Anchor's own record on a backoff (see scheduleKycRecheck).
      const customerId = relId(event, 'customer');
      if (customerId) await scheduleKycRecheck(customerId);
      break;
    }
    case 'customer.identification.manualReview':
    case 'customer.identification.awaitingDocument':
    case 'customer.identification.reenter_information':
    case 'customer.identification.pending': {
      // tier_3 is a manual review, so these are its normal resting states and
      // can persist for days. applyKycPending() deliberately leaves an
      // already-verified rep alone — an upgrade under review must not stop the
      // space collecting on the tier it already holds.
      const customerId = relId(event, 'customer');
      if (customerId) await applyKycPending(customerId);
      break;
    }

    // --- tier_3 documents -------------------------------------------------
    case 'document.approved':
    case 'document.rejected':
      // Per-document progress within a tier_3 review. The tier itself only
      // moves on customer.identification.approved/.rejected, so these are
      // recorded in webhook_events for support rather than acted on — acting on
      // one document would promote a rep mid-review.
      break;

    // --- Account provisioning --------------------------------------------
    case 'account.opened':
    case 'accountNumber.created': {
      const accountId = relId(event, 'account', 'depositAccount') ?? event.id;
      await applyAccountOpened(accountId);
      break;
    }

    // --- Collections ------------------------------------------------------
    //
    // payin.received belongs to the Payments product, not the BaaS event enum,
    // so it arrives from a SEPARATE webhook registration (see anchor.ts).
    case 'payin.received': {
      // The single source of truth for a successful payment. The money is in
      // Duevy's settlement account at this point, not the department's, so both
      // marks are applied: fulfilled AND settled. remitToSpaces() moves it on.
      const reference = await resolvePaymentReference(event);
      if (reference) {
        // Anchor fixes the amount, so the credited figure should always equal
        // what we invoiced; it is passed through purely as an assertion.
        const creditedKobo = attrNumber(event, 'amount', 'creditAmount');
        await fulfilByReference(reference, true, creditedKobo !== undefined ? { creditedKobo } : {});
        await markPaymentSettled(reference);
      }
      break;
    }
    case 'nip.inbound.received':
    case 'nip.inbound.completed':
      // A direct transfer into a deposit account — not a checkout. Logged for
      // visibility; remittances are matched by book.transfer.* below.
      break;

    // --- Payouts ----------------------------------------------------------
    case 'nip.transfer.successful': {
      const reference = await resolveTransferReference(event);
      if (reference) await settlePayout(reference, true);
      break;
    }
    case 'nip.transfer.failed':
    case 'nip.transfer.reversed': {
      const reference = await resolveTransferReference(event);
      if (reference) {
        await settlePayout(
          reference,
          false,
          event.type === 'nip.transfer.reversed'
            ? 'The transfer was reversed by the bank'
            : attrString(event, 'failureReason', 'reason') ?? 'The bank could not complete the transfer',
        );
      }
      break;
    }

    // --- Remittance to departments ---------------------------------------
    case 'book.transfer.successful':
    case 'book.transfer.failed':
      // remitToSpaces() records its own outcome synchronously and retries on
      // the next reconciliation tick, so there is nothing to do here beyond the
      // log below. Subscribed so a failure is visible in webhook_events.
      break;

    default:
      break; // acknowledge and ignore anything else
  }
}

webhooksRouter.post('/anchor', async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const signature = req.headers['x-anchor-signature'] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
    return;
  }

  const event = parseEvent(req.body);
  if (!event) {
    // Signed but unreadable — acknowledge so Anchor stops retrying, and leave a
    // trail, because this means the envelope is not what we expect.
    console.error('[webhook] anchor event missing id/type:', JSON.stringify(req.body));
    res.status(200).json({ success: true });
    return;
  }

  // Idempotency: claim the event id before doing any work. A duplicate delivery
  // hits the unique constraint and is dropped.
  try {
    await db.webhookEvent.create({
      data: { anchorEventId: event.id, type: event.type, payload: req.body as object },
    });
  } catch {
    console.log(`[webhook] anchor duplicate ${event.type} ${event.id} — dropped`);
    res.status(200).json({ success: true });
    return;
  }

  console.log(`[webhook] anchor ${event.type} ${event.id}`);

  try {
    await handleEvent(event);
    await db.webhookEvent.update({
      where: { anchorEventId: event.id },
      data: { status: 'processed', processedAt: new Date() },
    });
  } catch (err) {
    console.error(`[webhook] anchor handling error for ${event.type} ${event.id}:`, err);
    // Recorded rather than retried: the stored payload makes the event
    // replayable, and reconciliation covers the money paths regardless.
    await db.webhookEvent
      .update({
        where: { anchorEventId: event.id },
        data: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => {});
  }

  res.status(200).json({ success: true });
});
