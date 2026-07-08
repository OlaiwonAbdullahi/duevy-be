import { type Prisma, type AuditAction } from '@prisma/client';
import { db } from '../config/db';

/**
 * Write a space audit-log entry (§5.8). Accepts an optional transaction client
 * so it can be enrolled in the same transaction as the action it records.
 */
export async function writeAudit(
  spaceId: string,
  actor: { id: string; name: string },
  action: AuditAction,
  description: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<void> {
  await client.spaceAuditLog.create({
    data: { spaceId, actorId: actor.id, actorName: actor.name, action, description },
  });
}
