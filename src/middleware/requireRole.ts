import { type Request, type Response, type NextFunction } from 'express';
import { type AuthenticatedRequest } from './auth';
import { errors, fail } from '../lib/response';
import { db } from '../config/db';

type AllowedRole = 'student' | 'rep' | 'admin';

/** Require the authenticated user to have one of the specified roles. */
export function requireRole(...roles: AllowedRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      errors.unauthorized(res);
      return;
    }
    if (!roles.includes(user.role as AllowedRole)) {
      errors.forbidden(res, `Requires one of: ${roles.join(', ')}`);
      return;
    }
    next();
  };
}

/** Require the authenticated user to be a rep (lead or co) of the given space.
 *  The spaceId is read from req.params.spaceId by default.
 */
export function requireSpaceRep(leadOnly = false) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const user = (req as AuthenticatedRequest).user;
    // Express 5 types params as string | string[]; a single named param is a string.
    const spaceId = req.params.spaceId as string;

    if (!user || !spaceId) {
      errors.forbidden(res);
      return;
    }

    const rep = await db.spaceRep.findUnique({
      where: { userId_spaceId: { userId: user.sub as string, spaceId } },
    });

    if (!rep) {
      errors.forbidden(res, 'You are not a rep of this space');
      return;
    }

    if (leadOnly && rep.role !== 'lead') {
      errors.forbidden(res, 'Only the lead rep can perform this action');
      return;
    }

    next();
  };
}

/** Require the caller to be an admin (any sub-role). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user || user.role !== 'admin') {
    errors.forbidden(res, 'Admin access required');
    return;
  }
  next();
}

/** Require the caller to be a super_admin (checked against the DB sub-role). */
export function requireSuperAdmin() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || user.role !== 'admin') {
      errors.forbidden(res);
      return;
    }
    const record = await db.user.findUnique({ where: { id: user.sub as string }, select: { adminSubRole: true } });
    if (record?.adminSubRole !== 'super_admin') {
      errors.forbidden(res, 'Requires super_admin');
      return;
    }
    next();
  };
}

/** Require the admin user to have a specific permission. */
export function requireAdminPermission(
  permission: 'userManagement' | 'payouts' | 'disputes' | 'overrides',
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || user.role !== 'admin') {
      errors.forbidden(res);
      return;
    }

    const perms = await db.adminPermission.findUnique({
      where: { userId: user.sub! },
    });

    if (!perms || !perms[permission]) {
      fail(res, 403, 'FORBIDDEN', `Missing permission: ${permission}`);
      return;
    }

    next();
  };
}
