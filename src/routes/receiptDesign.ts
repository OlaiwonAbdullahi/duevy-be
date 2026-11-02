import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { type AuthenticatedRequest } from '../middleware/auth';
import { requireSpaceRep } from '../middleware/requireRole';
import { ok, fail, errors } from '../lib/response';
import { writeAudit } from '../lib/audit';
import { sniffDocumentType } from '../lib/storage';
import { renderReceiptPdf } from '../lib/receipt';
import {
  MAX_RECEIPT_IMAGE_BYTES,
  MAX_SIGNATURES,
  getReceiptDesign,
  loadReceiptDesign,
  receiptDesignSchema,
  serializeReceiptDesign,
  type ReceiptDesignInput,
} from '../services/receiptDesign.service';

/**
 * A space's receipt design (see services/receiptDesign.service.ts). Any rep
 * can look at it; the lead rep changes it, as with the space's theme.
 *
 * Mounted at /spaces/:spaceId.
 */
export const receiptDesignRouter = Router({ mergeParams: true });
receiptDesignRouter.use('/receipt-design', requireSpaceRep());

function spaceId(req: Request): string {
  return req.params.spaceId as string;
}

async function audit(req: Request, description: string) {
  const id = (req as AuthenticatedRequest).user.sub as string;
  const u = await db.user.findUnique({ where: { id }, select: { name: true } });
  await writeAudit(
    spaceId(req),
    { id, name: u?.name ?? 'Rep', role: (req as AuthenticatedRequest).spaceRep?.role ?? null },
    'profile_updated',
    description,
  );
}

// ---------------------------------------------------------------------------
// GET /receipt-design · PUT /receipt-design — the settings
// ---------------------------------------------------------------------------
async function respond(res: Response, sid: string) {
  ok(res, serializeReceiptDesign(await loadReceiptDesign(sid)));
}

receiptDesignRouter.get('/receipt-design', async (req: Request, res: Response): Promise<void> => {
  await respond(res, spaceId(req));
});

receiptDesignRouter.put(
  '/receipt-design',
  requireSpaceRep(true),
  validate(receiptDesignSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { signatures, ...data } = req.body as ReceiptDesignInput;
    await db.$transaction(async (tx) => {
      await tx.receiptDesign.upsert({ where: { spaceId: sid }, create: { spaceId: sid, ...data }, update: data });
      // Names, roles and order for signatures that exist; unknown ids are ignored.
      for (const [position, sig] of (signatures ?? []).entries()) {
        await tx.receiptSignature.updateMany({
          where: { id: sig.id, spaceId: sid },
          data: { name: sig.name, role: sig.role, position },
        });
      }
    });
    await audit(req, 'Updated the receipt design');
    await respond(res, sid);
  },
);

// ---------------------------------------------------------------------------
// Images (multipart `file`, PNG or JPEG):
// POST · DELETE /receipt-design/logo · /receipt-design/stamp
// POST · DELETE /receipt-design/signatures/{id}/image
// ---------------------------------------------------------------------------
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_IMAGE_BYTES, files: 1, fields: 0 },
}).single('file');

const uploadImage: RequestHandler = (req, res, next) => {
  imageUpload(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        fail(res, 413, 'FILE_TOO_LARGE', 'The image must be 512 KB or smaller');
        return;
      }
      errors.validation(res, [{ field: err.field ?? 'file', issue: err.message }]);
      return;
    }
    next(err);
  });
};

/** The uploaded image's bytes and real type, or null once a response is sent. */
function readImage(req: Request, res: Response): { bytes: Buffer; mime: string } | null {
  const file = req.file;
  if (!file) {
    errors.validation(res, [{ field: 'file', issue: 'an image is required' }]);
    return null;
  }
  // PDFKit draws PNG and JPEG only — and never trust the client's Content-Type.
  const type = sniffDocumentType(file.buffer);
  if (!type || (type.mime !== 'image/png' && type.mime !== 'image/jpeg')) {
    fail(res, 415, 'UNSUPPORTED_FILE_TYPE', 'Upload a PNG or JPEG image');
    return null;
  }
  return { bytes: file.buffer, mime: type.mime };
}

// The design's own images, by URL segment: the logo and the space's stamp.
const DESIGN_IMAGES = {
  logo: { bytes: 'logo', mime: 'logoMime', label: 'logo' },
  stamp: { bytes: 'stampImage', mime: 'stampMime', label: 'stamp' },
} as const;

for (const [segment, col] of Object.entries(DESIGN_IMAGES)) {
  receiptDesignRouter.post(
    `/receipt-design/${segment}`,
    requireSpaceRep(true),
    uploadImage,
    async (req: Request, res: Response): Promise<void> => {
      const image = readImage(req, res);
      if (!image) return;
      const sid = spaceId(req);
      const data = { [col.bytes]: image.bytes, [col.mime]: image.mime };
      await db.receiptDesign.upsert({ where: { spaceId: sid }, create: { spaceId: sid, ...data }, update: data });
      await audit(req, `Updated the receipt ${col.label}`);
      await respond(res, sid);
    },
  );

  receiptDesignRouter.delete(
    `/receipt-design/${segment}`,
    requireSpaceRep(true),
    async (req: Request, res: Response): Promise<void> => {
      const sid = spaceId(req);
      const { count } = await db.receiptDesign.updateMany({ where: { spaceId: sid }, data: { [col.bytes]: null, [col.mime]: null } });
      if (count) await audit(req, `Removed the receipt ${col.label}`);
      await respond(res, sid);
    },
  );
}

// ---------------------------------------------------------------------------
// POST /receipt-design/signatures — add a signatory (blank, then fill it in)
// DELETE /receipt-design/signatures/{id}
// ---------------------------------------------------------------------------
receiptDesignRouter.post(
  '/receipt-design/signatures',
  requireSpaceRep(true),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const added = await db.$transaction(async (tx) => {
      await tx.receiptDesign.upsert({ where: { spaceId: sid }, create: { spaceId: sid }, update: {} });
      const existing = await tx.receiptSignature.findMany({ where: { spaceId: sid }, select: { position: true } });
      if (existing.length >= MAX_SIGNATURES) return false;
      await tx.receiptSignature.create({
        data: { spaceId: sid, position: Math.max(-1, ...existing.map((s) => s.position)) + 1 },
      });
      return true;
    });
    if (!added) {
      errors.conflict(res, 'SIGNATURE_LIMIT', `A receipt can have up to ${MAX_SIGNATURES} signatures`);
      return;
    }
    await audit(req, 'Added a receipt signature');
    await respond(res, sid);
  },
);

receiptDesignRouter.delete(
  '/receipt-design/signatures/:signatureId',
  requireSpaceRep(true),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { count } = await db.receiptSignature.deleteMany({ where: { id: req.params.signatureId as string, spaceId: sid } });
    if (!count) {
      errors.notFound(res, 'Signature not found');
      return;
    }
    await audit(req, 'Removed a receipt signature');
    await respond(res, sid);
  },
);

receiptDesignRouter.post(
  '/receipt-design/signatures/:signatureId/image',
  requireSpaceRep(true),
  uploadImage,
  async (req: Request, res: Response): Promise<void> => {
    const image = readImage(req, res);
    if (!image) return;
    const sid = spaceId(req);
    const { count } = await db.receiptSignature.updateMany({
      where: { id: req.params.signatureId as string, spaceId: sid },
      data: { image: image.bytes, imageMime: image.mime },
    });
    if (!count) {
      errors.notFound(res, 'Signature not found');
      return;
    }
    await audit(req, 'Updated a receipt signature');
    await respond(res, sid);
  },
);

receiptDesignRouter.delete(
  '/receipt-design/signatures/:signatureId/image',
  requireSpaceRep(true),
  async (req: Request, res: Response): Promise<void> => {
    const sid = spaceId(req);
    const { count } = await db.receiptSignature.updateMany({
      where: { id: req.params.signatureId as string, spaceId: sid },
      data: { image: null, imageMime: null },
    });
    if (!count) {
      errors.notFound(res, 'Signature not found');
      return;
    }
    await respond(res, sid);
  },
);

// ---------------------------------------------------------------------------
// GET /receipt-design/sample — the saved design on a made-up payment
// ---------------------------------------------------------------------------
receiptDesignRouter.get('/receipt-design/sample', async (req: Request, res: Response): Promise<void> => {
  const sid = spaceId(req);
  const space = await db.space.findUnique({ where: { id: sid }, select: { name: true } });
  const pdf = await renderReceiptPdf({
    receiptNumber: 'R-SAMPLE',
    reference: 'DVY-SAMPLE-0001',
    title: 'Departmental due',
    lines: [{ title: 'Departmental due', amountKobo: 500_000 }],
    spaceName: space?.name ?? 'Your department',
    payerName: 'Tolu Adeyemi',
    amountPaid: 512_000,
    processingFee: 0,
    duevyFee: 12_000,
    netToSpace: 500_000,
    paidAt: new Date(),
    method: 'Bank transfer',
    design: await getReceiptDesign(sid),
    answers: [{ label: 'Phone number', value: '08031420517' }],
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="receipt-sample.pdf"');
  res.status(200).send(pdf);
});
