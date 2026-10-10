import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { feedbackLimiter } from '../middleware/rateLimiter';
import { ok, errors } from '../lib/response';
import { serializeFeedback } from '../lib/serializers';

export const feedbackRouter = Router();
feedbackRouter.use(authenticate);

const submitSchema = z.object({
  category: z.enum(['bug', 'idea', 'other']),
  message: z.string().trim().min(10).max(2000),
  /** App path it was sent from, e.g. `/dashboard/payout` — helps reproduce bugs. */
  page: z.string().trim().max(300).optional(),
});

// ---------------------------------------------------------------------------
// POST /feedback — any signed-in user (student, rep, applicant). Reviewed in
// GET /admin/feedback.
// ---------------------------------------------------------------------------
feedbackRouter.post('/', feedbackLimiter, validate(submitSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthenticatedRequest).user.sub as string;
  const { category, message, page } = req.body as z.infer<typeof submitSchema>;

  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, role: true } });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }

  const feedback = await db.feedback.create({
    data: {
      userId,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      category,
      message,
      page: page || null,
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    },
  });
  ok(res, serializeFeedback(feedback), 201);
});
