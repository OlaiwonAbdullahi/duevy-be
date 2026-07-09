import { type Request, type Response, type NextFunction } from 'express';
import { errors } from '../lib/response';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt';
import { JWTExpired } from 'jose/errors';

export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

/** Require a valid Bearer access token on the request. */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    errors.unauthorized(res);
    return;
  }

  const token = header.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    (req as AuthenticatedRequest).user = payload;
    next();
  } catch (err) {
    if (err instanceof JWTExpired) {
      errors.tokenExpired(res);
    } else {
      errors.unauthorized(res, 'Invalid access token');
    }
  }
}

/** Attach the user if a valid Bearer token is present, but never reject.
 *  Used by endpoints that are public yet behave differently when signed in
 *  (e.g. the poll share link, §11.5). */
export async function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      (req as AuthenticatedRequest).user = await verifyAccessToken(header.slice(7));
    } catch {
      // Ignore bad/expired tokens — treat the caller as anonymous.
    }
  }
  next();
}
