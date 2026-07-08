import { type Request, type Response, type NextFunction } from 'express';
import { type ZodSchema, ZodError } from 'zod';
import { errors } from '../lib/response';

type ValidateTarget = 'body' | 'query' | 'params';

/** Validate a request part against a Zod schema.
 *  On success, replaces the original value with the parsed (coerced) one.
 *  On failure, returns a 400 VALIDATION_ERROR envelope.
 */
export function validate(schema: ZodSchema, target: ValidateTarget = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const details = (result.error as ZodError).errors.map((e) => ({
        field: e.path.join('.'),
        issue: e.message,
      }));
      errors.validation(res, details);
      return;
    }
    // Replace with parsed/coerced value
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
}
