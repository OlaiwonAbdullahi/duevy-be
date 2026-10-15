import { Prisma, type Partner, type PartnerRedemption, type PartnerRedemptionSource } from '@prisma/client';
import { db } from '../config/db';
import { AppError, conflict } from '../lib/errors';

/**
 * Partners (SUG, NACOS, …). A partner has a code; a space that redeems it gets
 * `withdrawalFeeDiscountPercent` off its withdrawal fees, for `durationDays`
 * (or for good). A code is redeemable while it is active, not past
 * `expiresAt` and under `maxRedemptions`. The percent and end date are copied
 * onto the redemption, so editing or deactivating the partner later never
 * changes a space's existing terms; an admin revokes a redemption to end it.
 */

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizePartnerCode(code: string): string {
  return code.trim().toUpperCase();
}

export function serializePartnerPreview(p: Partner) {
  return {
    code: p.code,
    name: p.name,
    short: p.short,
    logoUrl: p.logoUrl,
    withdrawalFeeDiscountPercent: p.withdrawalFeeDiscountPercent,
    durationDays: p.durationDays,
  };
}

export function isRedemptionActive(r: Pick<PartnerRedemption, 'revokedAt' | 'endsAt'>, now = new Date()): boolean {
  return !r.revokedAt && (!r.endsAt || r.endsAt > now);
}

export function serializeSpacePartner(r: PartnerRedemption & { partner: Partner }, now = new Date()) {
  return {
    id: r.id,
    partner: serializePartnerPreview(r.partner),
    source: r.source,
    discountPercent: r.discountPercent,
    endsAt: r.endsAt?.toISOString() ?? null,
    active: isRedemptionActive(r, now),
    createdAt: r.createdAt.toISOString(),
  };
}

function partnerError(code: 'INVALID_PARTNER_CODE' | 'PARTNER_CODE_EXPIRED' | 'PARTNER_CODE_EXHAUSTED', message: string) {
  return new AppError(422, code, message, [{ field: 'partnerCode', issue: message }]);
}

/** The partner behind `code` if it can be redeemed right now; throws a 422 otherwise. */
export async function findRedeemablePartner(code: string, client: Tx | typeof db = db): Promise<Partner> {
  const partner = await client.partner.findUnique({ where: { code: normalizePartnerCode(code) } });
  if (!partner || !partner.isActive) throw partnerError('INVALID_PARTNER_CODE', 'That partner code is not valid');
  if (partner.expiresAt && partner.expiresAt <= new Date()) {
    throw partnerError('PARTNER_CODE_EXPIRED', 'That partner code has expired');
  }
  if (partner.maxRedemptions !== null) {
    const used = await client.partnerRedemption.count({ where: { partnerId: partner.id, revokedAt: null } });
    if (used >= partner.maxRedemptions) throw partnerError('PARTNER_CODE_EXHAUSTED', 'That partner code has been fully used');
  }
  return partner;
}

/**
 * Redeem `code` for a space inside the caller's transaction. The partner row
 * is locked so concurrent redemptions can't overshoot `maxRedemptions`.
 */
export async function redeemForSpace(
  tx: Tx,
  input: { spaceId: string; code: string; userId: string | null; source: PartnerRedemptionSource },
): Promise<PartnerRedemption & { partner: Partner }> {
  const existing = await tx.partnerRedemption.findUnique({ where: { spaceId: input.spaceId } });
  if (existing) {
    throw conflict(
      'PARTNER_ALREADY_APPLIED',
      existing.revokedAt ? 'This space’s partner discount was revoked. Contact support to change it.' : 'This space already has a partner',
    );
  }
  await tx.$queryRaw`SELECT "id" FROM "partners" WHERE "code" = ${normalizePartnerCode(input.code)} FOR UPDATE`;
  const partner = await findRedeemablePartner(input.code, tx);
  const now = new Date();
  try {
    return await tx.partnerRedemption.create({
      data: {
        partnerId: partner.id,
        spaceId: input.spaceId,
        redeemedById: input.userId,
        source: input.source,
        discountPercent: partner.withdrawalFeeDiscountPercent,
        endsAt: partner.durationDays ? new Date(now.getTime() + partner.durationDays * DAY_MS) : null,
      },
      include: { partner: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('PARTNER_ALREADY_APPLIED', 'This space already has a partner');
    }
    throw err;
  }
}

/** The space's partner redemption (revoked ones excluded), active or ended. */
export async function getSpacePartner(spaceId: string) {
  return db.partnerRedemption.findFirst({ where: { spaceId, revokedAt: null }, include: { partner: true } });
}

/** The redemption currently discounting this space's withdrawal fees, if any. */
export async function getActiveDiscount(spaceId: string, client: Tx | typeof db = db, now = new Date()) {
  const r = await client.partnerRedemption.findFirst({
    where: { spaceId, revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    include: { partner: true },
  });
  return r ?? null;
}
