import path from 'path';
import PDFDocument from 'pdfkit';
import { formatNaira } from './money';

interface ReceiptData {
  /** Human receipt number (e.g. "R-000123") when one was issued. */
  receiptNumber?: string;
  reference: string;
  title: string;
  spaceName: string;
  payerName: string;
  amountPaid: number;
  processingFee: number;
  duevyFee: number;
  netToSpace: number;
  paidAt: Date;
  method: string;
  /**
   * Every due this payment settled. One checkout can cover several (PRD §5.2),
   * and §5.3 requires the receipt to itemise them. A single-due payment passes
   * one line, or none — the summary above is then enough on its own.
   */
  lines?: { title: string; amountKobo: number }[];
}

// The standard PDF fonts have no ₦ glyph, so embed Inter (OFL). Resolved from
// the project root so it works from both src/ (tsx) and dist/ (node).
const FONT_DIR = path.join(__dirname, '../../assets/fonts');
const FONT = {
  regular: path.join(FONT_DIR, 'Inter-Regular.ttf'),
  semibold: path.join(FONT_DIR, 'Inter-SemiBold.ttf'),
  bold: path.join(FONT_DIR, 'Inter-Bold.ttf'),
};

const COLOR = {
  ink: '#1b2520',
  muted: '#7a847f',
  faint: '#a3aca7',
  line: '#e8ece9',
  brand: '#0b6e4f',
  brandSoft: '#f1f7f4',
  onBrand: '#ffffff',
  onBrandMuted: '#cfe6dc',
};

/** "9 Oct 2026, 3:32 pm" in Lagos time — receipts are read by people, not parsers. */
function formatPaidAt(date: Date) {
  return new Intl.DateTimeFormat('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos',
  }).format(date);
}

/**
 * Render a payment receipt as a PDF buffer (§6.5/§9.3 — `application/pdf`).
 * Mirrors the client's receipt layout so the numbers always match the ledger.
 */
export function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: `Duevy receipt ${d.reference}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('regular', FONT.regular);
    doc.registerFont('semibold', FONT.semibold);
    doc.registerFont('bold', FONT.bold);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const pad = 36;
    const contentW = pageW - pad * 2;

    // ── Header band: brand, receipt label and the amount that matters ──────
    const headerH = 156;
    doc.rect(0, 0, pageW, headerH).fill(COLOR.brand);

    doc.font('bold').fontSize(18).fillColor(COLOR.onBrand).text('Duevy.', pad, 28, { lineBreak: false });
    doc
      .font('semibold')
      .fontSize(8)
      .fillColor(COLOR.onBrandMuted)
      .text('PAYMENT RECEIPT', pad, 35, { width: contentW, align: 'right', characterSpacing: 1.2 });

    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text('Total paid', pad, 70);
    doc.font('bold').fontSize(28).fillColor(COLOR.onBrand).text(formatNaira(d.amountPaid), pad, 83, { width: contentW });

    // Status pill, with the payment time beside it.
    const pill = 'Paid';
    doc.font('semibold').fontSize(8);
    const pillW = doc.widthOfString(pill) + 18;
    const pillY = 122;
    doc.roundedRect(pad, pillY, pillW, 18, 9).fill(COLOR.onBrand);
    doc.fillColor(COLOR.brand).text(pill, pad, pillY + 4.5, { width: pillW, align: 'center' });
    doc
      .font('regular')
      .fontSize(9)
      .fillColor(COLOR.onBrandMuted)
      .text(formatPaidAt(d.paidAt), pad + pillW + 10, pillY + 4, { width: contentW - pillW - 10 });

    // ── What was paid for ──────────────────────────────────────────────────
    let y = headerH + 20;
    doc.font('bold').fontSize(13).fillColor(COLOR.ink).text(d.title, pad, y, { width: contentW });
    y = doc.y + 2;
    if (d.spaceName) {
      doc.font('regular').fontSize(9.5).fillColor(COLOR.muted).text(d.spaceName, pad, y, { width: contentW });
      y = doc.y;
    }
    y += 12;

    /** A label/value pair with an optional hairline under it. Values wrap on the right. */
    const row = (label: string, value: string, opts: { divider?: boolean; x?: number; w?: number } = {}) => {
      const x = opts.x ?? pad;
      const w = opts.w ?? contentW;
      const labelW = w * 0.38;
      doc.font('regular').fontSize(9.5).fillColor(COLOR.muted).text(label, x, y, { width: labelW });
      const labelBottom = doc.y;
      doc
        .font('semibold')
        .fontSize(9.5)
        .fillColor(COLOR.ink)
        .text(value, x + labelW, y, { width: w - labelW, align: 'right' });
      y = Math.max(labelBottom, doc.y) + 6;
      if (opts.divider !== false) {
        doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).strokeColor(COLOR.line).stroke();
        y += 6;
      }
    };

    const sectionLabel = (text: string) => {
      doc
        .font('semibold')
        .fontSize(7.5)
        .fillColor(COLOR.faint)
        .text(text.toUpperCase(), pad, y, { width: contentW, characterSpacing: 1 });
      y = doc.y + 8;
    };

    // ── Details ────────────────────────────────────────────────────────────
    sectionLabel('Details');
    if (d.receiptNumber) row('Receipt no.', d.receiptNumber);
    row('Reference', d.reference);
    row('Paid by', d.payerName);
    row('Method', d.method, { divider: false });
    y += 10;

    // Itemise only when the payment actually covered more than one due —
    // repeating a single line above the identical summary reads as a bug.
    if (d.lines && d.lines.length > 1) {
      const lines = d.lines;
      sectionLabel('Dues settled');
      lines.forEach((line, i) => row(line.title, formatNaira(line.amountKobo), { divider: i < lines.length - 1 }));
      y += 10;
    }

    // ── Summary box ────────────────────────────────────────────────────────
    const boxPad = 14;
    const boxTop = y;
    const boxH = 88;
    doc.roundedRect(pad, boxTop, contentW, boxH, 10).fill(COLOR.brandSoft);
    y = boxTop + boxPad;
    const inner = { x: pad + boxPad, w: contentW - boxPad * 2 };
    row('Due amount', formatNaira(d.netToSpace), { ...inner, divider: false });
    row('Service charge', formatNaira(d.processingFee + d.duevyFee), inner);
    doc.font('semibold').fontSize(10.5).fillColor(COLOR.ink).text('Total paid', inner.x, y, { width: inner.w });
    doc
      .font('bold')
      .fontSize(12)
      .fillColor(COLOR.brand)
      .text(formatNaira(d.amountPaid), inner.x, y - 1.5, { width: inner.w, align: 'right' });
    y = boxTop + boxH + 12;

    doc
      .font('regular')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(
        (d.processingFee > 0
          ? `Service charge breakdown: processing ${formatNaira(d.processingFee)} · Duevy ${formatNaira(d.duevyFee)}. `
          : 'Service charge: 2% + ₦20 per payment. ') + `The department receives the full ${formatNaira(d.netToSpace)}.`,
        pad,
        y,
        { width: contentW, lineGap: 2 },
      );

    // ── Footer: pinned to the bottom, or just below the content if it's long ─
    let footerY = Math.max(pageH - 58, doc.y + 18);
    if (footerY + 40 > pageH) {
      doc.addPage({ size: 'A5', margin: 0 });
      footerY = pageH - 58;
    }
    doc.moveTo(pad, footerY).lineTo(pageW - pad, footerY).lineWidth(0.6).strokeColor(COLOR.line).stroke();
    doc
      .font('semibold')
      .fontSize(8.5)
      .fillColor(COLOR.ink)
      .text('Thank you for your payment.', pad, footerY + 12, { width: contentW, align: 'center' });
    doc
      .font('regular')
      .fontSize(7.5)
      .fillColor(COLOR.faint)
      .text('This is a computer-generated receipt and needs no signature · duevy.app', pad, footerY + 26, {
        width: contentW,
        align: 'center',
      });

    doc.end();
  });
}
