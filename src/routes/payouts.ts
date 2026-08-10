import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
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
import { getBanksForAccount, resolveAccountName, createPayoutDestination } from '../lib/bachs';
import { generatePayoutReference } from '../lib/money';
import { writeAudit } from '../lib/audit';
import { sendEmail, renderEmail } from '../lib/email';
import { castPayoutApproval, getApprovalStatus } from '../services/payoutApproval.service';
import { initiatePayoutDisbursement } from '../services/payout.service';
import {
  ensureConnectedAccount,
  getOnboardingChecklist,
  uploadOnboardingDocument,
  submitOnboarding,
  getOnboardingIdentityMethods,
  submitOnboardingNin,
  getOnboardingIdentityStatus,
  NoConnectedAccountError,
} from '../services/connectAccount.service';

// Mounted at /spaces/:spaceId; every route is rep-gated.
export const payoutsRouter = Router({ mergeParams: true });
payoutsRouter.use(requireSpaceRep());

const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h hold after an account change
// A payout awaiting votes already reserves its funds, same as one that's
// processing/completed — otherwise a second concurrent request could see
// the same money as still "available" while the first is mid-approval.
// `pending_approval` no longer occurs going forward (quorum bypassed for
// MVP — see POST /payout/request below) but is kept here so any lingering
// historical row still reserves correctly.
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

function handleConnectAccountError(res: Response, err: unknown): boolean {
  if (err instanceof NoConnectedAccountError) {
    errors.conflict(res, 'NO_CONNECTED_ACCOUNT', err.message);
    return true;
  }
  return false;
}

/**
 * Payout balances, all net of the 3% charge (fees are taken at collection).
 *  available = cleared collections (already transferred into this space's own
 *              Bachs connected-account balance — see sweepSettledDuePayments())
 *              − reserved payouts
 *  pending   = collections not yet transferred
 *  lifetime  = total ever completed
 * Pass `dueId` to scope every figure to a single due's own payments/payouts.
 */
async function computeBalances(sid: string, dueId?: string) {
  const paymentWhere = dueId ? { due: { spaceId: sid }, dueId } : { due: { spaceId: sid } };
  const payoutWhere = dueId
    ? { spaceId: sid, dueId, status: { in: RESERVED_STATUSES } }
    : { spaceId: sid, status: { in: RESERVED_STATUSES } };
  const lifetimeWhere = dueId
    ? { spaceId: sid, dueId, status: 'completed' as const }
    : { spaceId: sid, status: 'completed' as const };

  const [cleared, pending, reserved, lifetime] = await Promise.all([
    db.duePayment.aggregate({ where: { ...paymentWhere, transferredAt: { not: null } }, _sum: { netToSpace: true } }),
    db.duePayment.aggregate({ where: { ...paymentWhere, transferredAt: null }, _sum: { netToSpace: true } }),
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
      _sum: { amountPaid: true, processingFee: true, duevyFee: true, netToSpace: true },
      _count: { _all: true },
    }),
    db.due.count({ where: { spaceId: sid, payments: { some: paymentWhere } } }),
    db.duePayment.groupBy({
      by: ['dueId'],
      where: { due: { spaceId: sid }, ...paymentWhere },
      _sum: { amountPaid: true, processingFee: true, duevyFee: true, netToSpace: true },
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
    fees: (d._sum.processingFee ?? 0) + (d._sum.duevyFee ?? 0),
    net: d._sum.netToSpace ?? 0,
  }));

  ok(
    res,
    {
      totals: {
        collected: totals._sum.amountPaid ?? 0,
        fees: (totals._sum.processingFee ?? 0) + (totals._sum.duevyFee ?? 0),
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
// Shared bank + account-name resolution (§10.2) — scoped to the space's own
// Bachs connected account; name-enquiry is authoritative and mandatory, the
// account name is always server-resolved, never client-supplied.
// ---------------------------------------------------------------------------
const accountLookupSchema = z.object({
  bankCode: z.string().min(3),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});

type ResolvedAccount = { bankName: string; accountName: string } | { error: 'UNKNOWN_BANK' | 'UNVERIFIABLE' };

async function resolveBankDetails(accountId: string, bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
  const banks = await getBanksForAccount(accountId);
  const bankName = banks.find((b) => b.code === bankCode)?.name;
  if (!bankName) return { error: 'UNKNOWN_BANK' };

  const accountName = await resolveAccountName(accountId, accountNumber, bankCode);
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
// before saving it, mirroring the join-code lookup pattern (§4.3). Ensures
// the space has a Bachs connected account first (harmless, no financial
// commitment — just a contact-email registration) since bank lookup is
// scoped per connected account under Bachs.
// ---------------------------------------------------------------------------
payoutsRouter.post('/payout/account/lookup', validate(accountLookupSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { bankCode, accountNumber } = req.body as z.infer<typeof accountLookupSchema>;

  const actorUser = await db.user.findUnique({ where: { id: uid(req) }, select: { email: true } });
  try {
    const accountId = await ensureConnectedAccount(sid, actorUser?.email ?? '');
    const resolved = await resolveBankDetails(accountId, bankCode, accountNumber);
    if ('error' in resolved) {
      failResolution(res, resolved);
      return;
    }
    ok(res, { bankCode, bankName: resolved.bankName, accountNumber, accountName: resolved.accountName });
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------------
// PUT /payout/account (§10.2)
// ---------------------------------------------------------------------------
const putAccountSchema = accountLookupSchema;

payoutsRouter.put('/payout/account', validate(putAccountSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { bankCode, accountNumber } = req.body as z.infer<typeof putAccountSchema>;

  const [space, actorUser] = await Promise.all([
    db.space.findUnique({ where: { id: sid }, select: { name: true, bachsPayoutDestinationId: true } }),
    db.user.findUnique({ where: { id: uid(req) }, select: { email: true } }),
  ]);

  const accountId = await ensureConnectedAccount(sid, actorUser?.email ?? '');
  const resolved = await resolveBankDetails(accountId, bankCode, accountNumber);
  if ('error' in resolved) {
    failResolution(res, resolved);
    return;
  }
  const { bankName, accountName: finalName } = resolved;

  const existing = await db.bankAccount.findUnique({ where: { spaceId: sid } });
  const changed =
    !!existing && (decrypt(existing.accountNumber) !== accountNumber || existing.bankCode !== bankCode);

  const masked = maskAccountNumber(accountNumber);
  const cooldownUntil = changed ? new Date(Date.now() + ACCOUNT_COOLDOWN_MS) : existing?.cooldownUntil ?? null;

  // Bachs has no documented "update destination" endpoint — a changed bank
  // detail always registers a fresh payout destination rather than mutating
  // the old one. Best-effort: a failure here shouldn't block saving the bank
  // account itself; leave whatever destination id was previously stored.
  let payoutDestinationId = space?.bachsPayoutDestinationId ?? null;
  if (!payoutDestinationId || changed) {
    try {
      const destination = await createPayoutDestination(accountId, { bankCode, accountNumber, accountName: finalName });
      payoutDestinationId = destination.id;
    } catch (err) {
      console.error(`[payouts] payout-destination create failed for space ${sid}:`, err);
    }
  }

  const account = await db.bankAccount.upsert({
    where: { spaceId: sid },
    update: {
      bankCode,
      bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName: finalName,
      cooldownUntil,
    },
    create: {
      spaceId: sid,
      bankCode,
      bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName: finalName,
    },
  });

  await db.space.update({ where: { id: sid }, data: { bachsPayoutDestinationId: payoutDestinationId } });

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
// In-app Bachs onboarding (Tasks/checklist/uploads/submit + identity) — no
// redirect to a Bachs-hosted page; the frontend renders its own form off
// these proxies.
// ---------------------------------------------------------------------------

payoutsRouter.get('/payout/onboarding/checklist', async (req: Request, res: Response): Promise<void> => {
  try {
    ok(res, await getOnboardingChecklist(spaceId(req)));
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

const onboardingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('file');

payoutsRouter.post('/payout/onboarding/documents', (req: Request, res: Response): void => {
  onboardingUpload(req, res, async (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 10 MB limit' : err.message;
      fail(res, 400, 'VALIDATION_ERROR', msg, [{ field: 'file', issue: msg }]);
      return;
    }
    if (err) {
      fail(res, 400, 'VALIDATION_ERROR', 'Upload failed');
      return;
    }
    if (!req.file) {
      errors.validation(res, [{ field: 'file', issue: 'file is required' }]);
      return;
    }
    const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'document';
    try {
      const result = await uploadOnboardingDocument(
        spaceId(req),
        { buffer: req.file.buffer, filename: req.file.originalname, mimetype: req.file.mimetype },
        scope,
      );
      ok(res, result);
    } catch (e) {
      if (handleConnectAccountError(res, e)) return;
      throw e;
    }
  });
});

const submitOnboardingSchema = z.object({
  draft: z.boolean().default(false),
  data: z.record(z.unknown()),
});

payoutsRouter.post('/payout/onboarding/submit', validate(submitOnboardingSchema), async (req: Request, res: Response): Promise<void> => {
  const { draft, data } = req.body as z.infer<typeof submitOnboardingSchema>;
  try {
    ok(res, await submitOnboarding(spaceId(req), data, draft));
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

payoutsRouter.get('/payout/onboarding/identity/methods', async (req: Request, res: Response): Promise<void> => {
  try {
    ok(res, await getOnboardingIdentityMethods(spaceId(req)));
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

const ninSchema = z.object({
  nin: z.string().min(10).max(11),
  consent: z.literal(true),
  selfie: z.string().optional(),
});

payoutsRouter.post('/payout/onboarding/identity/nin', validate(ninSchema), async (req: Request, res: Response): Promise<void> => {
  const { nin, consent, selfie } = req.body as z.infer<typeof ninSchema>;
  try {
    ok(res, await submitOnboardingNin(spaceId(req), nin, consent, selfie));
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

payoutsRouter.get('/payout/onboarding/identity/status', async (req: Request, res: Response): Promise<void> => {
  try {
    ok(res, await getOnboardingIdentityStatus(spaceId(req)));
  } catch (err) {
    if (handleConnectAccountError(res, err)) return;
    throw err;
  }
});

// Simple status badge off the webhook-populated Space row, without re-fetching the full checklist.
payoutsRouter.get('/payout/onboarding-status', async (req: Request, res: Response): Promise<void> => {
  const space = await db.space.findUnique({
    where: { id: spaceId(req) },
    select: { bachsSetupStatus: true, bachsTransfersActive: true, bachsPayoutsActive: true },
  });
  ok(res, {
    setupStatus: space?.bachsSetupStatus ?? 'incomplete',
    transfersActive: space?.bachsTransfersActive ?? false,
    payoutsActive: space?.bachsPayoutsActive ?? false,
  });
});

// ---------------------------------------------------------------------------
// POST /payout/request (§10.3) — Idempotency-Key required. Quorum bypassed
// for MVP (see plan) — disburses immediately rather than waiting on
// castPayoutApproval(); re-enabling quorum later is routing this back
// through that function instead of calling initiatePayoutDisbursement()
// directly.
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
        data: { spaceId: sid, amount, reference, status: 'processing', accountMasked, note, requestedById: uid(req) },
      });
      await writeAudit(sid, actorInfo, 'payout_requested', `Requested a ₦${(amount / 100).toLocaleString('en-NG')} payout`, tx);
      return created;
    });

    await initiatePayoutDisbursement(payout).catch((err) => console.error('[payout] init failed:', err));
    const final = (await db.payout.findUnique({ where: { id: payout.id } }))!;
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
// can request a payout scoped to just that due's collected funds. Quorum
// bypassed for MVP, same as the space-wide request above.
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
          status: 'processing',
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

    await initiatePayoutDisbursement(payout).catch((err) => console.error('[payout] init failed:', err));
    const final = (await db.payout.findUnique({ where: { id: payout.id } }))!;
    ok(res, serializePayout(final), 201);
  },
);

// ---------------------------------------------------------------------------
// POST /payout/{payoutId}/approve — dormant for MVP (payouts no longer land
// in `pending_approval`, see POST /payout/request above), kept in place so
// re-enabling quorum later is a small flip rather than a rebuild.
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
