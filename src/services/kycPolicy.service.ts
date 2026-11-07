import { type Prisma } from '@prisma/client';
import { db } from '../config/db';
import { cached, invalidate } from '../lib/cache';

/**
 * What a rep must pass before their space can collect, set by an admin
 * (PUT /admin/settings/kyc) without a deploy. The student ID card is always
 * required. Evaluated at decision time, never baked into a rep's record, so
 * turning a check back on applies to everyone at once.
 *
 *  - ninRequired: NIN + date of birth checked against NIMC (Didit). Off by
 *    default; while off it is optional and nothing is sent to Didit.
 *  - livenessRequired: a photo or short video of the rep's face, captured by
 *    the app, approved by an admin next to the student ID. On by default.
 */
export interface KycPolicy {
  ninRequired: boolean;
  livenessRequired: boolean;
}

export const DEFAULT_KYC_POLICY: KycPolicy = { ninRequired: false, livenessRequired: true };

const SETTING_KEY = 'kyc.policy';
const CACHE_KEY = 'kyc:policy';
/** Every instance sees a change within this long (the deciding one at once). */
const CACHE_TTL_MS = 10_000;

function parse(value: unknown): KycPolicy {
  const v = (value ?? {}) as Partial<Record<keyof KycPolicy, unknown>>;
  return {
    ninRequired: typeof v.ninRequired === 'boolean' ? v.ninRequired : DEFAULT_KYC_POLICY.ninRequired,
    livenessRequired: typeof v.livenessRequired === 'boolean' ? v.livenessRequired : DEFAULT_KYC_POLICY.livenessRequired,
  };
}

export async function getKycPolicy(): Promise<KycPolicy> {
  return cached(CACHE_KEY, CACHE_TTL_MS, async () => {
    const row = await db.platformSetting.findUnique({ where: { key: SETTING_KEY } });
    return parse(row?.value);
  });
}

export async function setKycPolicy(adminId: string, patch: Partial<KycPolicy>): Promise<KycPolicy> {
  const current = parse((await db.platformSetting.findUnique({ where: { key: SETTING_KEY } }))?.value);
  const next: KycPolicy = { ...current, ...patch };
  await db.platformSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: adminId },
    update: { value: next as unknown as Prisma.InputJsonValue, updatedById: adminId },
  });
  await invalidate(CACHE_KEY);
  return next;
}

/** The checks a rep's record must pass under `policy`, as a Prisma filter (for counts). */
export function meetsPolicyWhere(policy: KycPolicy): Prisma.UserWhereInput {
  return {
    studentIdStatus: 'approved',
    ...(policy.ninRequired ? { kycStatus: 'verified' as const } : {}),
    ...(policy.livenessRequired ? { livenessStatus: 'approved' as const } : {}),
  };
}

/** How many lead reps can't collect under `policy`: shown to the admin who changes it. */
export async function leadRepsNotMeeting(policy: KycPolicy): Promise<number> {
  return db.user.count({ where: { spaceReps: { some: { role: 'lead' } }, NOT: meetsPolicyWhere(policy) } });
}
