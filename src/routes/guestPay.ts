import { Router, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../config/db';
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
import { createCheckout, createGroupCheckout, getGuestCheckout, guestCheckoutToken, isValidGuestCheckoutToken, type GroupPerson } from '../services/checkout.service';
import { syncPendingCheckout } from './transactions';
import { renderReceiptByNumber } from '../services/receipt.service';
import { getSpaceKycState } from '../services/kyc.service';
import { checkGuestAnswers, readGuestFields } from '../lib/guestForm';
import { optionalAuthenticate } from '../middleware/auth';
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
    dueDate: due.dueDate ? due.dueDate.toISOString().slice(0, 10) : null,
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
const emailField = z.string().trim().email().max(254).transform((e) => e.toLowerCase());

/** One beneficiary of a group payment (paying for several people at once). */
const groupPersonSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailField,
  matricNo: z.string().trim().min(1).max(32),
  answers: z.record(z.string().max(1000)).optional(),
});

const guestCheckoutSchema = z
  .object({
    // The single payer's details. Optional only so a group request (which
    // carries `people` instead) still validates.
    name: z.string().trim().min(2).max(80).optional(),
    email: emailField.optional(),
    matricNo: z.string().trim().min(1).max(32).optional(),
    // Answers to the due's guestFields, keyed by field id.
    answers: z.record(z.string().max(1000)).optional(),
    // "Create a free Duevy account for me" — consent only; nothing is created until it's paid.
    createAccount: z.boolean().optional(),
    // Group pay: one transfer settling the due for several people. When given,
    // the single-payer fields above are ignored.
    people: z.array(groupPersonSchema).min(1).max(20).optional(),
  })
  .refine((v) => (v.people && v.people.length > 0) || (!!v.name && !!v.email), {
    message: 'Provide a name and email, or a list of people',
  });

const payerSelect = { id: true, isGuest: true, isSuspended: true, isDeactivated: true, matricNo: true } as const;

/** The same gate as loadGuestDue, as one query, for the checkout route (which only needs the form). */
function loadGuestDueForCheckout(dueId: string) {
  return db.due.findFirst({
    where: { id: dueId, allowGuests: true, status: 'active', space: { isArchived: false } },
    select: { id: true, guestFields: true },
  });
}

/**
 * The payer's user row for a guest payment. Any email can pay: if the email
 * already has a row (a guest OR a full account) it's reused and the payment
 * lands on it; otherwise a fresh guest row is created. `existing` is the
 * prefetched lookup by email.
 */
async function guestPayer(
  person: { name: string; email: string; matricNo: string },
  existing: Prisma.UserGetPayload<{ select: typeof payerSelect }> | null,
) {
  if (existing) {
    // A guest row carries their latest matric number; a real account's profile is left alone.
    if (existing.isGuest && existing.matricNo !== person.matricNo) {
      return db.user.update({ where: { id: existing.id }, data: { matricNo: person.matricNo }, select: payerSelect });
    }
    return existing;
  }
  try {
    return await db.user.create({
      data: {
        id: generateId('user'),
        name: person.name,
        email: person.email,
        matricNo: person.matricNo,
        isGuest: true,
        role: 'student',
      },
      select: payerSelect,
    });
  } catch (err) {
    // Two tabs paying with the same new email at once: the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return db.user.findUniqueOrThrow({ where: { email: person.email }, select: payerSelect });
    }
    throw err;
  }
}

guestPayRouter.post(
  '/dues/:dueId/checkout',
  optionalAuthenticate,
  guestCheckoutPersonLimiter,
  guestCheckoutNetworkLimiter,
  validate(guestCheckoutSchema),
  async (req: Request, res: Response): Promise<void> => {
    const dueId = req.params.dueId as string;
    const input = req.body as z.infer<typeof guestCheckoutSchema>;

    const due = await loadGuestDueForCheckout(dueId);
    if (!due) {
      errors.notFound(res, 'This payment link is not open');
      return;
    }
    const fields = readGuestFields(due.guestFields);

    // --- Group pay: one transfer settling the due for several people --------
    if (input.people && input.people.length > 0) {
      const people: GroupPerson[] = [];
      for (const person of input.people) {
        const checked = fields ? checkGuestAnswers(fields, person.answers) : { answers: null };
        if ('issues' in checked) {
          errors.validation(res, checked.issues);
          return;
        }
        people.push({ name: person.name, email: person.email, matricNo: person.matricNo, answers: checked.answers ?? null });
      }
      const { checkout } = await createGroupCheckout(dueId, people);
      ok(res, { ...checkout, reused: false, token: guestCheckoutToken(checkout.reference) }, 201);
      return;
    }

    // --- Single payer: anyone can pay as a guest ----------------------------
    // No account or sign-in needed; the refine guarantees name + email here.
    if (!input.name || !input.email) {
      errors.validation(res, [{ field: 'name', issue: 'Name and email are required' }]);
      return;
    }
    if (!input.matricNo) {
      errors.validation(res, [{ field: 'matricNo', issue: 'Matric number is required' }]);
      return;
    }

    const checked = fields ? checkGuestAnswers(fields, input.answers) : { answers: null };
    if ('issues' in checked) {
      errors.validation(res, checked.issues);
      return;
    }

    // Any email can pay. Reuse the row that email already has (guest or full
    // account) so the payment lands on it; otherwise make a fresh guest row.
    const existing = await db.user.findUnique({ where: { email: input.email }, select: payerSelect });
    const payer = await guestPayer({ name: input.name, email: input.email, matricNo: input.matricNo }, existing);
    if (payer.isSuspended || payer.isDeactivated) {
      errors.forbidden(res, "This email can't be used to pay");
      return;
    }

    const { checkout, reused } = await createCheckout(payer.id, [dueId], {
      guest: true,
      guestData: {
        ...(checked.answers ? { guestAnswers: checked.answers } : {}),
        // Consent is the guest's; a full account already has one.
        accountRequestedAt: payer.isGuest && input.createAccount ? new Date() : null,
      },
    });
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
