import { db } from '../config/db';
import { env } from '../config/env';
import { notFound } from '../lib/errors';
import { renderReceiptPdf } from '../lib/receipt';
import { readGuestAnswers } from '../lib/guestForm';
import { getReceiptDesign } from './receiptDesign.service';

/**
 * Receipts. One is issued (a Receipt row with a number) when a checkout is
 * paid; its content is always rendered from the checkout's own rows, so a
 * receipt can never disagree with what was recorded. Its look comes from the
 * space's receipt design as it is at render time.
 */

async function loadOwnedReceipt(where: { checkoutId: string } | { number: string }, userId: string) {
  const receipt = await db.receipt.findUnique({
    where,
    include: {
      checkout: { include: { items: { include: { due: { select: { title: true } } } } } },
      space: { select: { name: true } },
      user: { select: { name: true } },
    },
  });
  if (!receipt || receipt.userId !== userId) throw notFound('Receipt not found');
  return receipt;
}

type LoadedReceipt = Awaited<ReturnType<typeof loadOwnedReceipt>>;

export function serializeReceipt(r: LoadedReceipt) {
  const c = r.checkout;
  return {
    number: r.number,
    reference: c.reference,
    issuedAt: r.issuedAt.toISOString(),
    paidAt: c.paidAt?.toISOString() ?? null,
    space: { id: r.spaceId, name: r.space.name },
    payer: r.user.name,
    method: 'Bank transfer',
    items: c.items.map((i) => ({ dueId: i.dueId, title: i.due.title, amount: i.faceKobo })),
    face: c.faceKobo,
    fee: c.feeKobo,
    total: c.totalKobo,
    received: c.receivedKobo,
  };
}

export async function getReceiptByNumber(number: string, userId: string) {
  return serializeReceipt(await loadOwnedReceipt({ number }, userId));
}

export async function listReceipts(userId: string, skip: number, take: number) {
  const [total, rows] = await Promise.all([
    db.receipt.count({ where: { userId } }),
    db.receipt.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      skip,
      take,
      include: {
        checkout: { include: { items: { include: { due: { select: { title: true } } } } } },
        space: { select: { name: true } },
        user: { select: { name: true } },
      },
    }),
  ]);
  return { total, rows: rows.map(serializeReceipt) };
}

async function renderPdf(r: LoadedReceipt) {
  const c = r.checkout;
  const pdf = await renderReceiptPdf({
    receiptNumber: r.number,
    reference: c.reference,
    title: c.items.length === 1 ? c.items[0]!.due.title : `${c.items.length} dues`,
    lines: c.items.map((i) => ({ title: i.due.title, amountKobo: i.faceKobo })),
    spaceName: r.space.name,
    payerName: r.user.name,
    amountPaid: c.totalKobo,
    processingFee: 0,
    duevyFee: c.feeKobo,
    netToSpace: c.faceKobo,
    paidAt: c.paidAt ?? r.issuedAt,
    method: 'Bank transfer',
    design: await getReceiptDesign(r.spaceId),
    answers: readGuestAnswers(c.guestAnswers),
    verifyUrl: receiptVerifyUrl(r.number),
  });
  return { filename: `receipt-${r.number}.pdf`, pdf };
}

/**
 * The receipt for one due of a checkout. A checkout that paid several dues
 * has one receipt; this renders just this due's line and its share of the
 * fee, numbered `<receipt>-<n>` (n = the line's position) so it traces back to
 * the full one. A single-due checkout renders exactly like its full receipt.
 */
export async function renderDueReceipt(checkoutId: string, dueId: string, userId: string) {
  const r = await loadOwnedReceipt({ checkoutId }, userId);
  const c = r.checkout;
  if (c.items.length <= 1) return renderPdf(r);
  const items = [...c.items].sort((a, b) => a.id.localeCompare(b.id));
  const index = items.findIndex((i) => i.dueId === dueId);
  if (index < 0) throw notFound('Receipt not found');
  const item = items[index]!;
  const number = `${r.number}-${index + 1}`;
  const pdf = await renderReceiptPdf({
    receiptNumber: number,
    reference: c.reference,
    title: item.due.title,
    lines: [{ title: item.due.title, amountKobo: item.faceKobo }],
    spaceName: r.space.name,
    payerName: r.user.name,
    amountPaid: item.faceKobo + item.feeKobo,
    processingFee: 0,
    duevyFee: item.feeKobo,
    netToSpace: item.faceKobo,
    paidAt: c.paidAt ?? r.issuedAt,
    method: 'Bank transfer',
    design: await getReceiptDesign(r.spaceId),
    answers: readGuestAnswers(c.guestAnswers),
    verifyUrl: receiptVerifyUrl(number),
  });
  return { filename: `receipt-${number}.pdf`, pdf };
}

export async function renderCheckoutReceipt(checkoutId: string, userId: string) {
  return renderPdf(await loadOwnedReceipt({ checkoutId }, userId));
}

export async function renderReceiptByNumber(number: string, userId: string) {
  return renderPdf(await loadOwnedReceipt({ number }, userId));
}

// ---------------------------------------------------------------------------
// Public: verify a receipt, and a payer's own receipts by email
// ---------------------------------------------------------------------------

/** The public page a receipt's QR code opens. */
export function receiptVerifyUrl(number: string): string {
  return `${env.FRONTEND_URL}/verify/${encodeURIComponent(number)}`;
}

/** `RCT-2026-AB12CD34`, optionally `-<n>` for one due of a multi-due receipt. */
const RECEIPT_NUMBER = /^(RCT-\d{4}-[A-Z0-9]{4,16})(?:-(\d{1,3}))?$/;

/** "Abdullahi Olaiwon" → "Abdullahi O." — enough for a rep to match the payer, not a full name for anyone who scans. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/**
 * What a scanned receipt shows. Read straight from the issued Receipt and its
 * checkout, so a doctored PDF can't change it: if the amounts or names on the
 * paper differ from this, the paper is wrong. `null` = no such receipt.
 */
export async function verifyReceipt(rawNumber: string) {
  const match = RECEIPT_NUMBER.exec(rawNumber.trim().toUpperCase());
  if (!match) return null;
  const [, base, part] = match;
  const r = await db.receipt.findUnique({
    where: { number: base! },
    include: {
      checkout: { include: { items: { include: { due: { select: { title: true } } } } } },
      space: { select: { name: true, short: true } },
      user: { select: { name: true } },
    },
  });
  if (!r || r.checkout.status !== 'paid') return null;
  const c = r.checkout;
  let items = c.items;
  let total = c.totalKobo;
  if (part) {
    // Same ordering renderDueReceipt numbers the lines by.
    const sorted = [...c.items].sort((a, b) => a.id.localeCompare(b.id));
    const item = sorted[Number(part) - 1];
    if (!item || c.items.length <= 1) return null;
    items = [item];
    total = item.faceKobo + item.feeKobo;
  }
  return {
    valid: true as const,
    number: part ? `${base}-${part}` : base!,
    reference: c.reference,
    paidAt: (c.paidAt ?? r.issuedAt).toISOString(),
    space: { name: r.space.name, short: r.space.short },
    payer: maskName(r.user.name),
    items: items.map((i) => ({ title: i.due.title, amount: i.faceKobo })),
    total,
  };
}

const ownerReceiptInclude = {
  checkout: { include: { items: { include: { due: { select: { title: true } } } } } },
  space: { select: { name: true } },
  user: { select: { name: true } },
} as const;

/** Every receipt issued to this email (guest or full account), newest first. */
export async function listReceiptsForEmail(email: string) {
  const rows = await db.receipt.findMany({
    where: { user: { email: { equals: email.trim(), mode: 'insensitive' } } },
    orderBy: { issuedAt: 'desc' },
    take: 100,
    include: ownerReceiptInclude,
  });
  return rows.map(serializeReceipt);
}

/** True when this email has at least one receipt — decides whether a lookup email is worth sending. */
export async function emailHasReceipts(email: string): Promise<boolean> {
  return (await db.receipt.count({ where: { user: { email: { equals: email.trim(), mode: 'insensitive' } } } })) > 0;
}

/** A receipt's PDF, only if it was issued to this email. */
export async function renderReceiptForEmail(number: string, email: string) {
  const r = await db.receipt.findUnique({ where: { number }, select: { userId: true, user: { select: { email: true } } } });
  if (!r || r.user.email.toLowerCase() !== email.toLowerCase()) throw notFound('Receipt not found');
  return renderReceiptByNumber(number, r.userId);
}
