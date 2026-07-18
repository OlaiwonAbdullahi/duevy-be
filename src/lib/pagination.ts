import { type Request } from 'express';
import { z } from 'zod';
import { type Meta, RequestValidationError } from './response';

/** Query params common to all list endpoints (§1.7). */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  q: z.string().trim().optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface PageParams {
  page: number;
  perPage: number;
  skip: number;
  take: number;
  q?: string;
  sort?: string;
}

/** Parse pagination/search params off a request query, applying spec defaults.
 *  Throws RequestValidationError (rendered as a 400 by errorHandler.ts) on
 *  invalid input, rather than letting a raw ZodError fall through as a 500. */
export function parseListQuery(req: Request): PageParams {
  const result = listQuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
    );
  }
  const { page, perPage, sort, q } = result.data;
  return { page, perPage, skip: (page - 1) * perPage, take: perPage, sort, q };
}

/**
 * Translate a `-field` / `field` sort string into a Prisma orderBy object.
 * Only whitelisted fields are honoured; anything else falls back to `fallback`.
 */
export function parseSort<T extends string>(
  sort: string | undefined,
  allowed: readonly T[],
  fallback: Record<string, 'asc' | 'desc'>,
): Record<string, 'asc' | 'desc'> {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const field = (desc ? sort.slice(1) : sort) as T;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? 'desc' : 'asc' };
}

/** Build the pagination meta block from the total count. */
export function buildMeta(page: number, perPage: number, total: number): Meta {
  return { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}
