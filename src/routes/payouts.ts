import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePayout, serializeBeneficiary } from '../lib/serializers';
import { maskAccountNumber } from '../lib/encryption';
import {
  MIN_PAYOUT_KOBO,
  WITHDRAWAL_FEE_HIGH_KOBO,
  WITHDRAWAL_FEE_LOW_KOBO,
  WITHDRAWAL_FEE_THRESHOLD_KOBO,
} from '../lib/money';
import { getKycState, getSpaceKycState } from '../services/kyc.service';
import {
  governmentIdHandlers,
  payoutDestinationHandlers,
  payoutDestinationLookupHandlers,
  resubmitStudentIdHandlers,
  submitKycHandlers,
} from './kycHandlers';
import { getSpaceLedgerSummary, listSpaceLedger } from '../services/ledger.service';
import { notifyMany } from '../lib/notifications';
import { writeAudit } from '../lib/audit';
import { quoteWithdrawal, requestWithdrawal } from '../services/withdrawal.service';
import { addBeneficiary, listBeneficiaries, removeBeneficiary, resolveBankDetails } from '../services/beneficiary.service';

// Mounted at /spaces/:spaceId; every route is rep-gated.
export const payoutsRouter = Router({ mergeParams: true });
payoutsRouter.use(requireSpaceRep());

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function spaceId(req: Request): string {
  return req.params.spaceId as string;
}

// ---------------------------------------------------------------------------
// GET /payout/summary — the space's balance (derived from its ledger), its
// lead rep's verification state, and the fee schedule.
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/summary', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const [ledger, kyc, beneficiaryCount, pin] = await Promise.all([
    getSpaceLedgerSummary(sid),
    getSpaceKycState(sid),
    db.payoutBeneficiary.count({ where: { spaceId: sid } }),
    db.space.findUnique({
      where: { id: sid },
      select: { withdrawalPinHash: true, withdrawalPinLockedUntil: true, withdrawalPinResetRequestedAt: true },
    }),
  ]);
  ok(res, {
    available: ledger.balance,
    balance: ledger.balance,
    collected: ledger.collected,
    withdrawn: ledger.withdrawn,
    withdrawalFees: ledger.withdrawalFees,
    inFlight: ledger.inFlight,
    // Kept for older clients: lifetime amount withdrawn.
    lifetime: ledger.withdrawn,
    kyc,
    beneficiaryCount,
    // Withdrawals need the admin-set security code; tell the rep if it's missing or locked.
    withdrawalPinSet: !!pin?.withdrawalPinHash,
    withdrawalPinLockedUntil: pin?.withdrawalPinLockedUntil && pin.withdrawalPinLockedUntil > new Date() ? pin.withdrawalPinLockedUntil : null,
    withdrawalPinResetRequestedAt: pin?.withdrawalPinResetRequestedAt ?? null,
    minPayout: MIN_PAYOUT_KOBO,
    fees: {
      below: { thresholdKobo: WITHDRAWAL_FEE_THRESHOLD_KOBO, feeKobo: WITHDRAWAL_FEE_LOW_KOBO },
      atOrAbove: { thresholdKobo: WITHDRAWAL_FEE_THRESHOLD_KOBO, feeKobo: WITHDRAWAL_FEE_HIGH_KOBO },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /ledger — the space's ledger entries, newest first
// ---------------------------------------------------------------------------
payoutsRouter.get('/ledger', async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take } = parseListQuery(req);
  const { total, rows } = await listSpaceLedger(spaceId(req), skip, take);
  ok(res, rows, 200, buildMeta(page, perPage, total));
});

// ---------------------------------------------------------------------------
// GET /payout/breakdown — collections per due: gross, fees, net.
// Optional from/to (YYYY-MM-DD).
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

  ok(
    res,
    {
      totals: {
        collected: totals._sum.amountPaid ?? 0,
        fees: (totals._sum.processingFee ?? 0) + (totals._sum.duevyFee ?? 0),
        net: totals._sum.netToSpace ?? 0,
        paidCount: totals._count._all,
      },
      byDue: byDueRaw.map((d) => ({
        dueId: d.dueId,
        title: dueById.get(d.dueId)?.title ?? 'Unknown due',
        type: dueById.get(d.dueId)?.category ?? null,
        paidCount: d._count._all,
        collected: d._sum.amountPaid ?? 0,
        fees: (d._sum.processingFee ?? 0) + (d._sum.duevyFee ?? 0),
        net: d._sum.netToSpace ?? 0,
      })),
    },
    200,
    buildMeta(page, perPage, dueCount),
  );
});

// ---------------------------------------------------------------------------
// Beneficiaries — the accounts a withdrawal can go to (the rep's own, a
// lecturer's, a vendor's). Name enquiry is mandatory and server-side: the
// account name is always the bank's, never the client's.
// ---------------------------------------------------------------------------
const accountSchema = z.object({
  bankCode: z.string().min(3).max(10),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});
const beneficiarySchema = accountSchema.extend({ label: z.string().trim().max(60).optional() });

// POST /payout/beneficiaries/lookup — preview the bank's name for an account before adding it.
payoutsRouter.post(
  '/payout/beneficiaries/lookup',
  sensitiveLimiter,
  validate(accountSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber } = req.body as z.infer<typeof accountSchema>;
    const resolved = await resolveBankDetails(bankCode, accountNumber);
    ok(res, { bankCode, bankName: resolved.bankName, accountNumber: maskAccountNumber(accountNumber), accountName: resolved.accountName });
  },
);

payoutsRouter.get('/payout/beneficiaries', async (req: Request, res: Response): Promise<void> => {
  ok(res, (await listBeneficiaries(spaceId(req))).map(serializeBeneficiary));
});

// POST /payout/beneficiaries — lead rep only; registers the account with the provider.
payoutsRouter.post(
  '/payout/beneficiaries',
  requireSpaceRep(true),
  sensitiveLimiter,
  validate(beneficiarySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber, label } = req.body as z.infer<typeof beneficiarySchema>;
    const me = await db.user.findUniqueOrThrow({
      where: { id: uid(req) },
      select: { id: true, name: true, bachsAccountId: true, kycStatus: true },
    });
    if (!me.bachsAccountId || me.kycStatus !== 'verified') {
      errors.conflict(res, 'KYC_NOT_VERIFIED', 'Verify your identity before adding a beneficiary');
      return;
    }
    const { beneficiary, created } = await addBeneficiary({
      spaceId: spaceId(req),
      actor: { id: me.id, name: me.name, bachsAccountId: me.bachsAccountId },
      bankCode,
      accountNumber,
      label,
    });
    ok(res, serializeBeneficiary(beneficiary), created ? 201 : 200);
  },
);

payoutsRouter.delete(
  '/payout/beneficiaries/:beneficiaryId',
  requireSpaceRep(true),
  async (req: Request, res: Response): Promise<void> => {
    const me = await db.user.findUniqueOrThrow({ where: { id: uid(req) }, select: { id: true, name: true } });
    await removeBeneficiary(spaceId(req), req.params.beneficiaryId as string, me);
    ok(res, { removed: true });
  },
);

// ---------------------------------------------------------------------------
// KYC — the shared handlers (also mounted at /me/kyc*). KYC state lives on the
// user, so these act on the caller; see routes/kycHandlers.ts.
// ---------------------------------------------------------------------------
payoutsRouter.post('/payout/kyc', ...submitKycHandlers);
payoutsRouter.post('/payout/kyc/student-id', ...resubmitStudentIdHandlers);
payoutsRouter.post('/payout/kyc/government-id', ...governmentIdHandlers);
payoutsRouter.post('/payout/kyc/payout-destination/lookup', ...payoutDestinationLookupHandlers);
payoutsRouter.post('/payout/kyc/payout-destination', ...payoutDestinationHandlers);

payoutsRouter.get('/payout/kyc-status', async (req: Request, res: Response): Promise<void> => {
  const [space, mine] = await Promise.all([getSpaceKycState(spaceId(req)), getKycState(uid(req))]);
  ok(res, { ...space, mine });
});

// ---------------------------------------------------------------------------
// GET /payout/quote?amount= — the fee breakdown shown before confirming.
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/quote', async (req: Request, res: Response): Promise<void> => {
  const amount = Number(req.query.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    errors.validation(res, [{ field: 'amount', issue: 'must be a positive integer in kobo' }]);
    return;
  }
  ok(res, await quoteWithdrawal(amount));
});

// ---------------------------------------------------------------------------
// POST /payout/request — lead rep only. Idempotency-Key required.
// ---------------------------------------------------------------------------
// Either a saved beneficiary, or a one-off account (bankCode + accountNumber)
// that is name-checked but not saved.
const requestSchema = z
  .object({
    amount: z.number().int().positive(),
    beneficiaryId: z.string().min(1).optional(),
    bankCode: accountSchema.shape.bankCode.optional(),
    accountNumber: accountSchema.shape.accountNumber.optional(),
    note: z.string().max(300).optional(),
    // The space's withdrawal security code, set by a Duevy admin.
    pin: z.string().regex(/^\d{4}$/, 'must be 4 digits'),
  })
  .strict()
  .refine((b) => (b.beneficiaryId ? !b.bankCode && !b.accountNumber : !!b.bankCode && !!b.accountNumber), {
    message: 'send either beneficiaryId, or bankCode and accountNumber',
    path: ['beneficiaryId'],
  });

payoutsRouter.post(
  '/payout/request',
  requireSpaceRep(true),
  sensitiveLimiter,
  requireIdempotencyKey,
  idempotent,
  validate(requestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { amount, beneficiaryId, bankCode, accountNumber, note, pin } = req.body as z.infer<typeof requestSchema>;
    const payout = await requestWithdrawal({
      spaceId: spaceId(req),
      userId: uid(req),
      amountKobo: amount,
      beneficiaryId,
      account: bankCode && accountNumber ? { bankCode, accountNumber } : undefined,
      note,
      pin,
    });
    ok(res, serializePayout(payout), 201);
  },
);

// ---------------------------------------------------------------------------
// POST /payout/pin-reset-request — lead rep forgot the withdrawal security
// code. Only an admin can set a new one (after confirming it's really the
// rep), so this just alerts the admins. Repeat requests within an hour are
// acknowledged without alerting again.
// ---------------------------------------------------------------------------
const PIN_RESET_COOLDOWN_MS = 60 * 60 * 1000;

payoutsRouter.post('/payout/pin-reset-request', requireSpaceRep(true), sensitiveLimiter, async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const space = await db.space.findUnique({
    where: { id: sid },
    select: { name: true, withdrawalPinHash: true, withdrawalPinResetRequestedAt: true },
  });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }
  if (!space.withdrawalPinHash) {
    errors.conflict(res, 'WITHDRAWAL_PIN_NOT_SET', 'This space has no security code yet. Contact Duevy support to have one set.');
    return;
  }
  const last = space.withdrawalPinResetRequestedAt;
  if (last && Date.now() - last.getTime() < PIN_RESET_COOLDOWN_MS) {
    ok(res, { requested: true, requestedAt: last });
    return;
  }

  const requestedAt = new Date();
  const [user, admins] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: uid(req) }, select: { id: true, name: true } }),
    db.user.findMany({ where: { role: 'admin', isSuspended: false, isDeactivated: false }, select: { id: true } }),
  ]);
  await db.space.update({ where: { id: sid }, data: { withdrawalPinResetRequestedAt: requestedAt } });
  await writeAudit(sid, { ...user, role: 'lead' }, 'withdrawal_pin_reset_requested', `${user.name} asked for a new withdrawal security code`);
  await notifyMany(
    admins.map((a) => a.id),
    {
      kind: 'system',
      tone: 'rose',
      title: 'Withdrawal code reset requested',
      detail: `${user.name}, lead rep of ${space.name}, forgot the withdrawal security code. Confirm it's really them before setting a new one.`,
      href: '/admin/spaces',
    },
  ).catch(() => {});

  ok(res, { requested: true, requestedAt }, 201);
});

// ---------------------------------------------------------------------------
// GET /payouts · /payout/{payoutId}
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

payoutsRouter.get('/payout/:payoutId', async (req: Request, res: Response): Promise<void> => {
  const payout = await db.payout.findUnique({ where: { id: req.params.payoutId as string } });
  if (!payout || payout.spaceId !== spaceId(req)) {
    errors.notFound(res, 'Payout not found');
    return;
  }
  ok(res, serializePayout(payout));
});
