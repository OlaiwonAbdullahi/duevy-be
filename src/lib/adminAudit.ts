import { type Request } from 'express';
import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { type AuthenticatedRequest } from '../middleware/auth';

type Severity = 'info' | 'warning' | 'critical';

/**
 * Record an admin action to the admin audit log (§14.9). Every mutating admin
 * route calls this. Actor identity, ip, and device are pulled from the request.
 */
export async function writeAdminAudit(
  req: Request,
  action: string,
  opts: { target?: string; severity?: Severity; metadata?: Prisma.InputJsonValue } = {},
): Promise<void> {
  const user = (req as AuthenticatedRequest).user;
  const actorId = (user?.sub as string) ?? 'unknown';
  const actor = await db.user.findUnique({ where: { id: actorId }, select: { name: true } });

  await db.adminAuditLog.create({
    data: {
      actorId,
      actorName: actor?.name ?? 'Admin',
      role: (user?.role as string) ?? 'admin',
      action,
      target: opts.target,
      ip: req.ip,
      device: req.headers['user-agent'],
      severity: opts.severity ?? 'info',
      metadata: opts.metadata,
    },
  });
}
