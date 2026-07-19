import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { ok, errors } from '../lib/response';
import { generateReferralCode, REFERRAL_REWARD_KOBO } from '../lib/referral';
import { sendEmail, renderEmail } from '../lib/email';

export const referralsRouter = Router();
referralsRouter.use(authenticate);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

/** The referral program is rep-only (§12): reps, admins, or anyone who leads/co-runs a space. */
async function requireRepAccess(userId: string): Promise<{ id: string; name: string; role: string; referralCode: string | null } | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, referralCode: true } });
  if (!user) return null;
  if (user.role === 'rep' || user.role === 'admin') return user;
  const isSpaceRep = await db.spaceRep.findFirst({ where: { userId }, select: { id: true } });
  return isSpaceRep ? user : null;
}

// ---------------------------------------------------------------------------
// GET /referrals (§12.1)
// ---------------------------------------------------------------------------
referralsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const user = await requireRepAccess(id);
  if (!user) {
    errors.forbidden(res, 'The referral program is available to reps only');
    return;
  }

  // Reps provisioned before referral codes existed get one lazily.
  let code = user.referralCode;
  if (!code) {
    code = await generateReferralCode(user.name);
    await db.user.update({ where: { id }, data: { referralCode: code } });
  }

  const referrals = await db.referral.findMany({
    where: { referrerId: id },
    include: { referred: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const joined = referrals.filter((r) => r.status === 'joined' || r.status === 'paid').length;
  const earned = referrals.reduce((sum, r) => sum + r.reward, 0);

  ok(res, {
    code,
    link: `${env.FRONTEND_URL}/join?ref=${code}`,
    rewardPerReferral: REFERRAL_REWARD_KOBO,
    summary: { invited: referrals.length, joined, earned },
    referrals: referrals.map((r) => ({
      id: r.id,
      name: r.referred.name,
      status: r.status,
      reward: r.reward,
      date: r.createdAt.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /referrals/invites (§12.2)
// ---------------------------------------------------------------------------
const invitesSchema = z.object({ emails: z.array(z.string().email()).min(1).max(20) });

referralsRouter.post('/invites', validate(invitesSchema), async (req: Request, res: Response): Promise<void> => {
  const id = uid(req);
  const user = await requireRepAccess(id);
  if (!user) {
    errors.forbidden(res, 'The referral program is available to reps only');
    return;
  }

  let code = user.referralCode;
  if (!code) {
    code = await generateReferralCode(user.name);
    await db.user.update({ where: { id }, data: { referralCode: code } });
  }
  const link = `${env.FRONTEND_URL}/join?ref=${code}`;
  const { emails } = req.body as z.infer<typeof invitesSchema>;

  for (const to of emails) {
    sendEmail({
      to,
      subject: `${user.name} invited you to become a rep on Duevy`,
      html: renderEmail(`
        <h1>You're invited to Duevy</h1>
        <p>${user.name} thinks you'd make a great department rep on Duevy.</p>
        <a href="${link}" class="btn">Sign up to get started</a>
        <div class="callout">Referral code: <strong>${code}</strong></div>
      `),
    }).catch(console.error);
  }

  ok(res, { sent: emails.length });
});
