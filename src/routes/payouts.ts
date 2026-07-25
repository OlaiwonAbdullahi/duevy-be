import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type RepRole, type PayoutStatus } from '@prisma/client';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePayout, serializeBankAccount } from '../lib/serializers';
import { encrypt, decrypt, maskAccountNumber } from '../lib/encryption';
import { getBanks, verifyAccountName, createSubaccount, updateSubaccount, getActiveGatewayName } from '../lib/paymentGateway';
import { generatePayoutReference, PLATFORM_PERCENTAGE_CHARGE } from '../lib/money';
import { writeAudit } from '../lib/audit';
import { sendEmail, renderEmail } from '../lib/email';
import { castPayoutApproval, getApprovalStatus } from '../services/payoutApproval.service';

// Mounted at /spaces/:spaceId; every route is rep-gated.
export const payoutsRouter = Router({ mergeParams: true });
payoutsRouter.use(requireSpaceRep());

const CLEARING_WINDOW_MS = 24 * 60 * 60 * 1000; // funds clear 24h after payment
const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h hold after an account change
// A payout awaiting votes already reserves its funds, same as one that's
// processing/completed — otherwise a second concurrent request could see
// the same money as still "available" while the first is mid-approval.
const RESERVED_STATUSES: PayoutStatus[] = ['pending_approval', 'processing', 'completed'];

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function spaceId(req: Request): string {
  return req.params.spaceId as string;
}
async function actor(req: Request): Promise<{ id: string; name: string; role: RepRole | null }> {
  const id = uid(req);
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  const role = (req as AuthenticatedRequest).spaceRep?.role ?? null;
  return { id, name: u?.name ?? 'Rep', role };
}

/** Unique payout reference, retrying on the rare collision. */
async function uniquePayoutReference(): Promise<string> {
  let reference = generatePayoutReference();
  for (let i = 0; i < 5; i++) {
    if (!(await db.payout.findUnique({ where: { reference } }))) break;
    reference = generatePayoutReference();
  }
  return reference;
}

/**
 * Payout balances, all net of the 3% charge (fees are taken at collection).
 *  available = cleared collections − (reserved payouts)
 *  pending   = collections still inside the clearing window
 *  lifetime  = total ever completed
 * Pass `dueId` to scope every figure to a single due's own payments/payouts.
 */
async function computeBalances(sid: string, dueId?: string) {
  const clearedThreshold = new Date(Date.now() - CLEARING_WINDOW_MS);
  const paymentWhere = dueId ? { due: { spaceId: sid }, dueId } : { due: { spaceId: sid } };
  const payoutWhere = dueId
    ? { spaceId: sid, dueId, status: { in: RESERVED_STATUSES } }
    : { spaceId: sid, status: { in: RESERVED_STATUSES } };
  const lifetimeWhere = dueId
    ? { spaceId: sid, dueId, status: 'completed' as const }
    : { spaceId: sid, status: 'completed' as const };

  const [cleared, pending, reserved, lifetime] = await Promise.all([
    db.duePayment.aggregate({ where: { ...paymentWhere, paidAt: { lte: clearedThreshold } }, _sum: { netToSpace: true } }),
    db.duePayment.aggregate({ where: { ...paymentWhere, paidAt: { gt: clearedThreshold } }, _sum: { netToSpace: true } }),
    db.payout.aggregate({ where: payoutWhere, _sum: { amount: true } }),
    db.payout.aggregate({ where: lifetimeWhere, _sum: { amount: true } }),
  ]);
  const clearedNet = cleared._sum.netToSpace ?? 0;
  return {
    available: Math.max(0, clearedNet - (reserved._sum.amount ?? 0)),
    pending: pending._sum.netToSpace ?? 0,
    lifetime: lifetime._sum.amount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// GET /payout/summary (§10.1)
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/summary', async (req: Request, res: Response): Promise<void> => {
  ok(res, await computeBalances(spaceId(req)));
});

// ---------------------------------------------------------------------------
// GET /payout/breakdown — how the money behind the payout numbers was made:
// gross collected, fees taken, net to space, itemized per due. Optional
// from/to (YYYY-MM-DD) to scope it to a period; omit both for all-time.
// ---------------------------------------------------------------------------
const breakdownQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
});

payoutsRouter.get('/payout/breakdown', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const parsed = breakdownQuery.safeParse(req.query);
  if (!parsed.success) {
    errors.validation(res, parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })));
    return;
  }
  const { page, perPage, skip, take } = parseListQuery(req);

  const paidAt: { gte?: Date; lte?: Date } = {};
  if (parsed.data.from) paidAt.gte = new Date(`${parsed.data.from}T00:00:00Z`);
  if (parsed.data.to) paidAt.lte = new Date(`${parsed.data.to}T23:59:59Z`);
  const paymentWhere = Object.keys(paidAt).length ? { paidAt } : {};

  const [totals, dueCount, byDueRaw] = await Promise.all([
    db.duePayment.aggregate({
      where: { due: { spaceId: sid }, ...paymentWhere },
      _sum: { amountPaid: true, monnifyFee: true, duevyFee: true, netToSpace: true },
      _count: { _all: true },
    }),
    db.due.count({ where: { spaceId: sid, payments: { some: paymentWhere } } }),
    db.duePayment.groupBy({
      by: ['dueId'],
      where: { due: { spaceId: sid }, ...paymentWhere },
      _sum: { amountPaid: true, monnifyFee: true, duevyFee: true, netToSpace: true },
      _count: { _all: true },
      orderBy: { _sum: { netToSpace: 'desc' } },
      skip,
      take,
    }),
  ]);

  const dues = await db.due.findMany({
    where: { id: { in: byDueRaw.map((d) => d.dueId) } },
    select: { id: true, title: true, category: true },
  });
  const dueById = new Map(dues.map((d) => [d.id, d]));

  const byDue = byDueRaw.map((d) => ({
    dueId: d.dueId,
    title: dueById.get(d.dueId)?.title ?? 'Unknown due',
    category: dueById.get(d.dueId)?.category ?? null,
    paidCount: d._count._all,
    collected: d._sum.amountPaid ?? 0,
    fees: (d._sum.monnifyFee ?? 0) + (d._sum.duevyFee ?? 0),
    net: d._sum.netToSpace ?? 0,
  }));

  ok(
    res,
    {
      totals: {
        collected: totals._sum.amountPaid ?? 0,
        fees: (totals._sum.monnifyFee ?? 0) + (totals._sum.duevyFee ?? 0),
        net: totals._sum.netToSpace ?? 0,
        paidCount: totals._count._all,
      },
      byDue,
    },
    200,
    buildMeta(page, perPage, dueCount),
  );
});

// ---------------------------------------------------------------------------
// GET /payout/account (§10.2)
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/account', async (req: Request, res: Response): Promise<void> => {
  const account = await db.bankAccount.findUnique({ where: { spaceId: spaceId(req) } });
  if (!account) {
    fail(res, 404, 'NO_PAYOUT_ACCOUNT', 'No payout account has been set for this space');
    return;
  }
  ok(res, serializeBankAccount(account)); // masked
});

// ---------------------------------------------------------------------------
// Shared bank + account-name resolution (§10.2) — name-enquiry is authoritative
// and mandatory; the account name is always server-resolved, never client-supplied.
// ---------------------------------------------------------------------------
const accountLookupSchema = z.object({
  bankCode: z.string().min(3),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});

type ResolvedAccount = { bankName: string; accountName: string } | { error: 'UNKNOWN_BANK' | 'UNVERIFIABLE' };

async function resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
  const banks = await getBanks();
  const bankName = banks.find((b) => b.code === bankCode)?.name;
  if (!bankName) return { error: 'UNKNOWN_BANK' };

  const accountName = await verifyAccountName(accountNumber, bankCode);
  if (!accountName) return { error: 'UNVERIFIABLE' };

  return { bankName, accountName };
}

function failResolution(res: Response, resolved: { error: 'UNKNOWN_BANK' | 'UNVERIFIABLE' }): void {
  if (resolved.error === 'UNKNOWN_BANK') {
    errors.validation(res, [{ field: 'bankCode', issue: 'unknown bank code' }]);
    return;
  }
  fail(res, 422, 'ACCOUNT_UNVERIFIABLE', 'Could not verify this account number with the selected bank');
}

// ---------------------------------------------------------------------------
// POST /payout/account/lookup (§10.2) — preview the resolved account name
// before saving it, mirroring the join-code lookup pattern (§4.3).
// ---------------------------------------------------------------------------
payoutsRouter.post('/payout/account/lookup', validate(accountLookupSchema), async (req: Request, res: Response): Promise<void> => {
  const { bankCode, accountNumber } = req.body as z.infer<typeof accountLookupSchema>;

  const resolved = await resolveAccount(bankCode, accountNumber);
  if ('error' in resolved) {
    failResolution(res, resolved);
    return;
  }

  ok(res, { bankCode, bankName: resolved.bankName, accountNumber, accountName: resolved.accountName });
});

// ---------------------------------------------------------------------------
// PUT /payout/account (§10.2)
// ---------------------------------------------------------------------------
const putAccountSchema = accountLookupSchema;

payoutsRouter.put('/payout/account', validate(putAccountSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { bankCode, accountNumber } = req.body as z.infer<typeof putAccountSchema>;

  const resolved = await resolveAccount(bankCode, accountNumber);
  if ('error' in resolved) {
    failResolution(res, resolved);
    return;
  }
  const { bankName, accountName: finalName } = resolved;

  const space = await db.space.findUnique({ where: { id: sid }, select: { name: true, paystackSubaccountCode: true, subaccountGateway: true } });
  const existing = await db.bankAccount.findUnique({ where: { spaceId: sid } });
  const changed =
    !!existing && (decrypt(existing.accountNumber) !== accountNumber || existing.bankCode !== bankCode);

  const masked = maskAccountNumber(accountNumber);
  const cooldownUntil = changed ? new Date(Date.now() + ACCOUNT_COOLDOWN_MS) : existing?.cooldownUntil ?? null;

  // Resolved fresh via the active gateway's own bank list above, so it's
  // current as of right now — tag it so resolveActiveBankCode() can skip
  // re-resolving until the active gateway actually changes again.
  const bankCodeGateway = await getActiveGatewayName();

  // Create or update this space's subaccount for the *currently active*
  // gateway, as one step with saving the bank account — a rep shouldn't have
  // to complete two separate "where my money goes" flows. Subaccount codes
  // are gateway-specific (a Paystack ACCT_... code means nothing to Monnify),
  // so a stored code only counts as reusable if it belongs to this gateway —
  // see resolveActiveSubaccountCode() for the read-side of this same rule.
  let subaccountCode = space?.subaccountGateway === bankCodeGateway ? space.paystackSubaccountCode : null;
  let subaccountGateway = space?.subaccountGateway ?? null;
  try {
    if (!subaccountCode) {
      const created = await createSubaccount({
        businessName: space?.name ?? finalName,
        bankCode,
        accountNumber,
        percentageCharge: PLATFORM_PERCENTAGE_CHARGE,
      });
      subaccountCode = created.subaccountCode;
      subaccountGateway = bankCodeGateway;
    } else if (changed) {
      await updateSubaccount(subaccountCode, { bankCode, accountNumber });
    }
  } catch (err) {
    // Best-effort: a gateway that isn't set up for subaccounts yet (e.g.
    // Monnify's sub-account API requires activation from Monnify support
    // before it can be used at all) shouldn't block saving the bank account
    // itself — payments simply fall back to routing through Duevy's main
    // account until a subaccount exists for this gateway. Leave whatever was
    // previously stored untouched rather than clobbering it with null, so a
    // working code from a *different* gateway survives a failed attempt here.
    console.error(`[payouts] subaccount create/update failed for space ${sid}:`, err);
    subaccountCode = space?.paystackSubaccountCode ?? null;
    subaccountGateway = space?.subaccountGateway ?? null;
  }

  const account = await db.bankAccount.upsert({
    where: { spaceId: sid },
    update: {
      bankCode,
      bankCodeGateway,
      bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName: finalName,
      cooldownUntil,
    },
    create: {
      spaceId: sid,
      bankCode,
      bankCodeGateway,
      bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName: finalName,
    },
  });

  await db.space.update({ where: { id: sid }, data: { paystackSubaccountCode: subaccountCode, subaccountGateway } });

  // Security notice to all reps when an existing account is changed.
  if (changed) {
    const reps = await db.spaceRep.findMany({
      where: { spaceId: sid },
      include: { user: { select: { email: true, name: true } } },
    });
    for (const r of reps) {
      sendEmail({
        to: r.user.email,
        subject: 'Duevy payout account changed',
        html: renderEmail(
          `
          <h1>Payout account changed</h1>
          <p>Hi ${r.user.name}, the payout bank account for your space was changed to <strong>${bankName} ${masked}</strong>.</p>
          <div class="callout">Payouts are held for 24 hours as a security measure.</div>
          <p class="muted">If this wasn't you, contact support immediately at support@duevy.app</p>
        `,
          '#b01e4e',
        ),
      }).catch(console.error);
    }
  }

  ok(res, serializeBankAccount(account, accountNumber)); // PUT echo reveals the number
});

// ---------------------------------------------------------------------------
// POST /payout/request (§10.3) — Idempotency-Key required
// ---------------------------------------------------------------------------
const requestSchema = z.object({
  amount: z.number().int().positive(),
  note: z.string().max(300).optional(),
});

payoutsRouter.post(
  '/payout/request',
  requireSpaceRep(true), // space-wide payout access is lead-only; co-reps use the due-scoped endpoint below
  requireIdempotencyKey,
  idempotent,
  validate(requestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { amount, note } = req.body as z.infer<typeof requestSchema>;

    const space = await db.space.findUnique({ where: { id: sid }, select: { payoutsFrozen: true } });
    if (space?.payoutsFrozen) {
      fail(res, 423, 'PAYOUTS_FROZEN', 'Payouts for this space are currently frozen');
      return;
    }

    const account = await db.bankAccount.findUnique({ where: { spaceId: sid } });
    if (!account) {
      errors.conflict(res, 'NO_PAYOUT_ACCOUNT', 'Set a payout account before requesting a payout');
      return;
    }
    if (account.cooldownUntil && account.cooldownUntil > new Date()) {
      errors.conflict(res, 'ACCOUNT_COOLDOWN', 'Payouts are on hold after a recent account change');
      return;
    }

    const { available } = await computeBalances(sid);
    if (amount > available) {
      fail(res, 402, 'INSUFFICIENT_PAYOUT_BALANCE', 'Requested amount exceeds the available balance');
      return;
    }

    const reference = await uniquePayoutReference();
    const accountMasked = `${account.bankName} ${account.accountNumberMasked}`;
    const actorInfo = await actor(req);

    const payout = await db.$transaction(async (tx) => {
      const created = await tx.payout.create({
        data: { spaceId: sid, amount, reference, status: 'pending_approval', accountMasked, note, requestedById: uid(req) },
      });
      await writeAudit(sid, actorInfo, 'payout_requested', `Requested a ₦${(amount / 100).toLocaleString('en-NG')} payout`, tx);
      return created;
    });

    // The requester's own request counts as an implicit "yes" vote — a
    // solo-rep space (no co-reps) reaches 70% immediately, same as before.
    const { payout: final } = await castPayoutApproval(payout.id, actorInfo, 'approved');
    ok(res, serializePayout(final), 201);
  },
);

// ---------------------------------------------------------------------------
// GET /dues/{dueId}/payout/summary — balance available against a single due
// ---------------------------------------------------------------------------
payoutsRouter.get('/dues/:dueId/payout/summary', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const due = await db.due.findUnique({ where: { id: req.params.dueId as string } });
  if (!due || due.spaceId !== sid) {
    errors.notFound(res, 'Due not found');
    return;
  }
  ok(res, await computeBalances(sid, due.id));
});

// ---------------------------------------------------------------------------
// POST /dues/{dueId}/payout/request — the lead, or the due's assigned co-rep,
// can request a payout scoped to just that due's collected funds.
// ---------------------------------------------------------------------------
payoutsRouter.post(
  '/dues/:dueId/payout/request',
  requireIdempotencyKey,
  idempotent,
  validate(requestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { amount, note } = req.body as z.infer<typeof requestSchema>;

    const due = await db.due.findUnique({ where: { id: req.params.dueId as string } });
    if (!due || due.spaceId !== sid) {
      errors.notFound(res, 'Due not found');
      return;
    }

    const rep = (req as AuthenticatedRequest).spaceRep!; // guaranteed by the router-level requireSpaceRep()
    if (rep.role !== 'lead' && due.assignedRepId !== uid(req)) {
      errors.forbidden(res, "Only the lead or this due's assigned rep can request a payout against it");
      return;
    }

    const space = await db.space.findUnique({ where: { id: sid }, select: { payoutsFrozen: true } });
    if (space?.payoutsFrozen) {
      fail(res, 423, 'PAYOUTS_FROZEN', 'Payouts for this space are currently frozen');
      return;
    }

    const account = await db.bankAccount.findUnique({ where: { spaceId: sid } });
    if (!account) {
      errors.conflict(res, 'NO_PAYOUT_ACCOUNT', 'Set a payout account before requesting a payout');
      return;
    }
    if (account.cooldownUntil && account.cooldownUntil > new Date()) {
      errors.conflict(res, 'ACCOUNT_COOLDOWN', 'Payouts are on hold after a recent account change');
      return;
    }

    // A due-scoped balance only sees that due's own payments/payouts — clamp
    // against the space-wide available too, so two dues can't collectively
    // overcommit the space's one real bank balance.
    const [dueScoped, spaceWide] = await Promise.all([computeBalances(sid, due.id), computeBalances(sid)]);
    const available = Math.min(dueScoped.available, spaceWide.available);
    if (amount > available) {
      fail(res, 402, 'INSUFFICIENT_PAYOUT_BALANCE', 'Requested amount exceeds the available balance for this due');
      return;
    }

    const reference = await uniquePayoutReference();
    const accountMasked = `${account.bankName} ${account.accountNumberMasked}`;
    const actorInfo = await actor(req);

    const payout = await db.$transaction(async (tx) => {
      const created = await tx.payout.create({
        data: {
          spaceId: sid,
          dueId: due.id,
          amount,
          reference,
          status: 'pending_approval',
          accountMasked,
          note,
          requestedById: uid(req),
        },
      });
      await writeAudit(
        sid,
        actorInfo,
        'payout_requested',
        `Requested a ₦${(amount / 100).toLocaleString('en-NG')} payout against due "${due.title}"`,
        tx,
      );
      return created;
    });

    const { payout: final } = await castPayoutApproval(payout.id, actorInfo, 'approved');
    ok(res, serializePayout(final), 201);
  },
);

// ---------------------------------------------------------------------------
// POST /payout/{payoutId}/approve — any rep casts/changes their vote
// ---------------------------------------------------------------------------
const approveSchema = z.object({ decision: z.enum(['approved', 'rejected']) });

payoutsRouter.post(
  '/payout/:payoutId/approve',
  validate(approveSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const payoutId = req.params.payoutId as string;
    const { decision } = req.body as z.infer<typeof approveSchema>;

    const payout = await db.payout.findUnique({ where: { id: payoutId } });
    if (!payout || payout.spaceId !== sid) {
      errors.notFound(res, 'Payout not found');
      return;
    }
    if (payout.status !== 'pending_approval') {
      errors.conflict(res, 'NOT_PENDING_APPROVAL', 'This payout is no longer awaiting approval');
      return;
    }

    const actorInfo = await actor(req);
    await writeAudit(
      sid,
      actorInfo,
      'payout_approval_cast',
      `${decision === 'approved' ? 'Approved' : 'Rejected'} payout ${payout.reference}`,
    );

    const { payout: updated, status } = await castPayoutApproval(payoutId, actorInfo, decision);
    ok(res, { payout: serializePayout(updated), approval: status });
  },
);

// ---------------------------------------------------------------------------
// POST /payout/{payoutId}/cancel — the requester or the lead, only while
// still pending_approval (a rejected-heavy vote otherwise has no exit path)
// ---------------------------------------------------------------------------
const cancelSchema = z.object({ reason: z.string().max(300).optional() });

payoutsRouter.post(
  '/payout/:payoutId/cancel',
  validate(cancelSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const payout = await db.payout.findUnique({ where: { id: req.params.payoutId as string } });
    if (!payout || payout.spaceId !== sid) {
      errors.notFound(res, 'Payout not found');
      return;
    }
    if (payout.status !== 'pending_approval') {
      errors.conflict(res, 'NOT_PENDING_APPROVAL', 'Only a payout still awaiting approval can be cancelled');
      return;
    }

    const rep = (req as AuthenticatedRequest).spaceRep!;
    if (rep.role !== 'lead' && payout.requestedById !== uid(req)) {
      errors.forbidden(res, 'Only the requester or the lead can cancel this payout');
      return;
    }

    const { reason } = req.body as z.infer<typeof cancelSchema>;
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.payout.update({ where: { id: payout.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
      await writeAudit(sid, await actor(req), 'payout_cancelled', `Cancelled payout ${payout.reference}${reason ? `: ${reason}` : ''}`, tx);
      return u;
    });

    ok(res, serializePayout(updated));
  },
);

// ---------------------------------------------------------------------------
// GET /payout/{payoutId} — a single payout with its approval progress, so a
// pending_approval payout isn't a black box while reps are voting on it.
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/:payoutId', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const payout = await db.payout.findUnique({ where: { id: req.params.payoutId as string } });
  if (!payout || payout.spaceId !== sid) {
    errors.notFound(res, 'Payout not found');
    return;
  }

  const [status, decisions] = await Promise.all([
    getApprovalStatus(payout.id, sid),
    db.payoutApproval.findMany({
      where: { payoutId: payout.id },
      include: { rep: { select: { name: true } } },
      orderBy: { decidedAt: 'asc' },
    }),
  ]);

  ok(res, {
    ...serializePayout(payout),
    approval: {
      ...status,
      decisions: decisions.map((d) => ({ repUserId: d.repUserId, repName: d.rep.name, decision: d.decision, decidedAt: d.decidedAt.toISOString() })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /payouts (§10.4)
// ---------------------------------------------------------------------------
payoutsRouter.get('/payouts', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { page, perPage, skip, take } = parseListQuery(req);

  const [total, payouts] = await Promise.all([
    db.payout.count({ where: { spaceId: sid } }),
    db.payout.findMany({ where: { spaceId: sid }, orderBy: { requestedAt: 'desc' }, skip, take }),
  ]);

  ok(res, payouts.map(serializePayout), 200, buildMeta(page, perPage, total));
});
