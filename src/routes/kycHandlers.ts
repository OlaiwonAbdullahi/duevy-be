import { type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { MAX_DOCUMENT_BYTES, sniffDocumentType } from '../lib/storage';
import {
  resubmitStudentId,
  sendPhoneCode,
  submitKyc,
  submitPayoutDestination,
  verifyPhoneCode,
  type UploadedDocument,
} from '../services/kyc.service';
import { resolveBankDetails } from '../services/beneficiary.service';
import { maskAccountNumber } from '../lib/encryption';

/**
 * KYC request handlers, shared by `/me/kyc*` (rep applicants and reps, before
 * or after their space exists) and `/spaces/:spaceId/payout/kyc*`. KYC state
 * lives on the user, so both mounts act on the caller.
 *
 * The flow, in order (each step requires the one before):
 *   POST …/kyc/phone/send    { phone }      — Didit texts a one-time code
 *   POST …/kyc/phone/verify  { code }       — the number becomes the rep's verified phone
 *   POST …/kyc               multipart/form-data:
 *     fields:  bvn, dob (YYYY-MM-DD), gender, address, consent=true,
 *              firstName?, lastName? (the names on the BVN, if not the profile's)
 *     files:   studentIdCard (required) — reviewed by a Duevy admin
 *   Didit matches the BVN to the name and date of birth; only then is the rep
 *   registered with Kredi.
 *
 * The BVN, date of birth and code are never stored or logged; validation
 * errors never echo them. Images/PDFs only, 5 MB, checked by their actual
 * bytes rather than the client's Content-Type.
 */

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 10 },
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
    bvn: z.string().regex(/^\d{11}$/, 'must be an 11-digit BVN'),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine((s) => {
        const d = new Date(`${s}T00:00:00Z`);
        const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
        return !Number.isNaN(d.getTime()) && age >= 15 && age <= 100;
      }, 'must be a real date of birth'),
    gender: z.enum(['male', 'female']),
    address: z.string().trim().min(5, 'enter your residential address').max(200),
    consent: z.literal(true, { errorMap: () => ({ message: 'you must agree to the BVN check' }) }),
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
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
  if (out.consent === 'true') out.consent = true;
  delete out.dateOfBirth;
  return out;
}

const sendCodeSchema = z.object({ phone: z.string().trim().min(10).max(16) }).strict();
const verifyCodeSchema = z.object({ code: z.string().regex(/^\d{4,8}$/, 'must be the digits from the text message') }).strict();

/** POST …/kyc/phone/send — text a one-time code to the rep's mobile number. */
export const sendPhoneCodeHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(sendCodeSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { phone } = req.body as z.infer<typeof sendCodeSchema>;
    ok(res, await sendPhoneCode(uid(req), phone, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined }));
  },
];

/** POST …/kyc/phone/verify — the code from the text message. */
export const verifyPhoneCodeHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(verifyCodeSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { code } = req.body as z.infer<typeof verifyCodeSchema>;
    ok(res, await verifyPhoneCode(uid(req), code));
  },
];

/** POST …/kyc — BVN (checked by Didit, then registered at Kredi) and the student ID card for admin review. */
export const submitKycHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([{ name: 'studentIdCard', maxCount: 1 }]),
  (req, _res, next) => {
    req.body = normaliseKycBody((req.body ?? {}) as Record<string, unknown>);
    next();
  },
  validate(kycSchema),
  async (req: Request, res: Response): Promise<void> => {
    const studentId = readDocument(req, 'studentIdCard');
    if (!studentId) {
      errors.validation(res, [{ field: 'studentIdCard', issue: 'a photo or scan of your student ID card is required' }]);
      return;
    }
    if (studentId === 'invalid') {
      errors.validation(res, [{ field: 'studentIdCard', issue: 'must be a JPEG, PNG, WebP or PDF file' }]);
      return;
    }
    const state = await submitKyc(uid(req), { ...(req.body as z.infer<typeof kycSchema>), studentId });
    // 202: identity is verified; an admin still reviews the student ID and the application.
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

const payoutDestinationSchema = z.object({
  bankCode: z.string().min(3).max(10),
  accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit NUBAN'),
});

/** POST …/kyc/payout-destination/lookup — name enquiry for that account, without sending it. */
export const payoutDestinationLookupHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(payoutDestinationSchema),
  async (req: Request, res: Response): Promise<void> => {
    // Name enquiry reveals an account holder's name, so only reps and rep
    // applicants (who need it for their own payout destination) may use it.
    const user = await db.user.findUnique({ where: { id: uid(req) }, select: { isRep: true, repApplicationStatus: true } });
    if (!user || !(user.isRep || user.repApplicationStatus === 'pending' || user.repApplicationStatus === 'approved')) {
      errors.forbidden(res, 'Bank name enquiry is available to reps only');
      return;
    }
    const { bankCode, accountNumber } = req.body as z.infer<typeof payoutDestinationSchema>;
    const { bankName, accountName } = await resolveBankDetails(bankCode, accountNumber);
    ok(res, { bankCode, bankName, accountNumber: maskAccountNumber(accountNumber), accountName });
  },
];

/** POST …/kyc/payout-destination — save the rep's own bank account (name-checked). */
export const payoutDestinationHandlers: RequestHandler[] = [
  sensitiveLimiter,
  validate(payoutDestinationSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { bankCode, accountNumber } = req.body as z.infer<typeof payoutDestinationSchema>;
    ok(res, await submitPayoutDestination(uid(req), bankCode, accountNumber));
  },
];
