import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma, SweepStatus, SweepTrigger, WebhookStatus } from '@prisma/client';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { requireAdminPermission } from '../middleware/requireRole';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePayout } from '../lib/serializers';
import { writeAdminAudit } from '../lib/adminAudit';
import { AppError } from '../lib/errors';
import { getPaymentProvider, ProviderError } from '../providers/payment';
import { getSpaceBalance } from '../services/ledger.service';
import {
  ensureSpaceAccount,
  getBusinessSweepAllowanceKobo,
  getDailyUsageKobo,
  getSpaceFunds,
  refreshSweep,
  startOfLagosDay,
  startSweep,
  DAILY_LIMIT_KOBO,
} from '../services/sweep.service';
import { cancelPayout, dispatchPayout, failPayout, refreshPayout } from '../services/withdrawal.service';
import { syncDirectDeposits } from '../services/directDeposit.service';
import { confirmReceivedPayment, reconcileCheckout } from '../jobs/reconciliation';

/**
 * The admin's view of the 9jaPay money flow, mounted under /admin (behind
 * authenticate + requireAdmin):
 *
 *   student ──▶ one-time account (checkout) ──▶ Duevy business account
 *           ──sweep──▶ space's own 9jaPay account ──payout──▶ rep's bank
 *   anyone  ──direct deposit──▶ space's own 9jaPay account
 *
 * Every read here is from our own books; the actions ask 9jaPay first and
 * only ever move a record the way 9jaPay's answer says (the same functions
 * the reconciliation job uses), so an admin can't push money out of step.
 */
export const adminPaymentsRouter = Router();

const STUCK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sumOf = (v: bigint | number | null | undefined) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// GET /admin/payments/summary — where the money is, today's limits, and what's stuck.
// ---------------------------------------------------------------------------
adminPaymentsRouter.get('/payments/summary', requireAdminPermission('payouts'), async (_req: Request, res: Response): Promise<void> => {
  const provider = getPaymentProvider().name;
  const now = Date.now();
  const dayStart = startOfLagosDay();
  const since30 = new Date(now - 30 * DAY_MS);
  const since7 = new Date(now - 7 * DAY_MS);
  const stale = new Date(now - STUCK_MS);

  const [
    ledgerAgg,
    unsweptRows,
    paidToday,
    sweptToday,
    withdrawnToday,
    depositedToday,
    businessRemaining,
    fees30,
    sweepFees30,
    withdrawalFees30,
    checkoutCounts,
    checkoutsNeedingReview,
    payoutCounts,
    stuckPayouts,
    failedPayouts7,
    sweepCounts,
    stuckSweeps,
    failedSweeps7,
    webhookCounts,
    spacesWithoutAccount,
    frozenSpaces,
    accountsOpened,
  ] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ['direction'], _sum: { amountKobo: true } }),
    // Per space: 9jaPay collections not yet swept (never below zero per space).
    db.$queryRaw<{ unswept: bigint | null; spaces: number }[]>`
      WITH collected AS (
        SELECT le."spaceId", SUM(le."amountKobo") AS amt
          FROM "ledger_entries" le
          JOIN "due_payments" dp ON dp."id" = le."duePaymentId"
          JOIN "checkouts" c ON c."id" = dp."checkoutId"
         WHERE le."type" = 'due_payment' AND c."provider" = ${provider}
         GROUP BY le."spaceId"
      ), swept AS (
        SELECT "spaceId", SUM("amountKobo") AS amt FROM "sweeps" WHERE "status" <> 'failed' GROUP BY "spaceId"
      )
      SELECT COALESCE(SUM(GREATEST(0, c.amt - COALESCE(s.amt, 0))), 0)::bigint AS unswept,
             COUNT(*) FILTER (WHERE c.amt - COALESCE(s.amt, 0) > 0)::int AS spaces
        FROM collected c LEFT JOIN swept s ON s."spaceId" = c."spaceId"`,
    db.checkout.aggregate({ where: { status: 'paid', paidAt: { gte: dayStart } }, _count: { _all: true }, _sum: { totalKobo: true, faceKobo: true } }),
    db.sweep.aggregate({ where: { status: { not: 'failed' }, createdAt: { gte: dayStart } }, _count: { _all: true }, _sum: { amountKobo: true } }),
    db.payout.aggregate({
      where: { provider, status: { notIn: ['failed', 'cancelled', 'reversed'] }, requestedAt: { gte: dayStart } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.directDeposit.aggregate({ where: { receivedAt: { gte: dayStart } }, _count: { _all: true }, _sum: { amountKobo: true } }),
    getBusinessSweepAllowanceKobo(),
    db.checkout.aggregate({ where: { status: 'paid', paidAt: { gte: since30 } }, _count: { _all: true }, _sum: { feeKobo: true, totalKobo: true } }),
    db.sweep.aggregate({ where: { status: 'succeeded', settledAt: { gte: since30 } }, _sum: { feeKobo: true, amountKobo: true } }),
    db.payout.aggregate({ where: { provider, status: 'success', settledAt: { gte: since30 } }, _count: { _all: true }, _sum: { feeKobo: true, netKobo: true } }),
    db.checkout.groupBy({ by: ['status'], _count: { _all: true } }),
    db.checkout.count({ where: { needsReview: true } }),
    db.payout.groupBy({ by: ['status'], where: { status: { in: ['awaiting_approval', 'pending', 'processing'] } }, _count: { _all: true } }),
    db.payout.count({ where: { status: { in: ['pending', 'processing'] }, requestedAt: { lte: stale } } }),
    db.payout.count({ where: { status: { in: ['failed', 'reversed'] }, OR: [{ failedAt: { gte: since7 } }, { reversedAt: { gte: since7 } }] } }),
    db.sweep.groupBy({ by: ['status'], where: { status: { in: ['pending', 'processing'] } }, _count: { _all: true } }),
    db.sweep.count({ where: { status: { in: ['pending', 'processing'] }, createdAt: { lte: new Date(now - 30 * 60 * 1000) } } }),
    db.sweep.count({ where: { status: 'failed', failedAt: { gte: since7 } } }),
    db.webhookEvent.groupBy({ by: ['status'], where: { provider: { not: 'anchor' } }, _count: { _all: true } }),
    db.space.count({ where: { isArchived: false, walletAccountNumber: null } }),
    db.space.count({ where: { isArchived: false, payoutsFrozen: true } }),
    db.space.count({ where: { walletAccountNumber: { not: null } } }),
  ]);

  const credits = sumOf(ledgerAgg.find((g) => g.direction === 'credit')?._sum.amountKobo);
  const debits = sumOf(ledgerAgg.find((g) => g.direction === 'debit')?._sum.amountKobo);
  const heldKobo = Math.max(0, credits - debits);
  const awaitingSweepKobo = sumOf(unsweptRows[0]?.unswept);
  const countBy = <T extends string>(rows: { status: T; _count: { _all: number } }[], s: T) => rows.find((r) => r.status === s)?._count._all ?? 0;

  const pipeline = {
    checkouts: {
      pending: countBy(checkoutCounts, 'pending'),
      underpaid: countBy(checkoutCounts, 'underpaid'),
      needsReview: checkoutsNeedingReview,
    },
    payouts: {
      awaitingApproval: countBy(payoutCounts, 'awaiting_approval'),
      pending: countBy(payoutCounts, 'pending'),
      processing: countBy(payoutCounts, 'processing'),
      stuck: stuckPayouts,
      failedLast7Days: failedPayouts7,
    },
    sweeps: {
      pending: countBy(sweepCounts, 'pending'),
      processing: countBy(sweepCounts, 'processing'),
      stuck: stuckSweeps,
      failedLast7Days: failedSweeps7,
    },
    webhooks: {
      queued: countBy(webhookCounts, 'received') + countBy(webhookCounts, 'processing'),
      retrying: countBy(webhookCounts, 'failed'),
      dead: countBy(webhookCounts, 'dead'),
    },
    spaces: { withoutAccount: spacesWithoutAccount, payoutsFrozen: frozenSpaces, accountsOpened },
  };

  ok(res, {
    provider,
    funds: {
      // Owed to spaces (the ledger): split by where 9jaPay holds it.
      heldKobo,
      awaitingSweepKobo,
      inSpaceAccountsKobo: Math.max(0, heldKobo - awaitingSweepKobo),
      spacesAwaitingSweep: unsweptRows[0]?.spaces ?? 0,
    },
    today: {
      collectedKobo: paidToday._sum.totalKobo ?? 0,
      collectedFaceKobo: paidToday._sum.faceKobo ?? 0,
      checkoutsPaid: paidToday._count._all,
      sweptKobo: sweptToday._sum.amountKobo ?? 0,
      sweeps: sweptToday._count._all,
      businessSweepLimitKobo: env.NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO,
      businessSweepRemainingKobo: businessRemaining,
      withdrawnKobo: withdrawnToday._sum.amount ?? 0,
      withdrawals: withdrawnToday._count._all,
      directDepositsKobo: depositedToday._sum.amountKobo ?? 0,
      directDeposits: depositedToday._count._all,
    },
    last30Days: {
      collectedKobo: fees30._sum.totalKobo ?? 0,
      checkoutsPaid: fees30._count._all,
      // Duevy's 1.5% processing fee — revenue.
      processingFeesKobo: fees30._sum.feeKobo ?? 0,
      // What 9jaPay charged Duevy to sweep — a cost, covered by the processing fee.
      sweepChargesKobo: sweepFees30._sum.feeKobo ?? 0,
      sweptKobo: sweepFees30._sum.amountKobo ?? 0,
      // 9jaPay's transfer charge + VAT on withdrawals, passed on to spaces.
      withdrawalChargesKobo: withdrawalFees30._sum.feeKobo ?? 0,
      paidOutKobo: withdrawalFees30._sum.netKobo ?? 0,
      withdrawals: withdrawalFees30._count._all,
    },
    pipeline,
    healthy:
      pipeline.checkouts.needsReview === 0 &&
      pipeline.payouts.stuck === 0 &&
      pipeline.sweeps.stuck === 0 &&
      pipeline.webhooks.dead === 0 &&
      pipeline.spaces.withoutAccount === 0,
  });
});

// ---------------------------------------------------------------------------
// Checkouts (collections): ask 9jaPay again about one.
// ---------------------------------------------------------------------------
adminPaymentsRouter.post('/checkouts/:reference/recheck', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const reference = req.params.reference as string;
  const c = await db.checkout.findUnique({ where: { reference } });
  if (!c) {
    errors.notFound(res, 'No checkout with that reference');
    return;
  }
  const before = c.status;
  // Pending: the normal path (may also expire it). Expired/underpaid: honour
  // money that landed late — flagged for review by fulfilCheckout.
  if (c.status === 'pending') await reconcileCheckout(c, { expireIfPastDue: true, source: 'admin' });
  else if (c.status !== 'paid') await confirmReceivedPayment(c, 'admin');
  const after = await db.checkout.findUniqueOrThrow({ where: { reference }, select: { status: true, receivedKobo: true, needsReview: true, reviewReason: true, paidAt: true } });
  await writeAdminAudit(req, 'checkout.rechecked', { target: reference, metadata: { before, after: after.status } });
  ok(res, {
    reference,
    previousStatus: before,
    status: after.status,
    changed: before !== after.status,
    received: after.receivedKobo,
    needsReview: after.needsReview,
    reviewReason: after.reviewReason,
    paidAt: after.paidAt?.toISOString() ?? null,
  });
});

// ---------------------------------------------------------------------------
// Payouts (withdrawals)
// ---------------------------------------------------------------------------
async function payoutDetail(id: string) {
  const p = await db.payout.findUnique({
    where: { id },
    include: {
      space: { select: { id: true, name: true, short: true, walletAccountNumber: true, walletBankName: true, payoutsFrozen: true, withdrawalAuthMode: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      sweep: true,
      approvals: { include: { rep: { select: { id: true, name: true } } }, orderBy: { decidedAt: 'asc' } },
      ledgerEntries: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!p) return null;
  return {
    ...serializePayout(p),
    provider: p.provider,
    providerPayoutId: p.providerPayoutId,
    space: { id: p.space.id, name: p.space.name, short: p.space.short, accountNumber: p.space.walletAccountNumber, bankName: p.space.walletBankName, payoutsFrozen: p.space.payoutsFrozen, authMode: p.space.withdrawalAuthMode },
    requestedBy: p.requestedBy,
    sweep: p.sweep ? serializeSweepRow(p.sweep) : null,
    approvals: p.approvals.map((a) => ({ id: a.id, decision: a.decision, by: a.rep, at: a.decidedAt.toISOString() })),
    ledger: p.ledgerEntries.map((e) => ({ id: e.id, type: e.type, direction: e.direction, amount: e.amountKobo, description: e.description, createdAt: e.createdAt.toISOString() })),
    /** pending/processing for over an hour. */
    stuck: (p.status === 'pending' || p.status === 'processing') && p.requestedAt.getTime() < Date.now() - STUCK_MS,
  };
}

adminPaymentsRouter.get('/payouts/:id', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const detail = await payoutDetail(req.params.id as string);
  if (!detail) {
    errors.notFound(res, 'No withdrawal with that id');
    return;
  }
  ok(res, detail);
});

/**
 * Ask 9jaPay about a withdrawal and apply the answer: processing → its
 * transfer status; pending → its sweep first, then (re)send — 9jaPay refuses a
 * second transfer under the same reference, so this never pays twice.
 */
adminPaymentsRouter.post('/payouts/:id/recheck', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const p = await db.payout.findUnique({ where: { id }, select: { status: true, sweepId: true, reference: true } });
  if (!p) {
    errors.notFound(res, 'No withdrawal with that id');
    return;
  }
  try {
    if (p.status === 'processing') await refreshPayout(id);
    else if (p.status === 'pending') {
      if (p.sweepId) await refreshSweep(p.sweepId);
      await dispatchPayout(id);
    }
  } catch (err) {
    throw providerUnavailable(err);
  }
  await writeAdminAudit(req, 'payout.rechecked', { target: p.reference, metadata: { before: p.status } });
  ok(res, await payoutDetail(id));
});

const cancelPayoutSchema = z.object({ reason: z.string().trim().min(3).max(300) });

/**
 * Stop a withdrawal that hasn't reached the bank and restore the space's
 * balance. Awaiting approval: cancelled. Pending: only once 9jaPay confirms it
 * has no transfer under this reference (a timed-out send leaves it pending
 * while the transfer may exist). Processing: never — recheck instead.
 */
adminPaymentsRouter.post('/payouts/:id/cancel', requireAdminPermission('payouts'), validate(cancelPayoutSchema), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { reason } = req.body as z.infer<typeof cancelPayoutSchema>;
  const p = await db.payout.findUnique({ where: { id } });
  if (!p) {
    errors.notFound(res, 'No withdrawal with that id');
    return;
  }
  const why = `Stopped by Duevy: ${reason}`;
  if (p.status === 'awaiting_approval') {
    if (!(await cancelPayout(id, why))) {
      errors.conflict(res, 'PAYOUT_NOT_CANCELLABLE', 'This withdrawal has already moved on. Refresh and try again.');
      return;
    }
  } else if (p.status === 'pending') {
    let exists = true;
    try {
      await getPaymentProvider().getTransfer(p.reference);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'NOT_FOUND') exists = false;
      else throw providerUnavailable(err);
    }
    if (exists) {
      // 9jaPay has it: apply its answer rather than cancelling under it.
      await refreshPayout(id).catch(() => {});
      errors.conflict(res, 'TRANSFER_EXISTS', '9jaPay already has this transfer, so it can’t be stopped. Its status has been refreshed.');
      return;
    }
    if (!(await failPayout(id, why, 'ADMIN_CANCELLED'))) {
      errors.conflict(res, 'PAYOUT_NOT_CANCELLABLE', 'This withdrawal has already moved on. Refresh and try again.');
      return;
    }
  } else {
    errors.conflict(
      res,
      'PAYOUT_NOT_CANCELLABLE',
      p.status === 'processing' ? 'This withdrawal is already with the bank. Recheck it with 9jaPay instead.' : `A ${p.status} withdrawal can’t be stopped.`,
    );
    return;
  }
  await writeAdminAudit(req, 'payout.cancelled', { target: p.reference, severity: 'critical', metadata: { reason, from: p.status, amountKobo: p.amount } });
  ok(res, await payoutDetail(id));
});

function providerUnavailable(err: unknown): unknown {
  if (err instanceof ProviderError) return new AppError(502, 'PROVIDER_UNAVAILABLE', `9jaPay didn’t answer: ${err.message}`);
  return err;
}

// ---------------------------------------------------------------------------
// Sweeps: business account → space accounts
// ---------------------------------------------------------------------------
type SweepRow = Prisma.SweepGetPayload<object>;

function serializeSweepRow(s: SweepRow) {
  return {
    id: s.id,
    reference: s.reference,
    providerReference: s.providerReference,
    amount: s.amountKobo,
    fee: s.feeKobo,
    status: s.status,
    trigger: s.trigger,
    failureReason: s.failureReason,
    createdAt: s.createdAt.toISOString(),
    processingAt: s.processingAt?.toISOString() ?? null,
    settledAt: s.settledAt?.toISOString() ?? null,
    failedAt: s.failedAt?.toISOString() ?? null,
  };
}

const sweepsQuerySchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.nativeEnum(SweepStatus).optional()),
  trigger: z.preprocess((v) => (v === '' ? undefined : v), z.nativeEnum(SweepTrigger).optional()),
  spaceId: z.string().optional(),
});

adminPaymentsRouter.get('/sweeps', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const query = sweepsQuerySchema.safeParse(req.query);
  if (!query.success) {
    errors.validation(res, query.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const where: Prisma.SweepWhereInput = {};
  if (query.data.status) where.status = query.data.status;
  if (query.data.trigger) where.trigger = query.data.trigger;
  if (query.data.spaceId) where.spaceId = query.data.spaceId;
  if (q) where.OR = [{ reference: { contains: q, mode: 'insensitive' } }, { space: { name: { contains: q, mode: 'insensitive' } } }];
  const [total, rows] = await Promise.all([
    db.sweep.count({ where }),
    db.sweep.findMany({
      where,
      include: { space: { select: { id: true, name: true, short: true } }, _count: { select: { payouts: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);
  ok(
    res,
    rows.map((s) => ({ ...serializeSweepRow(s), space: s.space, waitingPayouts: s._count.payouts })),
    200,
    buildMeta(page, perPage, total),
  );
});

adminPaymentsRouter.post('/sweeps/:id/recheck', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const s = await db.sweep.findUnique({ where: { id }, select: { reference: true, status: true } });
  if (!s) {
    errors.notFound(res, 'No sweep with that id');
    return;
  }
  try {
    await refreshSweep(id);
  } catch (err) {
    throw providerUnavailable(err);
  }
  const after = await db.sweep.findUniqueOrThrow({ where: { id }, include: { space: { select: { id: true, name: true, short: true } }, _count: { select: { payouts: true } } } });
  await writeAdminAudit(req, 'sweep.rechecked', { target: s.reference, metadata: { before: s.status, after: after.status } });
  ok(res, { ...serializeSweepRow(after), space: after.space, waitingPayouts: after._count.payouts });
});

// ---------------------------------------------------------------------------
// Direct deposits: money sent straight to a space's account
// ---------------------------------------------------------------------------
adminPaymentsRouter.get('/direct-deposits', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const where: Prisma.DirectDepositWhereInput = {};
  if (typeof req.query.spaceId === 'string' && req.query.spaceId) where.spaceId = req.query.spaceId;
  if (q) {
    where.OR = [
      { senderName: { contains: q, mode: 'insensitive' } },
      { narration: { contains: q, mode: 'insensitive' } },
      { providerTransactionId: { contains: q, mode: 'insensitive' } },
      { space: { name: { contains: q, mode: 'insensitive' } } },
    ];
  }
  const [total, sum, rows] = await Promise.all([
    db.directDeposit.count({ where }),
    db.directDeposit.aggregate({ where, _sum: { amountKobo: true } }),
    db.directDeposit.findMany({ where, include: { space: { select: { id: true, name: true, short: true } } }, orderBy: { receivedAt: 'desc' }, skip, take }),
  ]);
  ok(
    res,
    rows.map((d) => ({
      id: d.id,
      transactionId: d.providerTransactionId,
      amount: d.amountKobo,
      senderName: d.senderName,
      senderBank: d.senderBank,
      // Masked: only the last 4 digits identify the sender to an admin.
      senderAccount: d.senderAccountNumber ? `•••• ${d.senderAccountNumber.slice(-4)}` : null,
      narration: d.narration,
      space: d.space,
      receivedAt: d.receivedAt.toISOString(),
    })),
    200,
    { ...buildMeta(page, perPage, total), totalAmount: sum._sum.amountKobo ?? 0 },
  );
});

// ---------------------------------------------------------------------------
// Webhook events from 9jaPay
// ---------------------------------------------------------------------------
/** Every column but the (large) raw payload. */
const WEBHOOK_ROW = { id: true, provider: true, providerEventId: true, type: true, status: true, attempts: true, error: true, nextAttemptAt: true, receivedAt: true, processedAt: true } as const;

const webhooksQuerySchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.nativeEnum(WebhookStatus).optional()),
});

function serializeWebhookRow(e: { id: string; provider: string; providerEventId: string; type: string; status: WebhookStatus; attempts: number; error: string | null; nextAttemptAt: Date; receivedAt: Date; processedAt: Date | null }) {
  return {
    id: e.id,
    provider: e.provider,
    eventId: e.providerEventId,
    type: e.type,
    status: e.status,
    attempts: e.attempts,
    error: e.error,
    nextAttemptAt: e.status === 'failed' || e.status === 'received' ? e.nextAttemptAt.toISOString() : null,
    receivedAt: e.receivedAt.toISOString(),
    processedAt: e.processedAt?.toISOString() ?? null,
  };
}

adminPaymentsRouter.get('/webhooks', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const query = webhooksQuerySchema.safeParse(req.query);
  if (!query.success) {
    errors.validation(res, query.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const where: Prisma.WebhookEventWhereInput = { provider: { not: 'anchor' } };
  if (query.data.status) where.status = query.data.status;
  if (q) where.OR = [{ providerEventId: { contains: q, mode: 'insensitive' } }, { type: { contains: q, mode: 'insensitive' } }];
  const [total, rows] = await Promise.all([
    db.webhookEvent.count({ where }),
    db.webhookEvent.findMany({ where, select: WEBHOOK_ROW, orderBy: { receivedAt: 'desc' }, skip, take }),
  ]);
  ok(res, rows.map(serializeWebhookRow), 200, buildMeta(page, perPage, total));
});

adminPaymentsRouter.get('/webhooks/:id', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const e = await db.webhookEvent.findUnique({ where: { id: req.params.id as string } });
  if (!e) {
    errors.notFound(res, 'No webhook event with that id');
    return;
  }
  ok(res, { ...serializeWebhookRow(e), payload: e.payload });
});

/** Put a failed or dead event back on the queue now. Safe: every handler is idempotent. */
adminPaymentsRouter.post('/webhooks/:id/retry', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { count } = await db.webhookEvent.updateMany({
    where: { id, status: { in: ['failed', 'dead'] } },
    data: { status: 'received', attempts: 0, nextAttemptAt: new Date(), lockedAt: null },
  });
  if (count === 0) {
    const exists = await db.webhookEvent.count({ where: { id } });
    if (!exists) errors.notFound(res, 'No webhook event with that id');
    else errors.conflict(res, 'WEBHOOK_NOT_RETRYABLE', 'Only failed or dead events can be retried.');
    return;
  }
  const e = await db.webhookEvent.findUniqueOrThrow({ where: { id }, select: WEBHOOK_ROW });
  await writeAdminAudit(req, 'webhook.retried', { target: e.providerEventId, metadata: { type: e.type } });
  ok(res, serializeWebhookRow(e));
});

// ---------------------------------------------------------------------------
// A space's 9jaPay account
// ---------------------------------------------------------------------------
async function spaceMoney(spaceId: string) {
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: {
      id: true,
      name: true,
      short: true,
      isArchived: true,
      payoutsFrozen: true,
      frozenReason: true,
      withdrawalAuthMode: true,
      withdrawalPinHoldUntil: true,
      walletAccountNumber: true,
      walletAccountName: true,
      walletBankName: true,
      walletCreatedAt: true,
      walletDepositsCheckedAt: true,
    },
  });
  if (!space) return null;
  const balance = getSpaceBalance(spaceId);
  const [funds, dailyUsage, balanceKobo, payouts, sweeps, deposits] = await Promise.all([
    getSpaceFunds(spaceId, balance),
    getDailyUsageKobo(spaceId),
    balance,
    db.payout.findMany({ where: { spaceId }, orderBy: { requestedAt: 'desc' }, take: 5 }),
    db.sweep.findMany({ where: { spaceId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    db.directDeposit.findMany({ where: { spaceId }, orderBy: { receivedAt: 'desc' }, take: 5 }),
  ]);
  return {
    space: { id: space.id, name: space.name, short: space.short, isArchived: space.isArchived, payoutsFrozen: space.payoutsFrozen, frozenReason: space.frozenReason, authMode: space.withdrawalAuthMode },
    account: space.walletAccountNumber
      ? {
          accountNumber: space.walletAccountNumber,
          accountName: space.walletAccountName,
          bankName: space.walletBankName,
          openedAt: space.walletCreatedAt?.toISOString() ?? null,
          depositsCheckedAt: space.walletDepositsCheckedAt?.toISOString() ?? null,
        }
      : null,
    balanceKobo,
    ...funds,
    accountDailyLimitKobo: DAILY_LIMIT_KOBO,
    accountDailyUsedKobo: dailyUsage,
    withdrawalHoldUntil: space.withdrawalPinHoldUntil && space.withdrawalPinHoldUntil > new Date() ? space.withdrawalPinHoldUntil.toISOString() : null,
    recentPayouts: payouts.map((p) => ({ id: p.id, reference: p.reference, amount: p.amount, status: p.status, account: p.accountMasked, requestedAt: p.requestedAt.toISOString() })),
    recentSweeps: sweeps.map(serializeSweepRow),
    recentDeposits: deposits.map((d) => ({ id: d.id, amount: d.amountKobo, senderName: d.senderName, senderBank: d.senderBank, receivedAt: d.receivedAt.toISOString() })),
  };
}

adminPaymentsRouter.get('/spaces/:spaceId/money', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const out = await spaceMoney(req.params.spaceId as string);
  if (!out) {
    errors.notFound(res, 'Space not found');
    return;
  }
  ok(res, out);
});

/** Open the space's 9jaPay account if it has none (creation can fail; the daily job also retries). */
adminPaymentsRouter.post('/spaces/:spaceId/account', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.params.spaceId as string;
  const space = await db.space.findUnique({ where: { id: spaceId }, select: { walletAccountNumber: true, isArchived: true } });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  if (space.isArchived) {
    errors.conflict(res, 'SPACE_ARCHIVED', 'An archived space can’t get a new account.');
    return;
  }
  if (!space.walletAccountNumber) {
    try {
      await ensureSpaceAccount(spaceId);
    } catch (err) {
      throw providerUnavailable(err);
    }
    await writeAdminAudit(req, 'space.account_opened', { target: spaceId, severity: 'warning' });
  }
  ok(res, await spaceMoney(spaceId));
});

/** Sweep the space's collections into its account now, within today's limits. */
adminPaymentsRouter.post('/spaces/:spaceId/sweep', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.params.spaceId as string;
  const space = await db.space.findUnique({ where: { id: spaceId }, select: { isArchived: true } });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  let sweeps;
  try {
    sweeps = await startSweep(spaceId, 'manual');
  } catch (err) {
    throw providerUnavailable(err);
  }
  if (sweeps.length > 0) {
    const amountKobo = sweeps.reduce((s, x) => s + x.amountKobo, 0);
    await writeAdminAudit(req, 'space.swept', { target: spaceId, severity: 'warning', metadata: { amountKobo, references: sweeps.map((s) => s.reference) } });
  }
  ok(res, { started: sweeps.length, amountKobo: sweeps.reduce((s, x) => s + x.amountKobo, 0), money: await spaceMoney(spaceId) });
});

/** Read the space's account at 9jaPay now and credit any direct deposit not yet recorded. */
adminPaymentsRouter.post('/spaces/:spaceId/deposits/sync', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.params.spaceId as string;
  const exists = await db.space.count({ where: { id: spaceId } });
  if (!exists) {
    errors.notFound(res, 'Space not found');
    return;
  }
  let recorded: number;
  try {
    recorded = await syncDirectDeposits(spaceId);
  } catch (err) {
    throw providerUnavailable(err);
  }
  if (recorded > 0) await writeAdminAudit(req, 'space.deposits_synced', { target: spaceId, metadata: { recorded } });
  ok(res, { recorded, money: await spaceMoney(spaceId) });
});
