import type { ReceiptDesign, ReceiptSignature } from '@prisma/client';
import { z } from 'zod';
import { db } from '../config/db';

/**
 * Custom receipts. A space's reps can restyle the receipts its payers get:
 * colour, header, wording, a note, their own logo and a signature. Duevy's
 * name stays in the footer and the money section's layout never changes, so a
 * custom receipt still reads as a real Duevy receipt.
 *
 * Signatures are their own rows (up to MAX_SIGNATURES, side by side on the
 * receipt): added and removed one at a time, their images uploaded on their
 * own, and their names, roles and order saved with the rest of the design.
 */

export const MAX_SIGNATURES = 3;
/** The dashboard resizes before upload; this is a backstop. */
export const MAX_RECEIPT_IMAGE_BYTES = 512 * 1024;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);

export const STAMP_STYLES = ['round', 'rect', 'ribbon'] as const;
export type StampStyle = (typeof STAMP_STYLES)[number];

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour')
  .nullable()
  .optional()
  .transform((v) => v?.toLowerCase() ?? null);

export const receiptDesignSchema = z.object({
  accent: hexColor,
  headerStyle: z.enum(['artwork', 'solid']).default('artwork'),
  title: text(32),
  showStamp: z.boolean().default(true),
  stampText: text(10),
  stampStyle: z.enum(STAMP_STYLES).default('round'),
  /** null = the receipt colour. */
  stampColor: hexColor,
  thankYou: text(80),
  note: text(300),
  showAnswers: z.boolean().default(true),
  /** Existing signatures' names and roles, in the order to print them. */
  signatures: z
    .array(z.object({ id: z.string().min(1), name: text(60), role: text(60) }))
    .max(MAX_SIGNATURES)
    .optional(),
});

export type ReceiptDesignInput = z.output<typeof receiptDesignSchema>;

/** What the PDF renderer takes. Every field is resolved, so it never has to guess. */
export type ResolvedReceiptDesign = {
  accent: string | null;
  headerStyle: 'artwork' | 'solid';
  title: string;
  showStamp: boolean;
  stampText: string;
  stampStyle: StampStyle;
  stampColor: string | null;
  /** The space's own stamp; replaces the drawn one. */
  stampImage: Buffer | null;
  thankYou: string;
  note: string | null;
  showAnswers: boolean;
  logo: Buffer | null;
  signatures: { name: string | null; role: string | null; image: Buffer | null }[];
};

type DesignRow = ReceiptDesign & { signatures: ReceiptSignature[] };
const withSignatures = { signatures: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }] } };

/** A space's design with its signatures in print order. */
export function loadReceiptDesign(spaceId: string): Promise<DesignRow | null> {
  return db.receiptDesign.findUnique({ where: { spaceId }, include: withSignatures });
}

const stampStyleOf = (v: string | undefined): StampStyle =>
  STAMP_STYLES.includes(v as StampStyle) ? (v as StampStyle) : 'round';

export const DEFAULT_RECEIPT_TITLE = 'Payment receipt';
export const DEFAULT_STAMP_TEXT = 'PAID';
export const DEFAULT_THANK_YOU = 'Thank you for your payment.';

export function resolveReceiptDesign(row: DesignRow | null): ResolvedReceiptDesign {
  return {
    accent: row?.accent ?? null,
    headerStyle: row?.headerStyle === 'solid' ? 'solid' : 'artwork',
    title: row?.title ?? DEFAULT_RECEIPT_TITLE,
    showStamp: row?.showStamp ?? true,
    stampText: row?.stampText ?? DEFAULT_STAMP_TEXT,
    stampStyle: stampStyleOf(row?.stampStyle),
    stampColor: row?.stampColor ?? null,
    stampImage: row?.stampImage ? Buffer.from(row.stampImage) : null,
    thankYou: row?.thankYou ?? DEFAULT_THANK_YOU,
    note: row?.note ?? null,
    showAnswers: row?.showAnswers ?? true,
    logo: row?.logo ? Buffer.from(row.logo) : null,
    signatures: (row?.signatures ?? []).map((s) => ({
      name: s.name,
      role: s.role,
      image: s.image ? Buffer.from(s.image) : null,
    })),
  };
}

export async function getReceiptDesign(spaceId: string): Promise<ResolvedReceiptDesign> {
  return resolveReceiptDesign(await loadReceiptDesign(spaceId));
}

const dataUrl = (bytes: Uint8Array | null, mime: string | null) =>
  bytes && mime ? `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` : null;

/** The dashboard's view: the saved settings (null = default) and images as data URLs. */
export function serializeReceiptDesign(row: DesignRow | null) {
  return {
    accent: row?.accent ?? null,
    headerStyle: row?.headerStyle === 'solid' ? 'solid' : 'artwork',
    title: row?.title ?? null,
    showStamp: row?.showStamp ?? true,
    stampText: row?.stampText ?? null,
    stampStyle: stampStyleOf(row?.stampStyle),
    stampColor: row?.stampColor ?? null,
    stampImage: dataUrl(row?.stampImage ?? null, row?.stampMime ?? null),
    thankYou: row?.thankYou ?? null,
    note: row?.note ?? null,
    showAnswers: row?.showAnswers ?? true,
    logo: dataUrl(row?.logo ?? null, row?.logoMime ?? null),
    signatures: (row?.signatures ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      image: dataUrl(s.image, s.imageMime),
    })),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}
