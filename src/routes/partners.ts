import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { type Partner, type Prisma } from '@prisma/client';
import multer from 'multer';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep, requireAdminPermission } from '../middleware/requireRole';
import { lookupLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { parseListQuery, buildMeta } from '../lib/pagination';
import { writeAudit } from '../lib/audit';
import { writeAdminAudit } from '../lib/adminAudit';
import { sniffDocumentType } from '../lib/storage';
import {
  findRedeemablePartner,
  getSpacePartner,
  normalizePartnerCode,
  redeemForSpace,
  serializePartnerPreview,
  serializeSpacePartner,
} from '../services/partner.service';

/**
 * Partners (SUG, NACOS, …) — see partner.service.ts.
 *   partnersRouter      /partners/lookup (public, for the signup form)
 *   spacePartnerRouter  /spaces/:spaceId/partner (reps)
 *   adminPartnersRouter /admin/partners, /admin/partner-redemptions
 */

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

const codeSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9-]+$/, 'letters, numbers and dashes only')
  .transform(normalizePartnerCode);

// ---------------------------------------------------------------------------
// GET /partners/lookup?code= — preview a code before signing up with it.
// ---------------------------------------------------------------------------
export const partnersRouter = Router();

partnersRouter.get('/lookup', lookupLimiter, async (req: Request, res: Response): Promise<void> => {
  // req.query is read-only in Express 5, so it's parsed here rather than by validate().
  const code = codeSchema.safeParse(req.query.code);
  if (!code.success) {
    errors.validation(res, [{ field: 'code', issue: code.error.errors[0]?.message ?? 'invalid' }]);
    return;
  }
  ok(res, serializePartnerPreview(await findRedeemablePartner(code.data)));
});

// ---------------------------------------------------------------------------
// GET/POST /spaces/:spaceId/partner — the space's partner discount. Any rep
// can see it; only the lead rep can apply a code (once per space).
// ---------------------------------------------------------------------------
export const spacePartnerRouter = Router({ mergeParams: true });

spacePartnerRouter.get('/partner', requireSpaceRep(), async (req: Request, res: Response): Promise<void> => {
  const r = await getSpacePartner(req.params.spaceId as string);
  ok(res, r ? serializeSpacePartner(r) : null);
});

spacePartnerRouter.post(
  '/partner',
  requireSpaceRep(true),
  validate(z.object({ code: codeSchema })),
  async (req: Request, res: Response): Promise<void> => {
    const spaceId = req.params.spaceId as string;
    const userId = uid(req);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const r = await db.$transaction(async (tx) => {
      const created = await redeemForSpace(tx, { spaceId, code: req.body.code as string, userId, source: 'settings' });
      await writeAudit(
        spaceId,
        { id: userId, name: user.name, role: 'lead' },
        'partner_applied',
        `Applied partner code ${created.partner.code} (${created.partner.short}): ${created.discountPercent}% off withdrawal fees`,
        tx,
      );
      return created;
    });
    ok(res, serializeSpacePartner(r), 201);
  },
);

// ---------------------------------------------------------------------------
// Admin: partners and their redemptions. Discounts change payout fees, so
// these sit under the `payouts` permission.
// ---------------------------------------------------------------------------
export const adminPartnersRouter = Router();

type PartnerWithCount = Partner & { _count: { redemptions: number } };
const withCount = { _count: { select: { redemptions: { where: { revokedAt: null } } } } } satisfies Prisma.PartnerInclude;

function serializeAdminPartner(p: PartnerWithCount) {
  return {
    id: p.id,
    name: p.name,
    short: p.short,
    code: p.code,
    logoUrl: p.logoUrl,
    withdrawalFeeDiscountPercent: p.withdrawalFeeDiscountPercent,
    durationDays: p.durationDays,
    maxRedemptions: p.maxRedemptions,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    isActive: p.isActive,
    redemptionCount: p._count.redemptions,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Logos must be https or one of our own uploads — no javascript:/data:/http: links. */
const logoUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://') || u.startsWith(`${env.APP_BASE_URL}/uploads/`), {
    message: 'must be an https:// URL or an uploaded image',
  });

const partnerFields = {
  name: z.string().trim().min(2).max(120),
  short: z.string().trim().min(2).max(12),
  code: codeSchema,
  logoUrl: logoUrlSchema.nullable().optional(),
  withdrawalFeeDiscountPercent: z.number().int().min(1).max(100),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
};
const createPartnerSchema = z.object(partnerFields);
const patchPartnerSchema = z.object(partnerFields).partial();

const listStatus = z.enum(['all', 'active', 'inactive']).catch('all');

adminPartnersRouter.get('/partners', requireAdminPermission('payouts'), async (req: Request, res: Response): Promise<void> => {
  const { page, perPage, skip, take, q } = parseListQuery(req);
  const status = listStatus.parse(req.query.status);
  const where: Prisma.PartnerWhereInput = {
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { short: { contains: q, mode: 'insensitive' } },
            { code: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.partner.findMany({ where, include: withCount, orderBy: { createdAt: 'desc' }, skip, take }),
    db.partner.count({ where }),
  ]);
  ok(res, rows.map(serializeAdminPartner), 200, buildMeta(page, perPage, total));
});

function isCodeTaken(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

adminPartnersRouter.post(
  '/partners',
  requireAdminPermission('payouts'),
  validate(createPartnerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const d = req.body as z.infer<typeof createPartnerSchema>;
    try {
      const p = await db.partner.create({ data: { ...d, createdById: uid(req) }, include: withCount });
      await writeAdminAudit(req, 'partner.create', {
        target: p.id,
        metadata: { code: p.code, withdrawalFeeDiscountPercent: p.withdrawalFeeDiscountPercent },
      });
      ok(res, serializeAdminPartner(p), 201);
    } catch (err) {
      if (!isCodeTaken(err)) throw err;
      fail(res, 409, 'PARTNER_CODE_TAKEN', 'Another partner already uses that code', [{ field: 'code', issue: 'already in use' }]);
    }
  },
);

adminPartnersRouter.patch(
  '/partners/:partnerId',
  requireAdminPermission('payouts'),
  validate(patchPartnerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.partnerId as string;
    const d = req.body as z.infer<typeof patchPartnerSchema>;
    if (Object.keys(d).length === 0) {
      errors.validation(res, [{ field: 'body', issue: 'at least one field is required' }]);
      return;
    }
    if (!(await db.partner.findUnique({ where: { id }, select: { id: true } }))) {
      errors.notFound(res, 'Partner not found');
      return;
    }
    try {
      const p = await db.partner.update({ where: { id }, data: d, include: withCount });
      await writeAdminAudit(req, 'partner.update', { target: id, metadata: { fields: Object.keys(d) } });
      ok(res, serializeAdminPartner(p));
    } catch (err) {
      if (!isCodeTaken(err)) throw err;
      fail(res, 409, 'PARTNER_CODE_TAKEN', 'Another partner already uses that code', [{ field: 'code', issue: 'already in use' }]);
    }
  },
);

// POST /admin/partners/logo — multipart upload; returns a URL for logoUrl.
const PARTNER_LOGO_DIR = path.join(process.cwd(), 'uploads', 'partners');
fs.mkdirSync(PARTNER_LOGO_DIR, { recursive: true });
const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Held in memory so the real type can be sniffed before anything touches disk.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }).single('file');

adminPartnersRouter.post('/partners/logo', requireAdminPermission('payouts'), (req: Request, res: Response): void => {
  logoUpload(req, res, async (err: unknown) => {
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
    if (!req.file || !sniffed || !ALLOWED_LOGO_TYPES.includes(sniffed.mime)) {
      fail(res, 400, 'VALIDATION_ERROR', 'A JPEG, PNG, or WebP file is required', [{ field: 'file', issue: 'required (jpeg/png/webp, ≤ 2 MB)' }]);
      return;
    }
    const filename = `${randomBytes(16).toString('hex')}.${sniffed.ext}`;
    try {
      await fs.promises.writeFile(path.join(PARTNER_LOGO_DIR, filename), req.file.buffer);
    } catch {
      fail(res, 500, 'INTERNAL_ERROR', 'Could not save the image');
      return;
    }
    ok(res, { logoUrl: `${env.APP_BASE_URL}/uploads/partners/${filename}` });
  });
});

const redemptionInclude = {
  space: { select: { id: true, name: true, short: true } },
  redeemedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.PartnerRedemptionInclude;

function serializeAdminRedemption(r: Prisma.PartnerRedemptionGetPayload<{ include: typeof redemptionInclude }>) {
  return {
    id: r.id,
    space: r.space,
    redeemedBy: r.redeemedBy,
    source: r.source,
    discountPercent: r.discountPercent,
    endsAt: r.endsAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

adminPartnersRouter.get(
  '/partners/:partnerId/redemptions',
  requireAdminPermission('payouts'),
  async (req: Request, res: Response): Promise<void> => {
    const rows = await db.partnerRedemption.findMany({
      where: { partnerId: req.params.partnerId as string },
      include: redemptionInclude,
      orderBy: { createdAt: 'desc' },
    });
    ok(res, rows.map(serializeAdminRedemption));
  },
);

adminPartnersRouter.post(
  '/partner-redemptions/:redemptionId/revoke',
  requireAdminPermission('payouts'),
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.redemptionId as string;
    const existing = await db.partnerRedemption.findUnique({ where: { id } });
    if (!existing) {
      errors.notFound(res, 'Redemption not found');
      return;
    }
    const r = existing.revokedAt
      ? await db.partnerRedemption.findUniqueOrThrow({ where: { id }, include: redemptionInclude })
      : await db.partnerRedemption.update({ where: { id }, data: { revokedAt: new Date() }, include: redemptionInclude });
    if (!existing.revokedAt) {
      await writeAdminAudit(req, 'partner.redemption_revoke', {
        target: id,
        severity: 'warning',
        metadata: { partnerId: existing.partnerId, spaceId: existing.spaceId },
      });
    }
    ok(res, serializeAdminRedemption(r));
  },
);
