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
import { resolveBankName } from '../lib/banks';
import { verifyAccountName } from '../lib/monnify';
import { generatePayoutReference } from '../lib/money';
import { writeAudit } from '../lib/audit';
import { sendEmail } from '../lib/email';

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
// PUT /payout/account (§10.2)
// ---------------------------------------------------------------------------
const putAccountSchema = z.object({
  bankCode: z.string().min(3),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
  accountName: z.string().min(2).optional(),
});

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

payoutsRouter.put('/payout/account', validate(putAccountSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const { bankCode, accountNumber, accountName } = req.body as z.infer<typeof putAccountSchema>;

  const bankName = resolveBankName(bankCode);
  if (!bankName) {
    errors.validation(res, [{ field: 'bankCode', issue: 'unknown bank code' }]);
    return;
  }

  // Name-enquiry is authoritative when available; otherwise fall back to the
  // client-supplied name (which is then required).
  const resolvedName = await verifyAccountName(accountNumber, bankCode);
  if (resolvedName) {
    if (accountName && normalizeName(accountName) !== normalizeName(resolvedName)) {
      fail(res, 422, 'ACCOUNT_NAME_MISMATCH', `Account name does not match: resolved "${resolvedName}"`);
      return;
    }
  } else if (!accountName) {
    fail(res, 422, 'ACCOUNT_NAME_MISMATCH', 'Could not verify the account; provide the account name');
    return;
  }
  const finalName = resolvedName ?? (accountName as string);

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
        html: `<p>Hi ${r.user.name}, the payout bank account for your space was changed to <strong>${bankName} ${masked}</strong>. Payouts are held for 24 hours as a security measure. If this wasn't you, contact support immediately.</p>`,
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

    ok(res, serializePayout(payout), 201);
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
