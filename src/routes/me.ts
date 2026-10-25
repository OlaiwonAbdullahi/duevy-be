import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import multer from 'multer';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, fail, errors } from '../lib/response';
import { hashToken } from '../lib/tokens';
import { sniffDocumentType } from '../lib/storage';
import { getKycState } from '../services/kyc.service';
import {
  resubmitStudentIdHandlers,
  sendPhoneCodeHandlers,
  submitKycHandlers,
  verifyPhoneCodeHandlers,
} from './kycHandlers';

export const meRouter = Router();

// Everything under /me requires authentication.
meRouter.use(authenticate);

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// ---------------------------------------------------------------------------
// KYC for the caller — rep applicants verify here before their space exists;
// approved reps can use these or the /spaces/:id/payout/kyc* mounts.
// ---------------------------------------------------------------------------
meRouter.get('/kyc-status', async (req: Request, res: Response): Promise<void> => {
  ok(res, await getKycState(userId(req)));
});
meRouter.post('/kyc', ...submitKycHandlers);
meRouter.post('/kyc/student-id', ...resubmitStudentIdHandlers);
meRouter.post('/kyc/phone/send', ...sendPhoneCodeHandlers);
meRouter.post('/kyc/phone/verify', ...verifyPhoneCodeHandlers);

// Default notification preferences (§3.4) applied when the column is null.
const DEFAULT_NOTIFICATION_PREFS = {
  email: { dueReminders: true, paymentReceipts: true },
  push: { dueReminders: true, payments: true, circleActivity: true },
};

// ---------------------------------------------------------------------------
// PATCH /me — partial profile update (§3.1)
// ---------------------------------------------------------------------------
const patchMeSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().max(254).email().transform((e) => e.toLowerCase()).optional(),
  phone: z
    .string()
    .max(16)
    .regex(/^\+[1-9]\d{1,14}$/, 'must be E.164 format, e.g. +2348012345678')
    .optional(),
  // https or one of our own uploads only — never javascript:/data:/http: links.
  avatarUrl: z
    .string()
    .max(2048)
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith(`${env.APP_BASE_URL}/uploads/`), {
      message: 'must be an https:// URL or an uploaded image',
    })
    .optional(),
});

// The profile fields PATCH /me may echo back — never secrets or KYC internals.
const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  phone: true,
  gender: true,
  avatarUrl: true,
  role: true,
  isRep: true,
  institution: true,
  matricNo: true,
  level: true,
  kycStatus: true,
  repApplicationStatus: true,
  referralCode: true,
  createdAt: true,
} as const;

// School/rep-controlled fields are rejected before validation strips them.
const READ_ONLY_FIELDS = ['matricNo', 'level', 'department', 'role', 'emailVerified'];

function rejectReadOnly(req: Request, res: Response, next: () => void): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const offending = READ_ONLY_FIELDS.filter((f) => f in body);
  if (offending.length) {
    fail(
      res,
      422,
      'FIELD_READ_ONLY',
      'One or more fields cannot be edited here',
      offending.map((f) => ({ field: f, issue: 'read-only' })),
    );
    return;
  }
  next();
}

meRouter.patch('/', rejectReadOnly, validate(patchMeSchema), async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);

  const data = req.body as z.infer<typeof patchMeSchema>;

  const current = await db.user.findUnique({ where: { id: uid }, select: { email: true, name: true } });
  if (!current) {
    errors.notFound(res, 'User not found');
    return;
  }

  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.avatarUrl !== undefined) update.avatarUrl = data.avatarUrl;

  // Email is fixed at sign-up. Echoing the current address back is fine (a
  // profile form may send every field); a different one is refused.
  if (data.email !== undefined && data.email !== current.email) {
    fail(res, 422, 'EMAIL_CHANGE_NOT_ALLOWED', 'Your email address cannot be changed', [
      { field: 'email', issue: 'read-only' },
    ]);
    return;
  }

  const updated = await db.user.update({ where: { id: uid }, data: update, select: PROFILE_SELECT });

  ok(res, updated);
});

// ---------------------------------------------------------------------------
// POST /me/avatar — multipart upload (§3.2)
// ---------------------------------------------------------------------------
const AVATAR_DIR = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_URL_PREFIX = `${env.APP_BASE_URL}/uploads/avatars/`;

// Held in memory so the real type can be sniffed from the bytes before
// anything touches disk; the client's filename and Content-Type are ignored.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
}).single('file');

meRouter.post('/avatar', (req: Request, res: Response): void => {
  avatarUpload(req, res, async (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 2 MB limit' : err.message;
      fail(res, 400, 'VALIDATION_ERROR', msg, [{ field: 'file', issue: msg }]);
      return;
    }
    if (err) {
      fail(res, 400, 'VALIDATION_ERROR', 'Upload failed');
      return;
    }
    const sniffed = req.file ? sniffDocumentType(req.file.buffer) : null;
    if (!req.file || !sniffed || !ALLOWED_AVATAR_TYPES.includes(sniffed.mime)) {
      fail(res, 400, 'VALIDATION_ERROR', 'A JPEG, PNG, or WebP file is required', [
        { field: 'file', issue: 'required (jpeg/png/webp, ≤ 2 MB)' },
      ]);
      return;
    }

    try {
      const uid = userId(req);
      const filename = `${randomBytes(16).toString('hex')}.${sniffed.ext}`;
      await fs.promises.writeFile(path.join(AVATAR_DIR, filename), req.file.buffer);

      const previous = await db.user.findUnique({ where: { id: uid }, select: { avatarUrl: true } });
      const avatarUrl = `${AVATAR_URL_PREFIX}${filename}`;
      await db.user.update({ where: { id: uid }, data: { avatarUrl } });

      // Clean up the old upload — only a plain filename we generated, never a path.
      const old = previous?.avatarUrl?.startsWith(AVATAR_URL_PREFIX) ? previous.avatarUrl.slice(AVATAR_URL_PREFIX.length) : null;
      if (old && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(old)) {
        fs.promises.unlink(path.join(AVATAR_DIR, old)).catch(() => {});
      }

      ok(res, { avatarUrl });
    } catch (e) {
      console.error('[avatar] upload failed', e);
      fail(res, 500, 'INTERNAL_ERROR', 'Could not save the avatar');
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /me/password — change password, revoke other sessions (§3.3)
// ---------------------------------------------------------------------------
const putPasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

meRouter.put('/password', validate(putPasswordSchema), async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);
  const { currentPassword, newPassword } = req.body as z.infer<typeof putPasswordSchema>;

  const user = await db.user.findUnique({ where: { id: uid } });
  if (!user || !user.passwordHash) {
    errors.notFound(res, 'User not found');
    return;
  }

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    fail(res, 400, 'INVALID_CREDENTIALS', 'Current password is incorrect', [
      { field: 'currentPassword', issue: 'incorrect' },
    ]);
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

  // Keep the caller's current session; revoke every other refresh token.
  const currentCookie = req.cookies?.refreshToken;
  const keepHash = currentCookie ? hashToken(currentCookie) : null;

  await db.$transaction([
    db.user.update({ where: { id: uid }, data: { passwordHash } }),
    db.refreshToken.updateMany({
      where: {
        userId: uid,
        revokedAt: null,
        ...(keepHash ? { NOT: { tokenHash: keepHash } } : {}),
      },
      data: { revokedAt: new Date() },
    }),
  ]);

  ok(res, { success: true });
});

// ---------------------------------------------------------------------------
// GET / PUT /me/notification-preferences (§3.4)
// ---------------------------------------------------------------------------
const prefsSchema = z.object({
  email: z.object({
    dueReminders: z.boolean(),
    paymentReceipts: z.boolean(),
  }),
  push: z.object({
    dueReminders: z.boolean(),
    payments: z.boolean(),
    circleActivity: z.boolean(),
  }),
});

meRouter.get('/notification-preferences', async (req: Request, res: Response): Promise<void> => {
  const user = await db.user.findUnique({ where: { id: userId(req) }, select: { notificationPrefs: true } });
  if (!user) {
    errors.notFound(res, 'User not found');
    return;
  }
  ok(res, user.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS);
});

meRouter.put('/notification-preferences', validate(prefsSchema), async (req: Request, res: Response): Promise<void> => {
  const prefs = req.body as z.infer<typeof prefsSchema>;
  await db.user.update({ where: { id: userId(req) }, data: { notificationPrefs: prefs } });
  ok(res, prefs);
});

// ---------------------------------------------------------------------------
// GET /me/overview — student dashboard aggregate (§3.5)
// ---------------------------------------------------------------------------
meRouter.get('/overview', async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);

  const memberships = await db.spaceMembership.findMany({ where: { userId: uid }, select: { spaceId: true } });

  const spaceIds = memberships.map((m) => m.spaceId);
  const now = new Date();

  // Active dues in the caller's spaces that they have not yet paid.
  const openDuesAll = spaceIds.length
    ? await db.due.findMany({
        where: {
          spaceId: { in: spaceIds },
          status: 'active',
          payments: { none: { userId: uid } },
        },
        include: { space: { select: { id: true, name: true, short: true, hue: true } } },
      })
    : [];

  // Overdue first, then earliest deadline.
  openDuesAll.sort((a, b) => {
    const aOver = a.dueDate < now ? 0 : 1;
    const bOver = b.dueDate < now ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    return a.dueDate.getTime() - b.dueDate.getTime();
  });

  const outstandingAmount = openDuesAll.reduce((sum, d) => sum + d.amount, 0);

  const paidAgg = await db.duePayment.aggregate({
    where: { userId: uid },
    _sum: { amountPaid: true },
  });

  const recentTransactions = await db.transaction.findMany({
    where: { userId: uid },
    orderBy: { createdAt: 'desc' },
    take: 4,
  });

  ok(res, {
    outstanding: { amount: outstandingAmount, count: openDuesAll.length },
    paidThisSession: paidAgg._sum.amountPaid ?? 0,
    openDues: openDuesAll.slice(0, 4).map((d) => ({
      id: d.id,
      title: d.title,
      amount: d.amount,
      dueDate: d.dueDate.toISOString().slice(0, 10),
      category: d.category,
      status: d.status,
      overdue: d.dueDate < now,
      space: d.space,
    })),
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      detail: t.detail,
      amount: t.amount,
      method: t.method,
      status: t.status,
      reference: t.reference,
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /me/sessions · DELETE /me/sessions/{sessionId} (§3.6)
// Sessions are the caller's active (non-revoked, unexpired) refresh tokens.
// ---------------------------------------------------------------------------
meRouter.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);
  const currentCookie = req.cookies?.refreshToken;
  const currentHash = currentCookie ? hashToken(currentCookie) : null;

  const tokens = await db.refreshToken.findMany({
    where: { userId: uid, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, device: true, ip: true, createdAt: true, tokenHash: true },
  });

  ok(
    res,
    tokens.map((t) => ({
      id: t.id,
      device: t.device,
      ip: t.ip,
      lastSeenAt: t.createdAt.toISOString(),
      current: currentHash !== null && t.tokenHash === currentHash,
    })),
  );
});

meRouter.delete('/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);
  const sessionId = req.params.sessionId as string;

  const result = await db.refreshToken.updateMany({
    where: { id: sessionId, userId: uid, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (result.count === 0) {
    errors.notFound(res, 'Session not found');
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// DELETE /me — danger-zone deactivation (§3.7)
// ---------------------------------------------------------------------------
const deleteMeSchema = z.object({
  password: z.string(),
  reason: z.string().max(500).optional(),
});

meRouter.delete('/', validate(deleteMeSchema), async (req: Request, res: Response): Promise<void> => {
  const uid = userId(req);
  const { password, reason } = req.body as z.infer<typeof deleteMeSchema>;

  const user = await db.user.findUnique({ where: { id: uid } });
  if (!user || !user.passwordHash) {
    errors.notFound(res, 'User not found');
    return;
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    fail(res, 400, 'INVALID_CREDENTIALS', 'Password is incorrect', [
      { field: 'password', issue: 'incorrect' },
    ]);
    return;
  }

  // A lead rep with active dues must hand off first.
  const leadRoles = await db.spaceRep.findMany({ where: { userId: uid, role: 'lead' }, select: { spaceId: true } });
  if (leadRoles.length) {
    const activeDues = await db.due.count({
      where: { spaceId: { in: leadRoles.map((r) => r.spaceId) }, status: 'active' },
    });
    if (activeDues > 0) {
      errors.conflict(
        res,
        'ACTIVE_REP_OBLIGATIONS',
        'Transfer lead or close active dues before deleting your account',
      );
      return;
    }
  }

  await db.$transaction([
    db.user.update({
      where: { id: uid },
      data: { isDeactivated: true, deactivatedReason: reason ?? 'user requested deletion' },
    }),
    db.refreshToken.updateMany({ where: { userId: uid, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  res.status(204).end();
});
