import { Router, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { checkoutLimiter, lookupLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { generateId } from '../lib/id';
import { computeCharge } from '../lib/money';
import { createCheckout, getGuestCheckout, guestCheckoutToken } from '../services/checkout.service';
import { renderReceiptByNumber } from '../services/receipt.service';
import { getSpaceKycState } from '../services/kyc.service';

/**
 * Guest pay — dues a rep has opened to guests (`dues.allowGuests`) can be paid
 * from a public link with just a name and email, no account.
 *
 * The payer gets a password-less `isGuest` user row, so the checkout, ledger,
 * receipt and webhook paths are exactly the member ones. There's no session:
 * the status page and receipt are unlocked by a token (an HMAC of the
 * checkout reference) returned only to whoever started the checkout.
 *
 * Mounted at /public, unauthenticated.
 */
export const guestPayRouter = Router();

async function loadGuestDue(dueId: string) {
  const due = await db.due.findUnique({
    where: { id: dueId },
    include: { space: { select: { id: true, name: true, short: true, kind: true, hue: true, isArchived: true } } },
  });
  // One answer for "doesn't exist", "not open to guests" and "not open at
  // all", so the link can't be used to probe a space's members-only dues.
  if (!due || !due.allowGuests || due.status !== 'active' || due.space.isArchived) return null;
  return due;
}

// ---------------------------------------------------------------------------
// GET /public/dues/{dueId} — what the guest is about to pay
// ---------------------------------------------------------------------------
guestPayRouter.get('/dues/:dueId', lookupLimiter, async (req: Request, res: Response): Promise<void> => {
  const due = await loadGuestDue(req.params.dueId as string);
  if (!due) {
    errors.notFound(res, 'This payment link is not open');
    return;
  }
  const charge = computeCharge(due.amount);
  const kyc = await getSpaceKycState(due.space.id);
  ok(res, {
    id: due.id,
    title: due.title,
    note: due.note,
    type: due.category,
    dueDate: due.dueDate.toISOString().slice(0, 10),
    amount: charge.face,
    fee: charge.fee,
    total: charge.total,
    canCollect: kyc.canCollect,
    space: { id: due.space.id, name: due.space.name, short: due.space.short, kind: due.space.kind, hue: due.space.hue },
  });
});

// ---------------------------------------------------------------------------
// POST /public/dues/{dueId}/checkout — open a guest checkout
// ---------------------------------------------------------------------------
const guestCheckoutSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  matricNo: z.string().trim().max(32).optional(),
});

/** The guest's user row: reused across their payments, created on first pay. */
async function guestPayer(input: z.infer<typeof guestCheckoutSchema>) {
  const existing = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, isGuest: true, isSuspended: true, isDeactivated: true },
  });
  if (existing) return existing;
  try {
    return await db.user.create({
      data: {
        id: generateId('user'),
        name: input.name,
        email: input.email,
        matricNo: input.matricNo || null,
        isGuest: true,
        role: 'student',
      },
      select: { id: true, isGuest: true, isSuspended: true, isDeactivated: true },
    });
  } catch (err) {
    // Two tabs paying with the same new email at once: the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return db.user.findUniqueOrThrow({
        where: { email: input.email },
        select: { id: true, isGuest: true, isSuspended: true, isDeactivated: true },
      });
    }
    throw err;
  }
}

guestPayRouter.post(
  '/dues/:dueId/checkout',
  checkoutLimiter,
  validate(guestCheckoutSchema),
  async (req: Request, res: Response): Promise<void> => {
    const dueId = req.params.dueId as string;
    if (!(await loadGuestDue(dueId))) {
      errors.notFound(res, 'This payment link is not open');
      return;
    }

    const input = req.body as z.infer<typeof guestCheckoutSchema>;
    const payer = await guestPayer(input);
    // A real account pays signed in, so the payment lands in their history.
    if (!payer.isGuest) {
      fail(res, 409, 'EMAIL_HAS_ACCOUNT', 'This email has a Duevy account. Sign in to pay.');
      return;
    }
    if (payer.isSuspended || payer.isDeactivated) {
      errors.forbidden(res, "This email can't be used to pay");
      return;
    }

    const { checkout, reused } = await createCheckout(payer.id, [dueId], { guest: true });
    ok(res, { ...checkout, reused, token: guestCheckoutToken(checkout.reference) }, reused ? 200 : 201);
  },
);

// ---------------------------------------------------------------------------
// GET /public/checkouts/{reference}?t= — guest checkout status
// GET /public/checkouts/{reference}/receipt?t= — its PDF receipt
// ---------------------------------------------------------------------------
function tokenOf(req: Request): string {
  return typeof req.query.t === 'string' ? req.query.t : '';
}

guestPayRouter.get('/checkouts/:reference', async (req: Request, res: Response): Promise<void> => {
  const { userId: _userId, ...checkout } = await getGuestCheckout(req.params.reference as string, tokenOf(req));
  ok(res, checkout);
});

guestPayRouter.get('/checkouts/:reference/receipt', async (req: Request, res: Response): Promise<void> => {
  const checkout = await getGuestCheckout(req.params.reference as string, tokenOf(req));
  if (!checkout.receiptNumber) {
    errors.notFound(res, 'The receipt is issued once the payment is confirmed');
    return;
  }
  const { filename, pdf } = await renderReceiptByNumber(checkout.receiptNumber, checkout.userId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.status(200).send(pdf);
});
