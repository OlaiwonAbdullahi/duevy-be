import { type Request, type Response, type NextFunction } from 'express';
import { env } from '../config/env';
import { errors } from '../lib/response';

export type FeatureFlag = 'polls' | 'assistant' | 'referrals';

const FLAG_ENV: Record<FeatureFlag, boolean> = {
  polls: env.FEATURE_POLLS,
  assistant: env.FEATURE_ASSISTANT,
  referrals: env.FEATURE_REFERRALS,
};

/** Gate a route behind a pilot feature flag — 404s as if the route doesn't exist. */
export function requireFeature(flag: FeatureFlag) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!FLAG_ENV[flag]) {
      errors.notFound(res);
      return;
    }
    next();
  };
}
