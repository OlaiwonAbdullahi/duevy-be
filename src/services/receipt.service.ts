import { db } from '../config/db';
import { notFound } from '../lib/errors';
import { renderReceiptPdf } from '../lib/receipt';

/**
 * Receipts. One is issued (a Receipt row with a number) when a checkout is
 * paid; its content is always rendered from the checkout's own rows, so a
 * receipt can never disagree with what was recorded.
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
  });
  return { filename: `receipt-${r.number}.pdf`, pdf };
}

export async function renderCheckoutReceipt(checkoutId: string, userId: string) {
  return renderPdf(await loadOwnedReceipt({ checkoutId }, userId));
}

export async function renderReceiptByNumber(number: string, userId: string) {
  return renderPdf(await loadOwnedReceipt({ number }, userId));
}
