import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { requireIdempotencyKey, idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePayout, serializeBankAccount } from '../lib/serializers';
import { encrypt, decrypt, maskAccountNumber } from '../lib/encryption';
import { getBanks, verifyAccountName } from '../lib/paymentGateway';
import { generatePayoutReference } from '../lib/money';
import { writeAudit } from '../lib/audit';
import { sendEmail, renderEmail } from '../lib/email';
import { initiatePayoutDisbursement } from '../services/payout.service';

// Mounted at /spaces/:spaceId; every route is rep-gated.
export const payoutsRouter = Router({ mergeParams: true });
payoutsRouter.use(requireSpaceRep());

const CLEARING_WINDOW_MS = 24 * 60 * 60 * 1000; // funds clear 24h after payment
const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h hold after an account change

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function spaceId(req: Request): string {
  return req.params.spaceId as string;
}
async function actor(id: string): Promise<{ id: string; name: string }> {
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  return { id, name: u?.name ?? 'Rep' };
}

/**
 * Payout balances, all net of the 3% charge (fees are taken at collection).
 *  available = cleared collections − (processing + completed payouts)
 *  pending   = collections still inside the clearing window
 *  lifetime  = total ever completed
 */
async function computeBalances(sid: string) {
  const clearedThreshold = new Date(Date.now() - CLEARING_WINDOW_MS);
  const [cleared, pending, reserved, lifetime] = await Promise.all([
    db.duePayment.aggregate({ where: { due: { spaceId: sid }, paidAt: { lte: clearedThreshold } }, _sum: { netToSpace: true } }),
    db.duePayment.aggregate({ where: { due: { spaceId: sid }, paidAt: { gt: clearedThreshold } }, _sum: { netToSpace: true } }),
    db.payout.aggregate({ where: { spaceId: sid, status: { in: ['processing', 'completed'] } }, _sum: { amount: true } }),
    db.payout.aggregate({ where: { spaceId: sid, status: 'completed' }, _sum: { amount: true } }),
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

  const existing = await db.bankAccount.findUnique({ where: { spaceId: sid } });
  const changed =
    !!existing && (decrypt(existing.accountNumber) !== accountNumber || existing.bankCode !== bankCode);

  const masked = maskAccountNumber(accountNumber);
  const cooldownUntil = changed ? new Date(Date.now() + ACCOUNT_COOLDOWN_MS) : existing?.cooldownUntil ?? null;

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

    // Unique payout reference.
    let reference = generatePayoutReference();
    for (let i = 0; i < 5; i++) {
      if (!(await db.payout.findUnique({ where: { reference } }))) break;
      reference = generatePayoutReference();
    }

    const accountMasked = `${account.bankName} ${account.accountNumberMasked}`;
    const payout = await db.payout.create({
      data: { spaceId: sid, amount, reference, status: 'processing', accountMasked, note },
    });

    await writeAudit(
      sid,
      await actor(uid(req)),
      'payout_requested',
      `Requested a ₦${(amount / 100).toLocaleString('en-NG')} payout`,
    );

    // Best-effort: resolves synchronously when the provider responds inline;
    // otherwise the payout stays `processing` for the webhook/reconciliation job.
    await initiatePayoutDisbursement(payout).catch((err) => console.error('[payout] init failed:', err));
    const fresh = (await db.payout.findUnique({ where: { id: payout.id } })) ?? payout;

    ok(res, serializePayout(fresh), 201);
  },
);

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
