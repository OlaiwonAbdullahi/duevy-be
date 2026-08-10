import { Router, type Request, type Response } from 'express';
import { verifyWebhookSignature } from '../lib/bachs';
import { fulfilByReference } from '../services/payment.service';
import { settlePayout } from '../services/payout.service';
import { applyAccountWebhookUpdate, applyCapabilityWebhookUpdate } from '../services/connectAccount.service';
import { db } from '../config/db';

export const webhooksRouter = Router();

/**
 * POST /webhooks/bachs — Public, signature-verified. Single ingestion point
 * for a webhook endpoint registered with event_source: "all" (both Duevy's
 * own collection events and every connected account's Connect events land
 * here, per the skill). UNVERIFIED — the skill documents the event types but
 * not the delivery envelope's exact field names; built on the same
 * snake_case convention the rest of the documented API uses
 * (organization_id, transfer_group, ...). Confirm against a real sandbox
 * before go-live.
 */
webhooksRouter.post('/bachs', async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const signature = req.headers['bachs-signature'] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
    return;
  }

  const body = req.body as {
    event_type?: string;
    data?: {
      reference?: string;
      status?: string;
      transfer_group?: string;
      id?: string;
      organization_id?: string;
      setup_status?: 'incomplete' | 'awaiting_review' | 'complete';
      capability?: string;
    };
  };
  const data = body.data ?? {};

  console.log(`[webhook] bachs event_type=${body.event_type ?? 'unknown'}:`, JSON.stringify(body));

  try {
    switch (body.event_type) {
      case 'collection.succeeded':
      case 'collection.failed': {
        if (data.reference) {
          await fulfilByReference(data.reference, body.event_type === 'collection.succeeded');
        }
        break;
      }

      case 'transfer.created': {
        // Confirms a split-transfer fired by sweepSettledDuePayments() — idempotent,
        // only writes if this DuePayment hasn't already been marked transferred
        // (the sweep's own synchronous response is the fast path; this is the
        // backstop for a lost response on a transfer that actually succeeded).
        if (data.transfer_group) {
          await db.duePayment.updateMany({
            where: { reference: data.transfer_group, transferredAt: null },
            data: { transferredAt: new Date(), splitTransferId: data.id },
          });
        }
        break;
      }

      case 'account.updated': {
        if (data.organization_id) {
          await applyAccountWebhookUpdate({ organization_id: data.organization_id, setup_status: data.setup_status });
        }
        break;
      }

      case 'capability.updated': {
        if (data.organization_id) {
          await applyCapabilityWebhookUpdate({ organization_id: data.organization_id, capability: data.capability, status: data.status });
        }
        break;
      }

      case 'payout.paid':
      case 'payout.failed': {
        if (data.reference) {
          await settlePayout(
            data.reference,
            body.event_type === 'payout.paid',
            body.event_type === 'payout.failed' ? 'The payment provider reported the withdrawal failed' : undefined,
          );
        }
        break;
      }

      default:
        break; // acknowledge and ignore anything else
    }
  } catch (err) {
    console.error('[webhook] bachs handling error:', err);
    // Still 200 below so Bachs doesn't hammer retries; reconciliation is the backstop.
  }

  res.status(200).json({ success: true });
});
