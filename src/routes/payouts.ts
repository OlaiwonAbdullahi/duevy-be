import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePayout, serializeBankAccount } from '../lib/serializers';
import { encrypt, decrypt, maskAccountNumber } from '../lib/encryption';
import { namesMatch } from '../lib/nameMatch';
import {
  MIN_PAYOUT_KOBO,
  WITHDRAWAL_FEE_HIGH_KOBO,
  WITHDRAWAL_FEE_LOW_KOBO,
  WITHDRAWAL_FEE_THRESHOLD_KOBO,
} from '../lib/money';
import { sendEmail, renderEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';
import { getKycState, getSpaceKycState } from '../services/kyc.service';
import { governmentIdHandlers, resubmitStudentIdHandlers, submitKycHandlers } from './kycHandlers';
import { getSpaceLedgerSummary, listSpaceLedger } from '../services/ledger.service';
import { quoteWithdrawal, requestWithdrawal } from '../services/withdrawal.service';
import { listBanksCached } from './banks';

// Mounted at /spaces/:spaceId; every route is rep-gated.
export const payoutsRouter = Router({ mergeParams: true });
payoutsRouter.use(requireSpaceRep());

const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h hold after an account change

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
  const [ledger, kyc, account] = await Promise.all([
    getSpaceLedgerSummary(sid),
    getSpaceKycState(sid),
    db.bankAccount.findUnique({ where: { spaceId: sid }, select: { bachsDestinationId: true, cooldownUntil: true } }),
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
    payoutAccountReady: !!account?.bachsDestinationId,
    cooldownUntil: account?.cooldownUntil?.toISOString() ?? null,
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
// Payout bank account. Name enquiry is mandatory and server-side; the account
// name is always the bank's, never the client's — and it must match the
// rep's own name, so money only ever leaves to the rep's own account.
// ---------------------------------------------------------------------------
const accountSchema = z.object({
  bankCode: z.string().min(3).max(10),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});

async function resolveBankDetails(bankCode: string, accountNumber: string) {
  const banks = await listBanksCached();
  const bankName = banks.find((b) => b.code === bankCode)?.name;
  if (!bankName) return { error: 'UNKNOWN_BANK' as const };
  const resolved = await getPaymentProvider().resolveAccount(bankCode, accountNumber);
  if (!resolved) return { error: 'UNVERIFIABLE' as const };
  return { bankName, accountName: resolved.accountName };
}

payoutsRouter.get('/payout/account', async (req: Request, res: Response): Promise<void> => {
  const account = await db.bankAccount.findUnique({ where: { spaceId: spaceId(req) } });
  if (!account) {
    fail(res, 404, 'NO_PAYOUT_ACCOUNT', 'No payout account has been set for this space');
    return;
  }
  ok(res, { ...serializeBankAccount(account), ready: !!account.bachsDestinationId }); // masked
});

// POST /payout/account/lookup — preview the bank's name for an account before saving it.
payoutsRouter.post(
  '/payout/account/lookup',
  sensitiveLimiter,
  validate(accountSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber } = req.body as z.infer<typeof accountSchema>;
    const resolved = await resolveBankDetails(bankCode, accountNumber);
    if ('error' in resolved) {
      if (resolved.error === 'UNKNOWN_BANK') errors.validation(res, [{ field: 'bankCode', issue: 'unknown bank code' }]);
      else fail(res, 422, 'ACCOUNT_UNVERIFIABLE', 'Could not verify this account number with the selected bank');
      return;
    }
    const me = await db.user.findUniqueOrThrow({ where: { id: uid(req) }, select: { name: true } });
    ok(res, {
      bankCode,
      bankName: resolved.bankName,
      accountNumber: maskAccountNumber(accountNumber),
      accountName: resolved.accountName,
      matchesYourName: namesMatch(me.name, resolved.accountName),
    });
  },
);

// PUT /payout/account — lead rep only; registers the account with the provider.
payoutsRouter.put(
  '/payout/account',
  requireSpaceRep(true),
  sensitiveLimiter,
  validate(accountSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { bankCode, accountNumber } = req.body as z.infer<typeof accountSchema>;

    const me = await db.user.findUniqueOrThrow({ where: { id: uid(req) } });
    if (!me.bachsAccountId || me.kycStatus !== 'verified') {
      errors.conflict(res, 'KYC_NOT_VERIFIED', 'Verify your identity before adding a payout account');
      return;
    }

    const resolved = await resolveBankDetails(bankCode, accountNumber);
    if ('error' in resolved) {
      if (resolved.error === 'UNKNOWN_BANK') errors.validation(res, [{ field: 'bankCode', issue: 'unknown bank code' }]);
      else fail(res, 422, 'ACCOUNT_UNVERIFIABLE', 'Could not verify this account number with the selected bank');
      return;
    }
    if (!namesMatch(me.name, resolved.accountName)) {
      fail(res, 422, 'ACCOUNT_NAME_MISMATCH', 'Withdrawals can only go to a bank account in your own name');
      return;
    }

    const destination = await getPaymentProvider().registerPayoutDestination({
      accountId: me.bachsAccountId,
      bankCode,
      accountNumber,
      accountName: resolved.accountName,
    });

    const existing = await db.bankAccount.findUnique({ where: { spaceId: sid } });
    const changed = !!existing && (decrypt(existing.accountNumber) !== accountNumber || existing.bankCode !== bankCode);
    const masked = maskAccountNumber(accountNumber);
    const cooldownUntil = changed ? new Date(Date.now() + ACCOUNT_COOLDOWN_MS) : existing?.cooldownUntil ?? null;

    const data = {
      bankCode,
      bankName: resolved.bankName,
      accountNumber: encrypt(accountNumber),
      accountNumberMasked: masked,
      accountName: resolved.accountName,
      bachsDestinationId: destination.destinationId,
      bachsAccountId: me.bachsAccountId,
      cooldownUntil,
    };
    const account = await db.bankAccount.upsert({ where: { spaceId: sid }, update: data, create: { spaceId: sid, ...data } });
    logger.info({ spaceId: sid, bank: bankCode, account: masked, usable: destination.usable }, 'payout account set');

    if (changed) {
      const reps = await db.spaceRep.findMany({ where: { spaceId: sid }, include: { user: { select: { email: true, name: true } } } });
      for (const r of reps) {
        sendEmail({
          to: r.user.email,
          subject: 'Duevy payout account changed',
          html: renderEmail(
            `<h1>Payout account changed</h1>
             <p>Hi ${r.user.name}, the payout bank account for your space was changed to <strong>${resolved.bankName} ${masked}</strong>.</p>
             <div class="callout">Withdrawals are held for 24 hours as a security measure.</div>
             <p class="muted">If this wasn't you, contact support immediately at support@duevy.app</p>`,
            '#b01e4e',
          ),
        }).catch(() => {});
      }
    }

    ok(res, { ...serializeBankAccount(account), ready: true, usable: destination.usable });
  },
);

// ---------------------------------------------------------------------------
// KYC — the shared handlers (also mounted at /me/kyc*). KYC state lives on the
// user, so these act on the caller; see routes/kycHandlers.ts.
// ---------------------------------------------------------------------------
payoutsRouter.post('/payout/kyc', ...submitKycHandlers);
payoutsRouter.post('/payout/kyc/student-id', ...resubmitStudentIdHandlers);
payoutsRouter.post('/payout/kyc/government-id', ...governmentIdHandlers);

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
const requestSchema = z
  .object({
    amount: z.number().int().positive(),
    note: z.string().max(300).optional(),
  })
  .strict();

payoutsRouter.post(
  '/payout/request',
  requireSpaceRep(true),
  sensitiveLimiter,
  requireIdempotencyKey,
  idempotent,
  validate(requestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { amount, note } = req.body as z.infer<typeof requestSchema>;
    const payout = await requestWithdrawal({ spaceId: spaceId(req), userId: uid(req), amountKobo: amount, note });
    ok(res, serializePayout(payout), 201);
  },
);

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
