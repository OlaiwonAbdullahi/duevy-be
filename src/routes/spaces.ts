import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { lookupLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { serializeSpace, type SpaceMembershipView } from '../lib/serializers';
import { circleRouter } from './circle';
import { repDuesRouter } from './repDues';
import { payoutsRouter } from './payouts';

export const spacesRouter = Router();

spacesRouter.use(authenticate);

function auth(req: Request) {
  return (req as AuthenticatedRequest).user;
}

function serializeDue(d: {
  id: string;
  title: string;
  amount: number;
  dueDate: Date;
  category: string;
  status: string;
}) {
  return {
    id: d.id,
    title: d.title,
    amount: d.amount,
    dueDate: d.dueDate.toISOString().slice(0, 10),
    category: d.category,
    status: d.status,
  };
}

// ---------------------------------------------------------------------------
// GET /spaces — spaces the caller belongs to (member + guest) (§4.1)
// ---------------------------------------------------------------------------
spacesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const memberships = await db.spaceMembership.findMany({
    where: { userId: auth(req).sub as string },
    include: { space: { include: { _count: { select: { memberships: true } } } } },
    orderBy: { joinedAt: 'asc' },
  });

  ok(
    res,
    memberships
      .filter((m) => !m.space.isArchived)
      .map((m) =>
        serializeSpace(m.space, {
          memberCount: m.space._count.memberships,
          membership: m.kind as SpaceMembershipView,
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// POST /spaces/lookup — resolve a join code to a preview (§4.3)
// ---------------------------------------------------------------------------
const lookupSchema = z.object({ code: z.string().min(1).transform((c) => c.trim().toUpperCase()) });

spacesRouter.post('/lookup', lookupLimiter, validate(lookupSchema), async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body as z.infer<typeof lookupSchema>;

  const space = await db.space.findFirst({
    where: { joinCode: code, isArchived: false },
    include: {
      _count: { select: { memberships: true } },
      dues: { where: { status: 'active' } },
    },
  });

  if (!space) {
    fail(res, 404, 'JOIN_CODE_INVALID', 'That join code is not valid');
    return;
  }

  ok(res, {
    ...serializeSpace(space, { memberCount: space._count.memberships }),
    code: space.joinCode,
    dues: space.dues.map(serializeDue),
  });
});

// ---------------------------------------------------------------------------
// GET /spaces/{spaceId} — single space; members, guests, admins only (§4.2)
// ---------------------------------------------------------------------------
spacesRouter.get('/:spaceId', async (req: Request, res: Response): Promise<void> => {
  const user = auth(req);
  const spaceId = req.params.spaceId as string;

  const space = await db.space.findUnique({
    where: { id: spaceId },
    include: { _count: { select: { memberships: true } } },
  });
  if (!space) {
    errors.notFound(res, 'Space not found');
    return;
  }

  const isAdmin = user.role === 'admin';
  const membership = await db.spaceMembership.findUnique({
    where: { userId_spaceId: { userId: user.sub as string, spaceId } },
  });

  if (!membership && !isAdmin) {
    errors.forbidden(res, 'You do not have access to this space');
    return;
  }

  ok(
    res,
    serializeSpace(space, {
      memberCount: space._count.memberships,
      membership: isAdmin ? undefined : (membership!.kind as SpaceMembershipView),
    }),
  );
});

// ---------------------------------------------------------------------------
// POST /spaces/{spaceId}/join (§4.4)
// ---------------------------------------------------------------------------
const joinSchema = z.object({
  code: z.string().min(1).transform((c) => c.trim().toUpperCase()),
  as: z.enum(['member', 'guest']).default('member'),
});

spacesRouter.post('/:spaceId/join', validate(joinSchema), async (req: Request, res: Response): Promise<void> => {
  const uid = auth(req).sub as string;
  const spaceId = req.params.spaceId as string;
  const { code, as } = req.body as z.infer<typeof joinSchema>;

  const space = await db.space.findUnique({ where: { id: spaceId } });
  if (!space || space.isArchived) {
    errors.notFound(res, 'Space not found');
    return;
  }

  // Code is re-validated server-side.
  if (space.joinCode.toUpperCase() !== code) {
    fail(res, 422, 'JOIN_CODE_INVALID', 'That join code is not valid for this space');
    return;
  }

  const existing = await db.spaceMembership.findUnique({
    where: { userId_spaceId: { userId: uid, spaceId } },
  });
  if (existing) {
    errors.conflict(res, 'ALREADY_MEMBER', 'You are already in this space');
    return;
  }

  // Anyone with a valid join code joins directly — no rep approval.
  const membership = await db.spaceMembership.create({
    data: { userId: uid, spaceId, kind: as },
  });

  ok(
    res,
    { spaceId, status: 'active', membership: membership.kind, joinedAt: membership.joinedAt.toISOString() },
    201,
  );
});

// ---------------------------------------------------------------------------
// DELETE /spaces/{spaceId}/membership — leave a space (§4.5)
// ---------------------------------------------------------------------------
spacesRouter.delete('/:spaceId/membership', async (req: Request, res: Response): Promise<void> => {
  const uid = auth(req).sub as string;
  const spaceId = req.params.spaceId as string;

  const membership = await db.spaceMembership.findUnique({
    where: { userId_spaceId: { userId: uid, spaceId } },
  });
  if (!membership) {
    errors.notFound(res, 'You are not in this space');
    return;
  }

  // Cannot leave with unpaid active dues in this space.
  const paidDueIds = (
    await db.duePayment.findMany({ where: { userId: uid }, select: { dueId: true } })
  ).map((p) => p.dueId);

  const outstanding = await db.due.count({
    where: {
      spaceId,
      status: 'active',
      id: { notIn: paidDueIds.length ? paidDueIds : undefined },
    },
  });
  if (outstanding > 0) {
    errors.conflict(res, 'UNPAID_OBLIGATIONS', 'Settle your outstanding dues before leaving this space');
    return;
  }

  await db.spaceMembership.delete({ where: { id: membership.id } });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// PATCH /spaces/{spaceId} — update department profile — Rep (lead) (§4.6)
// ---------------------------------------------------------------------------
const patchSpaceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  short: z.string().min(2).max(6).optional(),
  about: z.string().max(500).optional(),
  hue: z.enum(['emerald', 'indigo', 'amber', 'rose', 'slate']).optional(),
  theme: z.enum(['emerald', 'ocean', 'royal', 'crimson', 'tangerine']).optional(),
});

spacesRouter.patch(
  '/:spaceId',
  requireSpaceRep(true),
  validate(patchSpaceSchema),
  async (req: Request, res: Response): Promise<void> => {
    const uid = auth(req).sub as string;
    const spaceId = req.params.spaceId as string;
    const data = req.body as z.infer<typeof patchSpaceSchema>;

    if (Object.keys(data).length === 0) {
      errors.validation(res, [{ field: 'body', issue: 'at least one field is required' }]);
      return;
    }

    const actor = await db.user.findUnique({ where: { id: uid }, select: { name: true } });

    const [space] = await db.$transaction([
      db.space.update({
        where: { id: spaceId },
        data,
        include: { _count: { select: { memberships: true } } },
      }),
      db.spaceAuditLog.create({
        data: {
          spaceId,
          actorId: uid,
          actorName: actor?.name ?? 'Rep',
          action: 'profile_updated',
          description: `Updated space profile: ${Object.keys(data).join(', ')}`,
        },
      }),
    ]);

    ok(res, serializeSpace(space, { memberCount: space._count.memberships }));
  },
);

// Rep-scoped sub-routers (§5 circle management, §7 dues management).
// Mounted last so the member-accessible routes above (e.g. GET /:spaceId)
// resolve before the rep-gated sub-routers are reached.
spacesRouter.use('/:spaceId', circleRouter);
spacesRouter.use('/:spaceId', repDuesRouter);
spacesRouter.use('/:spaceId', payoutsRouter);
