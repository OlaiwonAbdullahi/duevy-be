import { db } from '../config/db';
import {
  createConnectedAccount,
  getRequirementsChecklist,
  getRequirementsTasks,
  uploadRequirementDocument,
  submitRequirements,
  getIdentityMethods,
  submitNinVerification,
  getIdentityStatus,
  type RequirementsChecklist,
  type RequirementTask,
} from '../lib/bachs';

export class NoConnectedAccountError extends Error {
  constructor() {
    super('This space has not started Bachs onboarding yet');
    this.name = 'NoConnectedAccountError';
  }
}

async function requireAccountId(spaceId: string): Promise<string> {
  const space = await db.space.findUnique({ where: { id: spaceId }, select: { bachsAccountId: true } });
  if (!space?.bachsAccountId) throw new NoConnectedAccountError();
  return space.bachsAccountId;
}

/** Creates the space's Bachs connected account on first use; idempotent — returns the existing id if one already exists. */
export async function ensureConnectedAccount(spaceId: string, contactEmail: string): Promise<string> {
  const space = await db.space.findUnique({ where: { id: spaceId }, select: { id: true, name: true, bachsAccountId: true } });
  if (!space) throw new Error('space not found');
  if (space.bachsAccountId) return space.bachsAccountId;

  const account = await createConnectedAccount({ contactEmail, displayName: space.name });
  await db.space.update({
    where: { id: spaceId },
    data: { bachsAccountId: account.id, bachsSetupStatus: account.setup_status },
  });
  return account.id;
}

/** The Tasks/checklist for the frontend to render as its own in-app form — no redirect. */
export async function getOnboardingChecklist(spaceId: string): Promise<{ checklist: RequirementsChecklist; tasks: RequirementTask[] }> {
  const accountId = await requireAccountId(spaceId);
  const [checklist, tasksResult] = await Promise.all([getRequirementsChecklist(accountId), getRequirementsTasks(accountId)]);
  return { checklist, tasks: tasksResult.tasks };
}

export async function uploadOnboardingDocument(
  spaceId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  scope: string,
): Promise<{ uploadId: string }> {
  const accountId = await requireAccountId(spaceId);
  const result = await uploadRequirementDocument(accountId, file, scope);
  return { uploadId: result.upload_id };
}

/** `draft: true` for partial saves — validation problems come back in the refreshed checklist's `errors` instead of failing the request. */
export async function submitOnboarding(spaceId: string, data: Record<string, unknown>, draft: boolean): Promise<RequirementsChecklist> {
  const accountId = await requireAccountId(spaceId);
  return submitRequirements(accountId, { country: 'NG', draft, data });
}

export async function getOnboardingIdentityMethods(spaceId: string) {
  const accountId = await requireAccountId(spaceId);
  return getIdentityMethods(accountId);
}

export async function getOnboardingIdentityStatus(spaceId: string) {
  const accountId = await requireAccountId(spaceId);
  return getIdentityStatus(accountId);
}

/** `consent` must be explicitly true — the rep is attesting to a government database check; the frontend must show real consent copy before calling this. */
export async function submitOnboardingNin(spaceId: string, nin: string, consent: boolean, selfie?: string) {
  if (!consent) throw new Error('consent is required for NIN verification');
  const accountId = await requireAccountId(spaceId);
  return submitNinVerification(accountId, { nin, consent: true, selfie });
}

// ---------------------------------------------------------------------------
// Webhook handlers — organization_id on a Connect event is the connected
// account, not the platform. A capability can move back to `restricted`, so
// this is applied as a state change every time, never assumed sticky.
// ---------------------------------------------------------------------------

export async function applyAccountWebhookUpdate(payload: {
  organization_id: string;
  setup_status?: 'incomplete' | 'awaiting_review' | 'complete';
}): Promise<void> {
  if (!payload.setup_status) return;
  const space = await db.space.findUnique({ where: { bachsAccountId: payload.organization_id } });
  if (!space) return;
  await db.space.update({ where: { id: space.id }, data: { bachsSetupStatus: payload.setup_status } });
}

export async function applyCapabilityWebhookUpdate(payload: {
  organization_id: string;
  capability?: string;
  status?: string;
}): Promise<void> {
  if (!payload.capability) return;
  const space = await db.space.findUnique({ where: { bachsAccountId: payload.organization_id } });
  if (!space) return;

  const active = payload.status === 'active';
  if (payload.capability === 'transfers') {
    await db.space.update({ where: { id: space.id }, data: { bachsTransfersActive: active } });
  } else if (payload.capability === 'payouts') {
    await db.space.update({ where: { id: space.id }, data: { bachsPayoutsActive: active } });
  }
}
