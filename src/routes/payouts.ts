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
  discountedFee,
  MIN_PAYOUT_KOBO,
  WITHDRAWAL_FEE_TIERS,
} from '../lib/money';
import { getKycState, getSpaceKycState } from '../services/kyc.service';
import { getActiveDiscount, serializeSpacePartner } from '../services/partner.service';
import {
  payoutDestinationHandlers,
  payoutDestinationLookupHandlers,
  resubmitStudentIdHandlers,
  sendPhoneCodeHandlers,
  submitKycHandlers,
  verifyPhoneCodeHandlers,
} from './kycHandlers';
import { getDueAvailability, getSpaceLedgerSummary, listSpaceLedger } from '../services/ledger.service';
import { notifyMany } from '../lib/notifications';
import { writeAudit } from '../lib/audit';
import { quoteWithdrawal, requestWithdrawal, setWithdrawalPinByRep, type PinChange } from '../services/withdrawal.service';
import { sendEmail, renderEmail } from '../lib/email';
import { escapeHtml } from '../lib/html';
import { addBeneficiary, listBeneficiaries, removeBeneficiary, resolveBankDetails } from '../services/beneficiary.service';
import { listSignatories, REQUIRED_SIGNATORIES, setSignatories, setWithdrawalAuthMode } from '../services/signatory.service';
import { announceForApproval, approvePayout, getApprovalState, rejectPayout, sendApprovalOtp } from '../services/withdrawalApproval.service';

// Mounted at /spaces/:spaceId; every route is rep-gated. Withdrawals are open
// to co-reps for the dues assigned to them; settings stay lead-only.
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
  const [ledger, kyc, beneficiaryCount, pin, signatories, awaitingApproval, partner] = await Promise.all([
    getSpaceLedgerSummary(sid),
    getSpaceKycState(sid),
    db.payoutBeneficiary.count({ where: { spaceId: sid } }),
    db.space.findUnique({
      where: { id: sid },
      select: { withdrawalAuthMode: true, withdrawalPinHash: true, withdrawalPinLockedUntil: true, withdrawalPinHoldUntil: true },
    }),
    listSignatories(sid),
    db.payout.findFirst({ where: { spaceId: sid, status: 'awaiting_approval' }, select: { id: true } }),
    getActiveDiscount(sid),
  ]);
  const discountPercent = partner?.discountPercent ?? 0;
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
    // Withdrawals need the security code the lead rep sets; say if it's missing, locked or on hold.
    withdrawalPinSet: !!pin?.withdrawalPinHash,
    withdrawalPinLockedUntil: pin?.withdrawalPinLockedUntil && pin.withdrawalPinLockedUntil > new Date() ? pin.withdrawalPinLockedUntil : null,
    withdrawalPinHoldUntil: pin?.withdrawalPinHoldUntil && pin.withdrawalPinHoldUntil > new Date() ? pin.withdrawalPinHoldUntil : null,
    // `pin`: the security code above; `multisig`: 2 of the 3 signatories approve with emailed codes.
    withdrawalAuthMode: pin?.withdrawalAuthMode ?? 'pin',
    signatories,
    signatoriesComplete: signatories.length >= REQUIRED_SIGNATORIES,
    awaitingApprovalPayoutId: awaitingApproval?.id ?? null,
    minPayout: MIN_PAYOUT_KOBO,
    // The withdrawal fee by amount, already net of the space's partner
    // discount. Each tier covers fromKobo..toKobo inclusive; toKobo null = no ceiling.
    fees: {
      tiers: WITHDRAWAL_FEE_TIERS.map((t, i) => ({
        fromKobo: i === 0 ? 0 : (WITHDRAWAL_FEE_TIERS[i - 1]!.maxKobo as number) + 1,
        toKobo: t.maxKobo,
        feeKobo: discountedFee(t.feeKobo, discountPercent),
      })),
    },
    partner: partner ? serializeSpacePartner(partner) : null,
  });
});

// ---------------------------------------------------------------------------
// GET /payout/dues — the dues the caller can withdraw from, each with what is
// left of it (see getDueAvailability): every due for the lead, assigned ones
// for a co-rep.
// ---------------------------------------------------------------------------
payoutsRouter.get('/payout/dues', async (req: Request, res: Response): Promise<void> => {
  const rep = (req as AuthenticatedRequest).spaceRep!;
  const dues = await db.due.findMany({
    where: { spaceId: spaceId(req), ...(rep.role === 'lead' ? {} : { assignedRepId: uid(req) }) },
    select: { id: true, title: true, category: true, status: true, assignedRepId: true },
    orderBy: { createdAt: 'desc' },
  });
  const available = await getDueAvailability(spaceId(req));
  ok(
    res,
    dues.map((d) => ({ id: d.id, title: d.title, type: d.category, status: d.status, assignedRepId: d.assignedRepId, available: available.get(d.id) ?? 0 })),
  );
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

// POST /payout/beneficiaries — lead rep only; the account is name-checked with the bank.
payoutsRouter.post(
  '/payout/beneficiaries',
  requireSpaceRep(true),
  sensitiveLimiter,
  validate(beneficiarySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber, label } = req.body as z.infer<typeof beneficiarySchema>;
    const me = await db.user.findUniqueOrThrow({
      where: { id: uid(req) },
      select: { id: true, name: true, kycStatus: true },
    });
    if (me.kycStatus !== 'verified') {
      errors.conflict(res, 'KYC_NOT_VERIFIED', 'Verify your identity before adding a beneficiary');
      return;
    }
    const { beneficiary, created } = await addBeneficiary({
      spaceId: spaceId(req),
      actor: { id: me.id, name: me.name },
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
payoutsRouter.post('/payout/kyc/phone/send', ...sendPhoneCodeHandlers);
payoutsRouter.post('/payout/kyc/phone/verify', ...verifyPhoneCodeHandlers);
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
  ok(res, await quoteWithdrawal(spaceId(req), amount));
});

// ---------------------------------------------------------------------------
// POST /payout/request — Idempotency-Key required. The lead can withdraw from
// the whole space or one due; a co-rep only from a due assigned to them
// (`dueId`). In `pin` mode it needs the security code and goes straight to the
// bank; in `multisig` mode it waits as `awaiting_approval` for 2 signatures.
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
    dueId: z.string().min(1).optional(),
    // The space's withdrawal security code, set by the lead rep. `pin` mode only.
    pin: z.string().regex(/^\d{4}$/, 'must be 4 digits').optional(),
  })
  .strict()
  .refine((b) => (b.beneficiaryId ? !b.bankCode && !b.accountNumber : !!b.bankCode && !!b.accountNumber), {
    message: 'send either beneficiaryId, or bankCode and accountNumber',
    path: ['beneficiaryId'],
  });

payoutsRouter.post(
  '/payout/request',
  sensitiveLimiter,
  requireIdempotencyKey,
  idempotent,
  validate(requestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { amount, beneficiaryId, bankCode, accountNumber, note, pin, dueId } = req.body as z.infer<typeof requestSchema>;
    const payout = await requestWithdrawal({
      spaceId: spaceId(req),
      userId: uid(req),
      amountKobo: amount,
      dueId,
      beneficiaryId,
      account: bankCode && accountNumber ? { bankCode, accountNumber } : undefined,
      note,
      pin,
    });
    if (payout.status !== 'awaiting_approval') {
      ok(res, serializePayout(payout), 201);
      return;
    }
    const { otpSentToRequester } = await announceForApproval(payout, uid(req));
    ok(res, { ...serializePayout(payout), approval: { ...(await getApprovalState(payout)), otpSentToRequester } }, 201);
  },
);

// ---------------------------------------------------------------------------
// Signing a multisig withdrawal.
// POST /payout/{payoutId}/otp — email me a 6-digit code for it (signatories).
// POST /payout/{payoutId}/approve — { otp }; the second approval sends it.
// POST /payout/{payoutId}/reject — { reason? }; a signatory rejects it, or
// its requester withdraws it. Either way the balance is restored.
// ---------------------------------------------------------------------------
const approveSchema = z.object({ otp: z.string().regex(/^\d{6}$/, 'must be 6 digits') }).strict();
const rejectSchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

payoutsRouter.post('/payout/:payoutId/otp', sensitiveLimiter, async (req: Request, res: Response): Promise<void> => {
  const { expiresAt } = await sendApprovalOtp(req.params.payoutId as string, spaceId(req), uid(req));
  ok(res, { sent: true, expiresAt });
});

payoutsRouter.post('/payout/:payoutId/approve', sensitiveLimiter, validate(approveSchema), async (req: Request, res: Response): Promise<void> => {
  const { otp } = req.body as z.infer<typeof approveSchema>;
  const { payout } = await approvePayout(req.params.payoutId as string, spaceId(req), uid(req), otp);
  ok(res, { ...serializePayout(payout), approval: await getApprovalState(payout) });
});

payoutsRouter.post('/payout/:payoutId/reject', sensitiveLimiter, validate(rejectSchema), async (req: Request, res: Response): Promise<void> => {
  const { reason } = req.body as z.infer<typeof rejectSchema>;
  const payout = await rejectPayout(req.params.payoutId as string, spaceId(req), uid(req), reason);
  ok(res, serializePayout(payout));
});

// ---------------------------------------------------------------------------
// Withdrawal security settings (lead rep, password required).
// PUT /payout/signatories — { userIds: [coRepId, coRepId], password }: the two
// co-reps who sign withdrawals with the lead.
// PUT /payout/security — { mode: 'pin' | 'multisig', password }: how
// withdrawals are authorised. Turning multisig on needs 3 signatories.
// While multisig is on, a signatory change holds withdrawals for 24 hours;
// so does switching back to the security code.
// ---------------------------------------------------------------------------
const signatoriesSchema = z.object({ userIds: z.array(z.string().min(1)).max(2), password: z.string().min(1).max(1024) }).strict();
const securitySchema = z.object({ mode: z.enum(['pin', 'multisig']), password: z.string().min(1).max(1024) }).strict();

payoutsRouter.put('/payout/signatories', requireSpaceRep(true), sensitiveLimiter, validate(signatoriesSchema), async (req: Request, res: Response): Promise<void> => {
  const { userIds, password } = req.body as z.infer<typeof signatoriesSchema>;
  const { holdUntil } = await setSignatories({ spaceId: spaceId(req), userId: uid(req), signatoryIds: userIds, password });
  const signatories = await listSignatories(spaceId(req));
  ok(res, { signatories, signatoriesComplete: signatories.length >= REQUIRED_SIGNATORIES, withdrawalPinHoldUntil: holdUntil });
});

payoutsRouter.put('/payout/security', requireSpaceRep(true), sensitiveLimiter, validate(securitySchema), async (req: Request, res: Response): Promise<void> => {
  const { mode, password } = req.body as z.infer<typeof securitySchema>;
  const result = await setWithdrawalAuthMode({ spaceId: spaceId(req), userId: uid(req), mode, password });
  ok(res, { withdrawalAuthMode: result.mode, changed: result.changed, withdrawalPinHoldUntil: result.holdUntil });
});

// ---------------------------------------------------------------------------
// PUT /payout/pin — the lead rep sets (or changes) the space's 4-digit
// withdrawal security code. Needs their account password; changing an
// existing code also needs the current one.
// POST /payout/pin/reset — forgot the code: set a new one with the password
// alone. Withdrawals are then held for 24 hours and every rep is told.
// ---------------------------------------------------------------------------
const pinCode = z.string().regex(/^\d{4}$/, 'must be 4 digits');
const setPinSchema = z
  .object({ pin: pinCode, password: z.string().min(1).max(1024), currentPin: pinCode.optional() })
  .strict();
const resetPinSchema = z.object({ pin: pinCode, password: z.string().min(1).max(1024) }).strict();

const PIN_AUDIT: Record<PinChange, { action: 'withdrawal_pin_set' | 'withdrawal_pin_changed' | 'withdrawal_pin_reset'; verb: string }> = {
  set: { action: 'withdrawal_pin_set', verb: 'set' },
  changed: { action: 'withdrawal_pin_changed', verb: 'changed' },
  reset: { action: 'withdrawal_pin_reset', verb: 'reset' },
};

async function afterPinChange(req: Request, change: PinChange, holdUntil: Date | null): Promise<void> {
  const sid = spaceId(req);
  const [actor, space] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: uid(req) }, select: { id: true, name: true, email: true } }),
    db.space.findUniqueOrThrow({ where: { id: sid }, select: { name: true, reps: { select: { userId: true } } } }),
  ]);
  const { action, verb } = PIN_AUDIT[change];
  await writeAudit(sid, { id: actor.id, name: actor.name, role: 'lead' }, action, `${actor.name} ${verb} the withdrawal security code`);
  // Every rep hears about it, so a change nobody asked for gets noticed.
  await notifyMany(
    space.reps.map((r) => r.userId),
    {
      kind: 'system',
      tone: change === 'reset' ? 'rose' : 'brand',
      title: `Withdrawal security code ${verb}`,
      detail:
        change === 'reset'
          ? `${actor.name} reset the withdrawal code for ${space.name}. Withdrawals reopen in 24 hours. If this wasn't you, contact Duevy support now.`
          : `${actor.name} ${verb} the withdrawal code for ${space.name}.`,
      href: '/dashboard/payout',
    },
  ).catch(() => {});
  if (change === 'reset') {
    sendEmail({
      to: actor.email,
      subject: 'Your Duevy withdrawal code was reset',
      html: renderEmail(`
        <h1>Your withdrawal code was reset</h1>
        <p>Hi ${escapeHtml(actor.name)}, the withdrawal security code for <strong>${escapeHtml(space.name)}</strong> was just reset.
        Withdrawals reopen at ${escapeHtml(holdUntil?.toUTCString() ?? '')}.</p>
        <p>If you didn't do this, change your password and contact support@duevy.app immediately.</p>
      `),
    }).catch(() => {});
  }
}

payoutsRouter.put('/payout/pin', requireSpaceRep(true), sensitiveLimiter, validate(setPinSchema), async (req: Request, res: Response): Promise<void> => {
  const { pin, password, currentPin } = req.body as z.infer<typeof setPinSchema>;
  const { change, holdUntil } = await setWithdrawalPinByRep({ spaceId: spaceId(req), userId: uid(req), pin, password, currentPin });
  await afterPinChange(req, change, holdUntil);
  ok(res, { withdrawalPinSet: true, change, withdrawalPinHoldUntil: holdUntil });
});

payoutsRouter.post('/payout/pin/reset', requireSpaceRep(true), sensitiveLimiter, validate(resetPinSchema), async (req: Request, res: Response): Promise<void> => {
  const { pin, password } = req.body as z.infer<typeof resetPinSchema>;
  const { change, holdUntil } = await setWithdrawalPinByRep({ spaceId: spaceId(req), userId: uid(req), pin, password, forgot: true });
  await afterPinChange(req, change, holdUntil);
  ok(res, { withdrawalPinSet: true, change, withdrawalPinHoldUntil: holdUntil });
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
  const approval = payout.status === 'awaiting_approval' || (await db.payoutApproval.count({ where: { payoutId: payout.id } })) > 0
    ? await getApprovalState(payout)
    : null;
  ok(res, { ...serializePayout(payout), approval });
});
