import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Poll } from '@prisma/client';
import multer from 'multer';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { authenticate, optionalAuthenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { idempotent } from '../middleware/idempotency';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializePoll } from '../lib/serializers';
import { computeCharge } from '../lib/money';
import { writeAudit } from '../lib/audit';
import { initTransaction, GATEWAY_LABEL } from '../lib/paymentGateway';
import {
  uniqueReference,
  chargeSavedCard,
  CardNotFoundError,
  CardChargeFailedError,
} from '../services/payment.service';
import { applyPollVotes, type VoteSelection } from '../services/poll.service';

const pollInclude = { categories: { include: { nominees: true }, orderBy: { createdAt: 'asc' as const } } };

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}
function maybeUid(req: Request): string | null {
  return ((req as AuthenticatedRequest).user?.sub as string) ?? null;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'poll';
}
async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 6; i++) {
    if (!(await db.poll.findUnique({ where: { slug } }))) return slug;
    slug = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return `${base}-${Date.now()}`;
}

/** Lazily close a poll whose deadline has passed (§11.4 "fires automatically at deadline"). */
async function autoClose<T extends Poll>(poll: T): Promise<T> {
  if (poll.status === 'active' && poll.deadline < new Date()) {
    await db.poll.update({ where: { id: poll.id }, data: { status: 'closed', closedAt: new Date() } });
    poll.status = 'closed';
  }
  return poll;
}

async function actor(id: string): Promise<{ id: string; name: string }> {
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  return { id, name: u?.name ?? 'Rep' };
}

// ===========================================================================
// Rep-facing router — mounted at /spaces/:spaceId
// ===========================================================================
export const pollsRepRouter = Router({ mergeParams: true });
pollsRepRouter.use(requireSpaceRep());

function spaceId(req: Request): string {
  return req.params.spaceId as string;
}

async function loadPollInSpace(sid: string, pollId: string) {
  const poll = await db.poll.findUnique({ where: { id: pollId }, include: pollInclude });
  if (!poll || poll.spaceId !== sid) return null;
  return poll;
}

// GET /polls — all polls with rollups (§11.1)
pollsRepRouter.get('/polls', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const { page, perPage, skip, take } = parseListQuery(req);

  const where = { spaceId: sid, ...(status && ['draft', 'active', 'closed'].includes(status) ? { status: status as never } : {}) };
  const [total, polls] = await Promise.all([
    db.poll.count({ where }),
    db.poll.findMany({ where, include: pollInclude, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(res, polls.map((p) => serializePoll(p, { showVotes: true, includeRevenue: true })), 200, buildMeta(page, perPage, total));
});

// POST /polls — create (§11.2)
const createPollSchema = z
  .object({
    title: z.string().min(3).max(120),
    description: z.string().max(500).optional(),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    membersOnly: z.boolean(),
    paid: z.boolean(),
    amountPerVote: z.number().int().positive().optional(),
    categories: z
      .array(
        z.object({
          title: z.string().min(1),
          imageUrl: z.string().url().optional(),
          nominees: z.array(z.object({ name: z.string().min(1), imageUrl: z.string().url().optional() })).min(2),
        }),
      )
      .min(1),
    publish: z.boolean().default(false),
  })
  .refine((d) => !d.paid || (d.amountPerVote ?? 0) > 0, { message: 'amountPerVote is required for paid polls', path: ['amountPerVote'] })
  .refine((d) => new Date(`${d.deadline}T23:59:59Z`) > new Date(), { message: 'deadline must be in the future', path: ['deadline'] });

pollsRepRouter.post('/polls', validate(createPollSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const d = req.body as z.infer<typeof createPollSchema>;
  const slug = await uniqueSlug(slugify(d.title));
  const publishing = d.publish;

  const poll = await db.$transaction(async (tx) => {
    const created = await tx.poll.create({
      data: {
        spaceId: sid,
        title: d.title,
        description: d.description,
        deadline: new Date(`${d.deadline}T23:59:59Z`),
        membersOnly: d.membersOnly,
        paid: d.paid,
        amountPerVote: d.paid ? (d.amountPerVote as number) : 0,
        slug,
        status: publishing ? 'active' : 'draft',
        publishedAt: publishing ? new Date() : null,
        categories: {
          create: d.categories.map((c) => ({
            title: c.title,
            imageUrl: c.imageUrl,
            nominees: { create: c.nominees.map((n) => ({ name: n.name, imageUrl: n.imageUrl })) },
          })),
        },
      },
      include: pollInclude,
    });
    if (publishing) await writeAudit(sid, await actor(uid(req)), 'poll_created', `Published poll "${created.title}"`, tx);
    return created;
  });

  ok(res, serializePoll(poll, { showVotes: true, includeRevenue: true }), 201);
});

// POST /polls/image — multipart upload, returns a URL to attach to a category
// or nominee (either inline at poll creation or via the PATCH routes below).
const POLL_IMAGE_DIR = path.join(process.cwd(), 'uploads', 'polls');
fs.mkdirSync(POLL_IMAGE_DIR, { recursive: true });

const ALLOWED_POLL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const POLL_IMAGE_EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const pollImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, POLL_IMAGE_DIR),
    filename: (_req, file, cb) =>
      cb(null, `${randomBytes(16).toString('hex')}${POLL_IMAGE_EXT_BY_TYPE[file.mimetype] ?? ''}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_POLL_IMAGE_TYPES.includes(file.mimetype));
  },
}).single('file');

pollsRepRouter.post('/polls/image', (req: Request, res: Response): void => {
  pollImageUpload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 2 MB limit' : err.message;
      fail(res, 400, 'VALIDATION_ERROR', msg, [{ field: 'file', issue: msg }]);
      return;
    }
    if (err) {
      fail(res, 400, 'VALIDATION_ERROR', 'Upload failed');
      return;
    }
    if (!req.file) {
      fail(res, 400, 'VALIDATION_ERROR', 'A JPEG, PNG, or WebP file is required', [
        { field: 'file', issue: 'required (jpeg/png/webp, ≤ 2 MB)' },
      ]);
      return;
    }

    const imageUrl = `${env.APP_BASE_URL}/uploads/polls/${req.file.filename}`;
    ok(res, { imageUrl });
  });
});

const patchImageSchema = z.object({ imageUrl: z.string().url().nullable() });

// PATCH /polls/:pollId/nominees/:nomineeId — attach/update a nominee's image.
// Cosmetic only (unlike title/structure changes), so it's allowed at any poll status.
pollsRepRouter.patch(
  '/polls/:pollId/nominees/:nomineeId',
  validate(patchImageSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const poll = await loadPollInSpace(sid, req.params.pollId as string);
    if (!poll) {
      errors.notFound(res, 'Poll not found');
      return;
    }
    const nominee = poll.categories.flatMap((c) => c.nominees).find((n) => n.id === req.params.nomineeId);
    if (!nominee) {
      errors.notFound(res, 'Nominee not found');
      return;
    }

    const { imageUrl } = req.body as z.infer<typeof patchImageSchema>;
    await db.nominee.update({ where: { id: nominee.id }, data: { imageUrl } });

    const updated = await loadPollInSpace(sid, poll.id);
    if (!updated) {
      errors.notFound(res, 'Poll not found');
      return;
    }
    ok(res, serializePoll(updated, { showVotes: true, includeRevenue: true }));
  },
);

// PATCH /polls/:pollId/categories/:categoryId — attach/update an award category's image.
// Cosmetic only, so it's allowed at any poll status.
pollsRepRouter.patch(
  '/polls/:pollId/categories/:categoryId',
  validate(patchImageSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const poll = await loadPollInSpace(sid, req.params.pollId as string);
    if (!poll) {
      errors.notFound(res, 'Poll not found');
      return;
    }
    const category = poll.categories.find((c) => c.id === req.params.categoryId);
    if (!category) {
      errors.notFound(res, 'Category not found');
      return;
    }

    const { imageUrl } = req.body as z.infer<typeof patchImageSchema>;
    await db.pollCategory.update({ where: { id: category.id }, data: { imageUrl } });

    const updated = await loadPollInSpace(sid, poll.id);
    if (!updated) {
      errors.notFound(res, 'Poll not found');
      return;
    }
    ok(res, serializePoll(updated, { showVotes: true, includeRevenue: true }));
  },
);

// PATCH /polls/:pollId (§11.3)
const patchPollSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  description: z.string().max(500).optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  membersOnly: z.boolean().optional(),
  paid: z.boolean().optional(),
  amountPerVote: z.number().int().positive().optional(),
});

pollsRepRouter.patch('/polls/:pollId', validate(patchPollSchema), async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const d = req.body as z.infer<typeof patchPollSchema>;
  const poll = await loadPollInSpace(sid, req.params.pollId as string);
  if (!poll) {
    errors.notFound(res, 'Poll not found');
    return;
  }
  if (poll.status === 'closed') {
    errors.conflict(res, 'POLL_CLOSED', 'A closed poll can no longer be edited');
    return;
  }

  const data: Record<string, unknown> = {};
  if (poll.status === 'active') {
    // Structural fields are locked once active.
    if (d.membersOnly !== undefined || d.paid !== undefined || d.amountPerVote !== undefined) {
      errors.conflict(res, 'POLL_STRUCTURE_LOCKED', 'Structural fields are locked once a poll is active');
      return;
    }
    if (d.deadline !== undefined) {
      const next = new Date(`${d.deadline}T23:59:59Z`);
      if (next <= poll.deadline) {
        errors.conflict(res, 'POLL_STRUCTURE_LOCKED', 'An active poll deadline may only be extended');
        return;
      }
      data.deadline = next;
    }
    if (d.title !== undefined) data.title = d.title;
    if (d.description !== undefined) data.description = d.description;
  } else {
    // Draft — edit freely.
    if (d.title !== undefined) data.title = d.title;
    if (d.description !== undefined) data.description = d.description;
    if (d.membersOnly !== undefined) data.membersOnly = d.membersOnly;
    if (d.paid !== undefined) data.paid = d.paid;
    if (d.deadline !== undefined) data.deadline = new Date(`${d.deadline}T23:59:59Z`);
    if (d.amountPerVote !== undefined) data.amountPerVote = d.amountPerVote;
  }

  const updated = await db.poll.update({ where: { id: poll.id }, data, include: pollInclude });
  ok(res, serializePoll(updated, { showVotes: true, includeRevenue: true }));
});

// POST /polls/:pollId/publish · /close (§11.4)
pollsRepRouter.post('/polls/:pollId/publish', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const poll = await loadPollInSpace(sid, req.params.pollId as string);
  if (!poll) {
    errors.notFound(res, 'Poll not found');
    return;
  }
  if (poll.status !== 'draft') {
    errors.conflict(res, 'INVALID_TRANSITION', 'Only a draft poll can be published');
    return;
  }
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.poll.update({ where: { id: poll.id }, data: { status: 'active', publishedAt: new Date() }, include: pollInclude });
    await writeAudit(sid, await actor(uid(req)), 'poll_created', `Published poll "${u.title}"`, tx);
    return u;
  });
  ok(res, serializePoll(updated, { showVotes: true, includeRevenue: true }));
});

pollsRepRouter.post('/polls/:pollId/close', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const poll = await loadPollInSpace(sid, req.params.pollId as string);
  if (!poll) {
    errors.notFound(res, 'Poll not found');
    return;
  }
  if (poll.status === 'closed') {
    // Idempotent.
    ok(res, serializePoll(poll, { showVotes: true, includeRevenue: true }));
    return;
  }
  const updated = await db.poll.update({ where: { id: poll.id }, data: { status: 'closed', closedAt: new Date() }, include: pollInclude });
  ok(res, serializePoll(updated, { showVotes: true, includeRevenue: true }));
});

// GET /polls/:pollId/results (§11.7)
pollsRepRouter.get('/polls/:pollId/results', async (req: Request, res: Response): Promise<void> => {
  const poll = await loadPollInSpace(spaceId(req), req.params.pollId as string);
  if (!poll) {
    errors.notFound(res, 'Poll not found');
    return;
  }
  ok(res, {
    poll: serializePoll(poll, { showVotes: true, includeRevenue: true }),
    totalVotes: poll.totalVotes,
    revenue: poll.revenue,
    categories: poll.categories.map((c) => ({
      id: c.id,
      title: c.title,
      imageUrl: c.imageUrl,
      nominees: c.nominees.map((n) => ({ id: n.id, name: n.name, imageUrl: n.imageUrl, votes: n.votes })),
    })),
  });
});

// ===========================================================================
// Public / voter-facing router — mounted at /polls
// ===========================================================================
export const pollsPublicRouter = Router();

// GET /polls/:slug — voter view (§11.5)
pollsPublicRouter.get('/:slug', optionalAuthenticate, async (req: Request, res: Response): Promise<void> => {
  const viewer = maybeUid(req);
  let poll = await db.poll.findUnique({ where: { slug: req.params.slug as string }, include: pollInclude });
  if (!poll || poll.status === 'draft') {
    errors.notFound(res, 'Poll not found');
    return;
  }
  poll = await autoClose(poll);

  let isMember = false;
  if (viewer) {
    isMember = !!(await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId: viewer, spaceId: poll.spaceId } } }));
  }
  if (poll.membersOnly && !isMember) {
    fail(res, 403, 'MEMBERS_ONLY', 'This poll is open to members only');
    return;
  }

  // Voters see tallies only after close.
  const payload = serializePoll(poll, { showVotes: poll.status === 'closed' }) as Record<string, unknown> & {
    categories: { id: string }[];
  };

  // Attach the caller's remaining votes per category when authenticated.
  if (viewer) {
    const cast = await db.pollVote.findMany({ where: { userId: viewer, categoryId: { in: poll.categories.map((c) => c.id) } } });
    const byCat = new Map<string, number>();
    for (const v of cast) byCat.set(v.categoryId, (byCat.get(v.categoryId) ?? 0) + v.quantity);
    payload.categories = payload.categories.map((c) => ({
      ...c,
      // Members-only polls are one-per-category; others are uncapped (null).
      remaining: poll!.membersOnly ? Math.max(0, 1 - (byCat.get(c.id) ?? 0)) : null,
    }));
  }

  ok(res, payload);
});

// POST /polls/:slug/votes — cast votes (§11.6)
const voteSchema = z
  .object({
    selections: z
      .array(z.object({ categoryId: z.string().min(1), nomineeId: z.string().min(1), quantity: z.number().int().min(1).default(1) }))
      .min(1),
    method: z.enum(['wallet', 'card', 'online']).optional(),
    cardId: z.string().optional(),
  })
  .refine((d) => d.method !== 'card' || !!d.cardId, { message: 'cardId is required for card payments', path: ['cardId'] });

pollsPublicRouter.post('/:slug/votes', authenticate, idempotent, validate(voteSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = uid(req);
  const body = req.body as z.infer<typeof voteSchema>;

  const poll = await db.poll.findUnique({ where: { slug: req.params.slug as string }, include: pollInclude });
  if (!poll || poll.status === 'draft') {
    errors.notFound(res, 'Poll not found');
    return;
  }
  await autoClose(poll);
  if (poll.status !== 'active') {
    errors.conflict(res, 'POLL_CLOSED', 'This poll is closed');
    return;
  }

  // Validate the selections against the poll structure.
  const catById = new Map(poll.categories.map((c) => [c.id, c]));
  for (const sel of body.selections) {
    const cat = catById.get(sel.categoryId);
    if (!cat || !cat.nominees.some((n) => n.id === sel.nomineeId)) {
      errors.validation(res, [{ field: 'selections', issue: 'invalid category or nominee' }]);
      return;
    }
  }

  let selections: VoteSelection[] = body.selections.map((s) => ({ ...s }));

  if (poll.membersOnly) {
    const member = await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId, spaceId: poll.spaceId } } });
    if (!member) {
      fail(res, 403, 'MEMBERS_ONLY', 'This poll is open to members only');
      return;
    }
    selections = selections.map((s) => ({ ...s, quantity: 1 })); // one vote per category
    const cats = selections.map((s) => s.categoryId);
    const existing = await db.pollVote.findFirst({ where: { userId, categoryId: { in: cats } } });
    if (existing) {
      errors.conflict(res, 'ALREADY_VOTED', 'You have already voted in this poll');
      return;
    }
  }

  // Free poll — count immediately.
  if (!poll.paid) {
    const reference = await uniqueReference();
    await db.$transaction((tx) => applyPollVotes(tx, { pollId: poll.id, userId, selections, amountPerVote: 0, reference }));
    ok(res, { receiptId: reference, totalCharged: 0 }, 201);
    return;
  }

  // Paid poll. The space keeps the full face; the voter pays the 3% charge on
  // top (1.5% Duevy + 1.5% Monnify), mirroring dues (§1.5).
  const totalQuantity = selections.reduce((s, sel) => s + sel.quantity, 0);
  const gross = totalQuantity * poll.amountPerVote; // space's cut
  const charge = computeCharge(gross);
  const totalCharged = charge.totalCharged; // what the voter actually pays

  if (!req.headers['idempotency-key']) {
    fail(res, 400, 'VALIDATION_ERROR', 'Idempotency-Key header is required for paid votes', [
      { field: 'Idempotency-Key', issue: 'header is required' },
    ]);
    return;
  }

  if (body.method === 'card') {
    try {
      const { reference, methodLabel } = await chargeSavedCard(userId, body.cardId as string, totalCharged, `Votes: ${poll.title}`);
      const txn = await db.$transaction(async (tx) => {
        const t = await tx.transaction.create({
          data: {
            userId,
            type: 'vote',
            title: `Votes: ${poll.title}`,
            detail: 'Poll',
            amount: -totalCharged,
            method: methodLabel,
            status: 'completed',
            reference,
            spaceId: poll.spaceId,
          },
        });
        await applyPollVotes(tx, { pollId: poll.id, userId, selections, amountPerVote: poll.amountPerVote, reference });
        return t;
      });
      ok(res, { receiptId: txn.id, totalCharged }, 201);
    } catch (err) {
      if (err instanceof CardNotFoundError) {
        errors.notFound(res, 'Card not found');
        return;
      }
      if (err instanceof CardChargeFailedError) {
        fail(res, 402, 'CARD_DECLINED', 'Your card was declined');
        return;
      }
      throw err;
    }
    return;
  }

  if (body.method === 'wallet') {
    const reference = await uniqueReference();
    try {
      const txn = await db.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, walletBalance: { gte: totalCharged } },
          data: { walletBalance: { decrement: totalCharged } },
        });
        if (debit.count === 0) throw new Error('INSUFFICIENT_FUNDS');
        const t = await tx.transaction.create({
          data: {
            userId,
            type: 'vote',
            title: `Votes: ${poll.title}`,
            detail: 'Poll',
            amount: -totalCharged,
            method: 'Wallet',
            status: 'completed',
            reference,
            spaceId: poll.spaceId,
          },
        });
        await applyPollVotes(tx, { pollId: poll.id, userId, selections, amountPerVote: poll.amountPerVote, reference });
        return t;
      });
      ok(res, { receiptId: txn.id, totalCharged }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_FUNDS') {
        fail(res, 402, 'INSUFFICIENT_FUNDS', 'Your wallet balance is too low for these votes');
        return;
      }
      throw err;
    }
    return;
  }

  // method === 'online'
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }
  const reference = await uniqueReference();
  await db.$transaction(async (tx) => {
    await tx.transaction.create({
      data: { userId, type: 'vote', title: `Votes: ${poll.title}`, detail: 'Poll', amount: -totalCharged, method: GATEWAY_LABEL, status: 'pending', reference, spaceId: poll.spaceId },
    });
    await tx.pendingPayment.create({
      data: {
        reference,
        userId,
        type: 'poll_vote',
        metadata: { pollId: poll.id, amountPerVote: poll.amountPerVote, selections },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });
  const init = await initTransaction({
    amount: totalCharged,
    reference,
    customerName: user.name,
    customerEmail: user.email,
    description: `Votes: ${poll.title}`,
    callbackPath: '/vote/callback',
  });
  ok(res, { checkoutUrl: init.checkoutUrl, reference });
});
