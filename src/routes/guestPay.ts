import { Router, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import {
  guestAccountLimiter,
  guestCheckoutNetworkLimiter,
  guestCheckoutPersonLimiter,
  guestCheckoutStatusLimiter,
  guestLinkLimiter,
} from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { generateId } from '../lib/id';
import { computeCharge } from '../lib/money';
import { createCheckout, getGuestCheckout, guestCheckoutToken, isValidGuestCheckoutToken } from '../services/checkout.service';
import { syncPendingCheckout } from './transactions';
import { renderReceiptByNumber } from '../services/receipt.service';
import { getSpaceKycState } from '../services/kyc.service';
import { checkGuestAnswers, readGuestFields } from '../lib/guestForm';
import { optionalAuthenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requestGuestAccount } from '../services/guestAccount.service';

/**
 * Guest pay — dues a rep has opened to guests (`dues.allowGuests`) can be paid
 * from a public link with a name, email and matric number, no account, plus
 * whatever extra questions the rep added (`dues.guestFields`, see lib/guestForm.ts).
 *
 * The payer gets a password-less `isGuest` user row, so the checkout, ledger,
 * receipt and webhook paths are exactly the member ones. There's no session:
 * the status page and receipt are unlocked by a token (an HMAC of the
 * checkout reference) returned only to whoever started the checkout.
 *
 * A guest can tick "create a Duevy account for me" (`createAccount`). That only
 * records consent; the activation link goes out once the payment is confirmed
 * (services/guestAccount.service.ts). Someone whose email already has a full
 * account signs in first and pays on the same page as themselves, so the
 * payment lands in their history without anyone else being able to attach a
 * payment to their account.
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
guestPayRouter.get('/dues/:dueId', guestLinkLimiter, async (req: Request, res: Response): Promise<void> => {
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
    // The rep's extra questions, on top of name, email and matric number.
    fields: readGuestFields(due.guestFields),
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
  // Always asked. Optional here only for a signed-in payer whose profile already has one.
  matricNo: z.string().trim().min(1).max(32).optional(),
  // Answers to the due's guestFields, keyed by field id.
  answers: z.record(z.string().max(1000)).optional(),
  // "Create a free Duevy account for me" — consent only; nothing is created until it's paid.
  createAccount: z.boolean().optional(),
});

const payerSelect = { id: true, isGuest: true, isSuspended: true, isDeactivated: true, matricNo: true } as const;

/** The same gate as loadGuestDue, as one query, for the checkout route (which only needs the form). */
function loadGuestDueForCheckout(dueId: string) {
  return db.due.findFirst({
    where: { id: dueId, allowGuests: true, status: 'active', space: { isArchived: false } },
    select: { id: true, guestFields: true },
  });
}

/** The guest's user row: reused across their payments, created on first pay. `existing` is its prefetched lookup by email. */
async function guestPayer(input: z.infer<typeof guestCheckoutSchema>, existing: Prisma.UserGetPayload<{ select: typeof payerSelect }> | null) {
  if (existing) {
    // A guest row carries their latest matric number; a real account's profile is left alone.
    if (existing.isGuest && input.matricNo && existing.matricNo !== input.matricNo) {
      return db.user.update({ where: { id: existing.id }, data: { matricNo: input.matricNo }, select: payerSelect });
    }
    return existing;
  }
  try {
    return await db.user.create({
      data: {
        id: generateId('user'),
        name: input.name,
        email: input.email,
        matricNo: input.matricNo ?? null,
        isGuest: true,
        role: 'student',
      },
      select: payerSelect,
    });
  } catch (err) {
    // Two tabs paying with the same new email at once: the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return db.user.findUniqueOrThrow({ where: { email: input.email }, select: payerSelect });
    }
    throw err;
  }
}

guestPayRouter.post(
  '/dues/:dueId/checkout',
  // Before the limiter, so a signed-in payer is limited per account, not per (shared campus) IP.
  optionalAuthenticate,
  guestCheckoutPersonLimiter,
  guestCheckoutNetworkLimiter,
  validate(guestCheckoutSchema),
  async (req: Request, res: Response): Promise<void> => {
    const dueId = req.params.dueId as string;
    const input = req.body as z.infer<typeof guestCheckoutSchema>;
    const sessionUserId = (req as Partial<AuthenticatedRequest>).user?.sub;
    // One parallel round instead of three in a row: the due, the signed-in
    // account, and the guest row for this email (only created further down,
    // once everything checks out).
    const [due, account, existingGuest] = await Promise.all([
      loadGuestDueForCheckout(dueId),
      sessionUserId ? db.user.findUnique({ where: { id: sessionUserId }, select: payerSelect }) : null,
      sessionUserId ? null : db.user.findUnique({ where: { email: input.email }, select: payerSelect }),
    ]);
    if (!due) {
      errors.notFound(res, 'This payment link is not open');
      return;
    }

    const fields = readGuestFields(due.guestFields);
    const checked = fields ? checkGuestAnswers(fields, input.answers) : { answers: null };
    if ('issues' in checked) {
      errors.validation(res, checked.issues);
      return;
    }

    // Signed in: pay as yourself. The session proves who you are, so the
    // typed name and email are ignored, and the profile's matric number is used.
    if (sessionUserId && !account) {
      errors.unauthorized(res);
      return;
    }
    // Matric number is always asked — except of an account that already has one.
    if (!input.matricNo && !account?.matricNo) {
      errors.validation(res, [{ field: 'matricNo', issue: 'Matric number is required' }]);
      return;
    }
    const payer = account
      ? account.matricNo || !input.matricNo
        ? account
        : await db.user.update({ where: { id: account.id }, data: { matricNo: input.matricNo }, select: payerSelect })
      : await guestPayer(input, existingGuest);
    // A real account pays signed in, so the payment lands in their history.
    if (!sessionUserId && !payer.isGuest) {
      fail(res, 409, 'EMAIL_HAS_ACCOUNT', 'This email has a Duevy account. Sign in to pay.');
      return;
    }
    if (payer.isSuspended || payer.isDeactivated) {
      errors.forbidden(res, "This email can't be used to pay");
      return;
    }

    const { checkout, reused } = await createCheckout(payer.id, [dueId], {
      guest: true,
      guestData: {
        ...(checked.answers ? { guestAnswers: checked.answers } : {}),
        // Consent is the guest's; someone with an account already has one.
        accountRequestedAt: payer.isGuest && input.createAccount ? new Date() : null,
      },
    });
    ok(res, { ...checkout, reused, token: guestCheckoutToken(checkout.reference) }, reused ? 200 : 201);
  },
);

// ---------------------------------------------------------------------------
// GET /public/pay/callback?ref= — the Interswitch IPG site_redirect_url.
//
// After the card popup completes, Interswitch returns the payer here. The
// server requeries the transaction (gettransaction.json — never trusting the
// browser) and then redirects the payer to the frontend status page, which
// polls until the checkout shows "paid". Safe to hit more than once.
// ---------------------------------------------------------------------------
guestPayRouter.get('/pay/callback', guestCheckoutStatusLimiter, async (req: Request, res: Response): Promise<void> => {
  const reference = typeof req.query.ref === 'string' ? req.query.ref : '';
  let dueId: string | null = null;
  if (reference) {
    const checkout = await db.checkout.findUnique({
      where: { reference },
      include: { items: { select: { dueId: true }, take: 1 } },
    });
    if (checkout) {
      dueId = checkout.items[0]?.dueId ?? null;
      // Server-side verification; failures are left for the status poll / reconciliation.
      await syncPendingCheckout(reference).catch(() => {});
    }
  }
  const target = new URL(`${env.FRONTEND_URL}/pay/${dueId ? `${encodeURIComponent(dueId)}` : 'status'}`);
  if (reference) {
    target.searchParams.set('ref', reference);
    target.searchParams.set('t', guestCheckoutToken(reference));
  }
  res.redirect(302, target.toString());
});

// ---------------------------------------------------------------------------
// GET /public/checkouts/{reference}?t= — guest checkout status
// GET /public/checkouts/{reference}/receipt?t= — its PDF receipt
// ---------------------------------------------------------------------------
function tokenOf(req: Request): string {
  return typeof req.query.t === 'string' ? req.query.t : '';
}

guestPayRouter.get('/checkouts/:reference', guestCheckoutStatusLimiter, async (req: Request, res: Response): Promise<void> => {
  const reference = req.params.reference as string;
  // Ask the provider (throttled) so the page reflects a payment, or an expired
  // overlay session, without waiting for the webhook. Token first: an unknown
  // caller never triggers a provider call.
  if (isValidGuestCheckoutToken(reference, tokenOf(req))) await syncPendingCheckout(reference);
  const { userId: _userId, id: _id, ...checkout } = await getGuestCheckout(req.params.reference as string, tokenOf(req));
  ok(res, checkout);
});

// ---------------------------------------------------------------------------
// POST /public/checkouts/{reference}/account?t= — "create my Duevy account"
// from the success page, or send the activation link again. Sends only once
// the checkout is paid; before that it records the request.
// ---------------------------------------------------------------------------
guestPayRouter.post('/checkouts/:reference/account', guestAccountLimiter, async (req: Request, res: Response): Promise<void> => {
  const checkout = await getGuestCheckout(req.params.reference as string, tokenOf(req));
  if (checkout.account.exists) {
    fail(res, 409, 'ACCOUNT_EXISTS', 'This email already has a Duevy account. Sign in to see this payment.');
    return;
  }
  const outcome = await requestGuestAccount(checkout.id);
  const { account } = await getGuestCheckout(req.params.reference as string, tokenOf(req));
  ok(res, { outcome, account });
});

guestPayRouter.get('/checkouts/:reference/receipt', guestCheckoutStatusLimiter, async (req: Request, res: Response): Promise<void> => {
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
