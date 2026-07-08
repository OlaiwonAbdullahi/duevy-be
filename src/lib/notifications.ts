import { type NotificationKind, type NotificationTone } from '@prisma/client';
import { db } from '../config/db';

interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  tone?: NotificationTone;
  href?: string;
}

/** Create a single in-app notification (§13). */
export async function notify(input: NotificationInput): Promise<void> {
  await db.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      tone: input.tone ?? 'brand',
      title: input.title,
      detail: input.detail,
      href: input.href,
    },
  });
}

/** Fan a notification out to many users in one insert. */
export async function notifyMany(userIds: string[], input: Omit<NotificationInput, 'userId'>): Promise<number> {
  if (userIds.length === 0) return 0;
  const result = await db.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      kind: input.kind,
      tone: input.tone ?? 'brand',
      title: input.title,
      detail: input.detail,
      href: input.href,
    })),
  });
  return result.count;
}
