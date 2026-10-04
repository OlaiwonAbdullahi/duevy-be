import { type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { MAX_DOCUMENT_BYTES, sniffDocumentType } from '../lib/storage';
import {
  resubmitStudentId,
  submitGovernmentId,
  submitKyc,
  submitPayoutDestination,
  type UploadedDocument,
} from '../services/kyc.service';
import { resolveBankDetails } from '../services/beneficiary.service';
import { maskAccountNumber } from '../lib/encryption';

/**
 * KYC request handlers, shared by `/me/kyc*` (rep applicants and reps, before
 * or after their space exists) and `/spaces/:spaceId/payout/kyc*`. KYC state
 * lives on the user, so both mounts act on the caller.
 *
 * multipart/form-data, submitted together:
 *   fields:  nin, dob (YYYY-MM-DD), gender, bvn? (only if Bachs asks),
 *            firstName?, lastName?, phone?
 *   files:   studentIdCard (required) — reviewed by a Duevy admin
 *            governmentId (optional)  — forwarded to Bachs if it asks for one
 *
 * The NIN, BVN and date of birth go to Bachs and are never stored or logged;
 * validation errors never echo them. Images/PDFs only, 5 MB each, checked by
 * their actual bytes rather than the client's Content-Type.
 */

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 2, fields: 10 },
});

function kycFiles(fields: { name: string; maxCount: number }[]): RequestHandler {
  const handler = kycUpload.fields(fields);
  return (req, res, next) => {
    handler(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          fail(res, 413, 'FILE_TOO_LARGE', 'Each document must be 5 MB or smaller');
          return;
        }
        errors.validation(res, [{ field: err.field ?? 'file', issue: err.message }]);
        return;
      }
      next(err);
    });
  };
}

/** Take one uploaded file and confirm it really is an image or PDF. */
function readDocument(req: Request, field: string): UploadedDocument | null | 'invalid' {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
  const file = files[field]?.[0];
  if (!file) return null;
  const type = sniffDocumentType(file.buffer);
  if (!type) return 'invalid';
  return { buffer: file.buffer, mimeType: type.mime, ext: type.ext };
}

const kycSchema = z
  .object({
    nin: z.string().regex(/^\d{11}$/, 'must be an 11-digit NIN'),
    bvn: z
      .string()
      .regex(/^\d{11}$/, 'must be an 11-digit BVN')
      .optional(),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine((s) => {
        const d = new Date(`${s}T00:00:00Z`);
        const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
        return !Number.isNaN(d.getTime()) && age >= 15 && age <= 100;
      }, 'must be a real date of birth'),
    gender: z.enum(['male', 'female']),
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
    phone: z
      .string()
      .regex(/^\+234\d{10}$/, 'must be +234 followed by 10 digits')
      .optional(),
  })
  .strict();

/** Multipart fields arrive as strings; drop empties so optional fields stay optional. */
function normaliseKycBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.dateOfBirth && !out.dob) out.dob = out.dateOfBirth;
  if (typeof out.gender === 'string') out.gender = out.gender.toLowerCase();
  delete out.dateOfBirth;
  return out;
}

/** POST …/kyc — NIN + date of birth to Bachs, student ID card for admin review. */
export const submitKycHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([
    { name: 'studentIdCard', maxCount: 1 },
    { name: 'governmentId', maxCount: 1 },
  ]),
  (req, _res, next) => {
    req.body = normaliseKycBody((req.body ?? {}) as Record<string, unknown>);
    next();
  },
  validate(kycSchema),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = readDocument(req, 'studentIdCard');
    const governmentId = readDocument(req, 'governmentId');
    if (!studentId) {
      errors.validation(res, [{ field: 'studentIdCard', issue: 'a photo or scan of your student ID card is required' }]);
      return;
    }
    if (studentId === 'invalid' || governmentId === 'invalid') {
      errors.validation(res, [
        { field: studentId === 'invalid' ? 'studentIdCard' : 'governmentId', issue: 'must be a JPEG, PNG, WebP or PDF file' },
      ]);
      return;
    }
    const state = await submitKyc(uid(req), {
      ...(req.body as z.infer<typeof kycSchema>),
      studentId,
      governmentId: governmentId ?? undefined,
    });
    // 202: submitted; the Bachs verdict arrives by webhook and an admin reviews the student ID.
    ok(res, state, 202);
  },
];

/** POST …/kyc/student-id — replace a rejected (or missing) student ID card. */
export const resubmitStudentIdHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([{ name: 'studentIdCard', maxCount: 1 }]),
  async (req: Request, res: Response): Promise<void> => {
    const doc = readDocument(req, 'studentIdCard');
    if (!doc || doc === 'invalid') {
      errors.validation(res, [{ field: 'studentIdCard', issue: 'a JPEG, PNG, WebP or PDF of your student ID card is required' }]);
      return;
    }
    ok(res, await resubmitStudentId(uid(req), doc), 202);
  },
];

/** POST …/kyc/government-id — send Bachs an ID document when it asks for one (see `requirementsDue`). */
export const governmentIdHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([{ name: 'governmentId', maxCount: 1 }]),
  async (req: Request, res: Response): Promise<void> => {
    const doc = readDocument(req, 'governmentId');
    if (!doc || doc === 'invalid') {
      errors.validation(res, [{ field: 'governmentId', issue: 'a JPEG, PNG, WebP or PDF of a government ID is required' }]);
      return;
    }
    ok(res, await submitGovernmentId(uid(req), doc), 202);
  },
];

const payoutDestinationSchema = z.object({
  bankCode: z.string().min(3).max(10),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});

/** POST …/kyc/payout-destination/lookup — name enquiry for that account, without sending it. */
export const payoutDestinationLookupHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(payoutDestinationSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber } = req.body as z.infer<typeof payoutDestinationSchema>;
    const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
    ok(res, { bankCode, bankName, accountNumber: maskAccountNumber(accountNumber), accountName });
  },
];

/**
 * POST …/kyc/payout-destination — the rep's own bank account, when Bachs asks
 * for one (`payout_destination` in `requirementsDue`) to finish onboarding.
 */
export const payoutDestinationHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(payoutDestinationSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber } = req.body as z.infer<typeof payoutDestinationSchema>;
    ok(res, await submitPayoutDestination(uid(req), bankCode, accountNumber));
  },
];
