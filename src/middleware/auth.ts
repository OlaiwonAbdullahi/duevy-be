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
