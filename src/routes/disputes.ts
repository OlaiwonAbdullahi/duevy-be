import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { serializeDispute } from '../lib/serializers';

export const disputesRouter = Router();
disputesRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// POST /disputes — file a dispute (any role) (§14.6)
// ---------------------------------------------------------------------------
const fileSchema = z.object({
  type: z.enum(['payment_not_reflecting', 'non_remittance', 'refund_request']),
  transactionReference: z.string().optional(),
  description: z.string().min(10).max(2000),
});

disputesRouter.post('/', validate(fileSchema), async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const { type, transactionReference, description } = req.body as z.infer<typeof fileSchema>;

  const user = await db.user.findUnique({
    where: { id },
    select: { name: true, email: true, spaceMemberships: { take: 1, select: { space: { select: { name: true } } } } },
  });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }

  const dispute = await db.dispute.create({
    data: {
      type,
      openedById: id,
      openedByName: user.name,
      openedByEmail: user.email,
      department: user.spaceMemberships[0]?.space.name ?? null,
      txnReference: transactionReference,
      description,
    },
  });

  ok(res, serializeDispute(dispute), 201);
});

// ---------------------------------------------------------------------------
// GET /disputes — the caller's own filed disputes
// ---------------------------------------------------------------------------
disputesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const disputes = await db.dispute.findMany({ where: { openedById: uid(req) }, orderBy: { createdAt: 'desc' } });
  ok(res, disputes.map(serializeDispute));
});
