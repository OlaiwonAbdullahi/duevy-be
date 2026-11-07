import { type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { ok, fail, errors } from '../lib/response';
import { MAX_DOCUMENT_BYTES, MAX_LIVENESS_BYTES, sniffDocumentType, sniffLivenessType } from '../lib/storage';
import { resubmitStudentId, submitKyc, submitLiveness, type UploadedDocument } from '../services/kyc.service';

/**
 * KYC request handlers, shared by `/me/kyc*` (rep applicants and reps, before
 * or after their space exists) and `/spaces/:spaceId/payout/kyc*`. KYC state
 * lives on the user, so both mounts act on the caller.
 *
 * multipart/form-data, submitted together:
 *   files:   studentIdCard (required, image/PDF ≤ 5 MB) — reviewed by an admin
 *            liveness (photo or short video of the rep's face ≤ 15 MB) —
 *            required while the KYC policy requires liveness; admin-reviewed
 *   fields:  nin, dob (YYYY-MM-DD) — required while the policy requires NIN,
 *            optional and ignored otherwise
 * The current requirements are in GET /me/kyc-status (`requirements`).
 * Other fields older clients still send (gender, bvn, names, phone) are ignored.
 *
 * The NIN and date of birth go to the identity check and are never stored or
 * logged; validation errors never echo them. Every file is checked by its
 * actual bytes rather than the client's Content-Type.
 */

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// The per-file cap is the largest file allowed (a liveness video); the
// student ID's tighter 5 MB is checked per field below.
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LIVENESS_BYTES, files: 3, fields: 10 },
});

function kycFiles(fields: { name: string; maxCount: number }[]): RequestHandler {
  const handler = kycUpload.fields(fields);
  return (req, res, next) => {
    handler(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          fail(res, 413, 'FILE_TOO_LARGE', 'Files must be 5 MB or smaller (15 MB for a face video)');
          return;
        }
        errors.validation(res, [{ field: err.field ?? 'file', issue: err.message }]);
        return;
      }
      next(err);
    });
  };
}

function uploaded(req: Request, field: string): Express.Multer.File | undefined {
  return ((req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>)[field]?.[0];
}

/** Take one uploaded file and confirm it really is an image or PDF, 5 MB at most. */
function readDocument(req: Request, field: string): UploadedDocument | null | 'invalid' | 'too_large' {
  const file = uploaded(req, field);
  if (!file) return null;
  if (file.size > MAX_DOCUMENT_BYTES) return 'too_large';
  const type = sniffDocumentType(file.buffer);
  if (!type) return 'invalid';
  return { buffer: file.buffer, mimeType: type.mime, ext: type.ext };
}

/** The face capture: a JPEG/PNG/WebP photo or an MP4/MOV/WebM video, by its bytes. */
function readLiveness(req: Request): UploadedDocument | null | 'invalid' {
  const file = uploaded(req, 'liveness');
  if (!file) return null;
  const type = sniffLivenessType(file.buffer);
  if (!type) return 'invalid';
  return { buffer: file.buffer, mimeType: type.mime, ext: type.ext };
}

const LIVENESS_TYPES = 'a JPEG, PNG or WebP photo, or an MP4, MOV or WebM video';

// Not strict: unknown fields from older clients are stripped, not refused.
const kycSchema = z.object({
    // Optional here: whether they're required depends on the KYC policy,
    // which the service applies. When sent, they must still be well formed.
    nin: z.string().regex(/^\d{11}$/, 'must be an 11-digit NIN').optional(),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine((s) => {
        const d = new Date(`${s}T00:00:00Z`);
        const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
        return !Number.isNaN(d.getTime()) && age >= 15 && age <= 100;
      }, 'must be a real date of birth')
      .optional(),
});

/** Multipart fields arrive as strings; drop empties so optional fields stay optional. */
function normaliseKycBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.dateOfBirth && !out.dob) out.dob = out.dateOfBirth;
  delete out.dateOfBirth;
  return out;
}

/** POST …/kyc — student ID card and face capture for admin review; NIN + date of birth while the policy requires them. */
export const submitKycHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([
    { name: 'studentIdCard', maxCount: 1 },
    { name: 'liveness', maxCount: 1 },
    // Ignored; accepted so older clients that still attach it aren't refused.
    { name: 'governmentId', maxCount: 1 },
  ]),
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
    if (studentId === 'too_large') {
      fail(res, 413, 'FILE_TOO_LARGE', 'The student ID must be 5 MB or smaller');
      return;
    }
    const liveness = readLiveness(req);
    if (liveness === 'invalid') {
      errors.validation(res, [{ field: 'liveness', issue: `must be ${LIVENESS_TYPES}` }]);
      return;
    }
    const { nin, dob } = req.body as z.infer<typeof kycSchema>;
    const state = await submitKyc(uid(req), { nin, dob, studentId, liveness: liveness ?? undefined });
    // 202: any NIN check is done; an admin still reviews the student ID and face capture.
    ok(res, state, 202);
  },
];

/** POST …/kyc/student-id — replace a rejected (or missing) student ID card. */
export const resubmitStudentIdHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([{ name: 'studentIdCard', maxCount: 1 }]),
  async (req: Request, res: Response): Promise<void> => {
    const doc = readDocument(req, 'studentIdCard');
    if (doc === 'too_large') {
      fail(res, 413, 'FILE_TOO_LARGE', 'The student ID must be 5 MB or smaller');
      return;
    }
    if (!doc || doc === 'invalid') {
      errors.validation(res, [{ field: 'studentIdCard', issue: 'a JPEG, PNG, WebP or PDF of your student ID card is required' }]);
      return;
    }
    ok(res, await resubmitStudentId(uid(req), doc), 202);
  },
];

/** POST …/kyc/liveness — a new face capture (first one, or a retake after a rejection). */
export const submitLivenessHandlers: RequestHandler[] = [
  sensitiveLimiter,
  kycFiles([{ name: 'liveness', maxCount: 1 }]),
  async (req: Request, res: Response): Promise<void> => {
    const doc = readLiveness(req);
    if (!doc || doc === 'invalid') {
      errors.validation(res, [{ field: 'liveness', issue: `${LIVENESS_TYPES} of your face is required` }]);
      return;
    }
    ok(res, await submitLiveness(uid(req), doc), 202);
  },
];
