import path from 'path';
import PDFDocument from 'pdfkit';
import { formatNaira } from './money';

interface ReceiptData {
  /** Human receipt number (e.g. "R-000123") when one was issued. */
  receiptNumber?: string;
  reference: string;
  /** Used as the single line when `lines` isn't given (legacy payments). */
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
   * and §5.3 requires the receipt to itemise them.
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
  paper: '#f7f6f2',
  brand: '#0b6e4f',
  brandDeep: '#08583f',
  brandSoft: '#eef6f2',
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

const PAGE_W = 419.53; // A5
const A5_H = 595.28;
const PAD = 32;
const CONTENT_W = PAGE_W - PAD * 2;
const TABLE_PAD = 12;
const AMOUNT_W = 90;
const TITLE_W = CONTENT_W - TABLE_PAD * 2 - AMOUNT_W - 8;

function registerFonts(doc: PDFKit.PDFDocument) {
  doc.registerFont('regular', FONT.regular);
  doc.registerFont('semibold', FONT.semibold);
  doc.registerFont('bold', FONT.bold);
}

/**
 * How tall the receipt needs to be. A receipt stays one page: A5 when it fits,
 * taller when a long basket of dues needs the room.
 */
function measureHeight(d: ReceiptData, lines: { title: string }[]): number {
  const m = new PDFDocument({ size: 'A5', margin: 0 });
  registerFonts(m);
  m.font('regular').fontSize(9.5);
  const rows = lines.reduce((sum, l) => sum + Math.max(m.heightOfString(l.title, { width: TITLE_W }), 12) + 12, 0);
  m.font('semibold').fontSize(10);
  const party = Math.max(m.heightOfString(d.spaceName || '—', { width: (CONTENT_W - 16) / 2 }), 12);
  m.font('regular').fontSize(7.5);
  const note = m.heightOfString('x'.repeat(220), { width: CONTENT_W, lineGap: 2 });
  m.end();
  const details = (d.receiptNumber ? 4 : 3) * 16;
  // header + parties + table head + rows + totals + details + note + footer
  return 150 + 20 + 12 + party + 18 + 28 + rows + 8 + 10 + 34 + 2 + 30 + 20 + 14 + details + 8 + note + 70;
}

/**
 * Render a payment receipt as a PDF buffer (§6.5/§9.3 — `application/pdf`).
 * Always itemises the dues paid, so a one-due and a many-due receipt share one
 * layout.
 */
export function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  const lines = d.lines && d.lines.length > 0 ? d.lines : [{ title: d.title, amountKobo: d.netToSpace }];
  const pageHeight = Math.max(A5_H, Math.ceil(measureHeight(d, lines)));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, pageHeight],
      margin: 0,
      info: { Title: `Duevy receipt ${d.receiptNumber ?? d.reference}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    registerFonts(doc);

    const pageW = PAGE_W;
    const pageH = pageHeight;
    const pad = PAD;
    const contentW = CONTENT_W;
    const fee = d.processingFee + d.duevyFee;

    let y = 0;

    // ── Header band ────────────────────────────────────────────────────────
    const headerH = 150;
    doc.rect(0, 0, pageW, headerH).fill(COLOR.brand);
    // A quiet ring in the corner, echoing the app's cards.
    doc.save().circle(pageW - 18, -10, 72).lineWidth(18).strokeOpacity(0.08).strokeColor('#ffffff').stroke().restore();

    doc.font('bold').fontSize(17).fillColor(COLOR.onBrand).text('Duevy.', pad, 26, { lineBreak: false });
    doc
      .font('semibold')
      .fontSize(7.5)
      .fillColor(COLOR.onBrandMuted)
      .text('PAYMENT RECEIPT', pad, 26, { width: contentW, align: 'right', characterSpacing: 1.2 });
    if (d.receiptNumber) {
      doc
        .font('semibold')
        .fontSize(9)
        .fillColor(COLOR.onBrand)
        .text(d.receiptNumber, pad, 38, { width: contentW, align: 'right' });
    }

    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text('Total paid', pad, 66);
    doc.font('bold').fontSize(27).fillColor(COLOR.onBrand).text(formatNaira(d.amountPaid), pad, 78, { width: contentW });

    const pill = 'PAID';
    doc.font('bold').fontSize(7.5);
    const pillW = doc.widthOfString(pill, { characterSpacing: 0.8 }) + 18;
    const pillY = 117;
    doc.roundedRect(pad, pillY, pillW, 17, 8.5).fill(COLOR.onBrand);
    doc.fillColor(COLOR.brand).text(pill, pad, pillY + 4.6, { width: pillW, align: 'center', characterSpacing: 0.8 });
    doc
      .font('regular')
      .fontSize(9)
      .fillColor(COLOR.onBrandMuted)
      .text(formatPaidAt(d.paidAt), pad + pillW + 10, pillY + 3.8, { width: contentW - pillW - 10 });

    // ── Paid to / Paid by ──────────────────────────────────────────────────
    y = headerH + 20;
    const colW = (contentW - 16) / 2;
    const party = (label: string, value: string, x: number) => {
      doc.font('semibold').fontSize(7).fillColor(COLOR.faint).text(label.toUpperCase(), x, y, { width: colW, characterSpacing: 1 });
      doc.font('semibold').fontSize(10).fillColor(COLOR.ink).text(value || '—', x, y + 12, { width: colW });
      return doc.y;
    };
    const leftBottom = party('Paid to', d.spaceName, pad);
    const rightBottom = party('Paid by', d.payerName, pad + colW + 16);
    y = Math.max(leftBottom, rightBottom) + 18;

    // ── Itemised dues ──────────────────────────────────────────────────────
    const tablePad = TABLE_PAD;
    const amountW = AMOUNT_W;
    const titleW = TITLE_W;

    doc.roundedRect(pad, y, contentW, 24, 8).fill(COLOR.paper);
    doc
      .font('semibold')
      .fontSize(7)
      .fillColor(COLOR.muted)
      .text(lines.length > 1 ? `DUES PAID (${lines.length})` : 'DUE PAID', pad + tablePad, y + 8.5, { width: titleW, characterSpacing: 1 })
      .text('AMOUNT', pad + contentW - tablePad - amountW, y + 8.5, { width: amountW, align: 'right', characterSpacing: 1 });
    y += 24 + 4;

    lines.forEach((line, i) => {
      doc.font('regular').fontSize(9.5);
      const h = Math.max(doc.heightOfString(line.title, { width: titleW }), 12);
      doc.fillColor(COLOR.ink).text(line.title, pad + tablePad, y + 6, { width: titleW });
      doc
        .font('semibold')
        .fontSize(9.5)
        .fillColor(COLOR.ink)
        .text(formatNaira(line.amountKobo), pad + contentW - tablePad - amountW, y + 6, { width: amountW, align: 'right' });
      y += h + 12;
      if (i < lines.length - 1) {
        doc.moveTo(pad + tablePad, y).lineTo(pad + contentW - tablePad, y).lineWidth(0.6).strokeColor(COLOR.line).stroke();
      }
    });
    y += 8;

    // ── Totals ─────────────────────────────────────────────────────────────
    const totalsX = pad + contentW * 0.38;
    const totalsW = contentW - (totalsX - pad);
    const totalRow = (label: string, value: string) => {
      doc.font('regular').fontSize(9.5).fillColor(COLOR.muted).text(label, totalsX, y, { width: totalsW * 0.55 });
      doc.font('semibold').fontSize(9.5).fillColor(COLOR.ink).text(value, totalsX, y, { width: totalsW - tablePad, align: 'right' });
      y += 17;
    };
    doc.moveTo(pad, y).lineTo(pad + contentW, y).lineWidth(0.8).strokeColor(COLOR.line).stroke();
    y += 10;
    totalRow(lines.length > 1 ? 'Dues total' : 'Due amount', formatNaira(d.netToSpace));
    totalRow('Service charge', formatNaira(fee));
    y += 2;
    doc.roundedRect(totalsX - tablePad, y, totalsW + tablePad, 30, 8).fill(COLOR.brandSoft);
    doc.font('semibold').fontSize(10.5).fillColor(COLOR.ink).text('Total paid', totalsX, y + 9.5, { width: totalsW * 0.55 });
    doc
      .font('bold')
      .fontSize(12)
      .fillColor(COLOR.brand)
      .text(formatNaira(d.amountPaid), totalsX, y + 8.5, { width: totalsW - tablePad, align: 'right' });
    y += 30 + 20;

    // ── Details ────────────────────────────────────────────────────────────
    const details: [string, string][] = [
      ...(d.receiptNumber ? ([['Receipt no.', d.receiptNumber]] as [string, string][]) : []),
      ['Reference', d.reference],
      ['Method', d.method],
      ['Date paid', formatPaidAt(d.paidAt)],
    ];
    doc.font('semibold').fontSize(7).fillColor(COLOR.faint).text('DETAILS', pad, y, { width: contentW, characterSpacing: 1 });
    y += 14;
    for (const [label, value] of details) {
      doc.font('regular').fontSize(9).fillColor(COLOR.muted).text(label, pad, y, { width: contentW * 0.35 });
      doc.font('semibold').fontSize(9).fillColor(COLOR.ink).text(value, pad + contentW * 0.35, y, { width: contentW * 0.65, align: 'right' });
      y = Math.max(y + 16, doc.y + 4);
    }
    y += 8;

    const note =
      (d.processingFee > 0
        ? `Service charge breakdown: processing ${formatNaira(d.processingFee)} · Duevy ${formatNaira(d.duevyFee)}. `
        : 'Service charge: 2% + ₦20 per payment. ') + `${d.spaceName || 'The department'} receives the full ${formatNaira(d.netToSpace)}.`;
    doc.font('regular').fontSize(7.5).fillColor(COLOR.muted).text(note, pad, y, { width: contentW, lineGap: 2 });

    // ── Footer, pinned to the bottom ───────────────────────────────────────
    const footerY = pageH - 50;
    doc.moveTo(pad, footerY).lineTo(pageW - pad, footerY).lineWidth(0.6).strokeColor(COLOR.line).stroke();
    doc
      .font('semibold')
      .fontSize(8.5)
      .fillColor(COLOR.ink)
      .text('Thank you for your payment.', pad, footerY + 11, { width: contentW, align: 'center' });
    doc
      .font('regular')
      .fontSize(7)
      .fillColor(COLOR.faint)
      .text('Computer-generated receipt — no signature needed · duevy.app · support@duevy.app', pad, footerY + 25, {
        width: contentW,
        align: 'center',
      });

    doc.end();
  });
}
