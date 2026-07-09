import { Router, type Request, type Response } from 'express';
import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { serializeNotification } from '../lib/serializers';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// GET /notifications — paginated, newest first; meta carries unreadCount (§13.1)
// ---------------------------------------------------------------------------
notificationsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const { page, perPage, skip, take } = parseListQuery(req);

  // Optional `since` cursor for lightweight polling.
  const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const where: Prisma.NotificationWhereInput = { userId: id };
  if (since && !Number.isNaN(since.getTime())) where.createdAt = { gt: since };

  const [total, unreadCount, rows] = await Promise.all([
    db.notification.count({ where }),
    db.notification.count({ where: { userId: id, read: false } }),
    db.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);

  ok(res, rows.map(serializeNotification), 200, { ...buildMeta(page, perPage, total), unreadCount });
});

// ---------------------------------------------------------------------------
// POST /notifications/{id}/read (§13.2)
// ---------------------------------------------------------------------------
notificationsRouter.post('/:notificationId/read', async (req: Request, res: Response): Promise<void> => {
  const result = await db.notification.updateMany({
    where: { id: req.params.notificationId as string, userId: uid(req) },
    data: { read: true },
  });
  if (result.count === 0) {
    errors.notFound(res, 'Notification not found');
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /notifications/read-all (§13.2)
// ---------------------------------------------------------------------------
notificationsRouter.post('/read-all', async (req: Request, res: Response): Promise<void> => {
  await db.notification.updateMany({ where: { userId: uid(req), read: false }, data: { read: true } });
  res.status(204).end();
});
