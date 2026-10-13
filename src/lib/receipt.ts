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

type Line = { title: string; amountKobo: number };

// The standard PDF fonts have no ₦ glyph, so embed Inter (OFL). Assets are
// resolved from the project root so it works from both src/ (tsx) and dist/ (node).
const ASSETS = path.join(__dirname, '../../assets');
const FONT = {
  regular: path.join(ASSETS, 'fonts/Inter-Regular.ttf'),
  semibold: path.join(ASSETS, 'fonts/Inter-SemiBold.ttf'),
  bold: path.join(ASSETS, 'fonts/Inter-Bold.ttf'),
};
const IMAGE = {
  /** The app's card artwork, behind the header. */
  doodle: path.join(ASSETS, 'images/doodle-card.jpg'),
  /** Mark + wordmark in white, for the green header (1488×428). */
  logoWhite: path.join(ASSETS, 'images/duevy-logo-white.png'),
};

const COLOR = {
  ink: '#1b2520',
  muted: '#7a847f',
  faint: '#a3aca7',
  line: '#e8ece9',
  page: '#f4f2ec',
  paper: '#f7f6f2',
  brand: '#0b6e4f',
  brandDeep: '#08583f',
  onBrand: '#ffffff',
  onBrandMuted: '#cfe6dc',
  /** The status dot on the app's payment sheet (emerald-300). */
  paidDot: '#6ee7b7',
};

const PAGE_W = 419.53; // A5
const A5_H = 595.28;
const HEADER_H = 190;
const CARD_X = 18;
const CARD_W = PAGE_W - CARD_X * 2;
const CARD_TOP = 150; // overlaps the header
const PAD = CARD_X + 18;
const CONTENT_W = PAGE_W - PAD * 2;
const TABLE_PAD = 12;
const AMOUNT_W = 90;
const TITLE_W = CONTENT_W - TABLE_PAD * 2 - AMOUNT_W - 8;
const FOOTER_H = 78;

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

function registerFonts(doc: PDFKit.PDFDocument) {
  doc.registerFont('regular', FONT.regular);
  doc.registerFont('semibold', FONT.semibold);
  doc.registerFont('bold', FONT.bold);
}

/** Draw an image if it's there; a missing asset must never break a receipt. */
function tryImage(doc: PDFKit.PDFDocument, src: string, x: number, y: number, opts: PDFKit.Mixins.ImageOption) {
  try {
    doc.image(src, x, y, opts);
  } catch {
    // Skip it.
  }
}

/**
 * Lay out everything on the ticket card and return where the card ends. Run
 * once on a scratch document to measure, then for real — so the card and the
 * page are always exactly as tall as their content.
 */
function drawCardContent(doc: PDFKit.PDFDocument, d: ReceiptData, lines: Line[], measuring: boolean): number {
  const pad = PAD;
  const contentW = CONTENT_W;
  const fee = d.processingFee + d.duevyFee;
  let y = CARD_TOP + 20;

  // ── Paid to / Paid by ──────────────────────────────────────────────────
  const colW = (contentW - 16) / 2;
  const party = (label: string, value: string, x: number) => {
    doc.font('semibold').fontSize(7).fillColor(COLOR.faint).text(label.toUpperCase(), x, y, { width: colW, characterSpacing: 1 });
    doc.font('semibold').fontSize(10).fillColor(COLOR.ink).text(value || '—', x, y + 12, { width: colW });
    return doc.y;
  };
  y = Math.max(party('Paid to', d.spaceName, pad), party('Paid by', d.payerName, pad + colW + 16)) + 16;

  // ── Itemised dues ──────────────────────────────────────────────────────
  doc.roundedRect(pad, y, contentW, 24, 8).fill(COLOR.paper);
  doc
    .font('semibold')
    .fontSize(7)
    .fillColor(COLOR.muted)
    .text(lines.length > 1 ? `DUES PAID (${lines.length})` : 'DUE PAID', pad + TABLE_PAD, y + 8.5, {
      width: TITLE_W,
      characterSpacing: 1,
    })
    .text('AMOUNT', pad + contentW - TABLE_PAD - AMOUNT_W, y + 8.5, { width: AMOUNT_W, align: 'right', characterSpacing: 1 });
  y += 28;

  lines.forEach((line, i) => {
    doc.font('regular').fontSize(9.5);
    const h = Math.max(doc.heightOfString(line.title, { width: TITLE_W }), 12);
    doc.fillColor(COLOR.ink).text(line.title, pad + TABLE_PAD, y + 6, { width: TITLE_W });
    doc
      .font('semibold')
      .fontSize(9.5)
      .fillColor(COLOR.ink)
      .text(formatNaira(line.amountKobo), pad + contentW - TABLE_PAD - AMOUNT_W, y + 6, { width: AMOUNT_W, align: 'right' });
    y += h + 12;
    if (i < lines.length - 1) {
      doc.moveTo(pad + TABLE_PAD, y).lineTo(pad + contentW - TABLE_PAD, y).lineWidth(0.6).strokeColor(COLOR.line).stroke();
    }
  });
  y += 8;

  // ── Totals, with a PAID stamp in the space beside them ─────────────────
  doc.moveTo(pad, y).lineTo(pad + contentW, y).lineWidth(0.8).strokeColor(COLOR.line).stroke();
  y += 12;
  const totalsTop = y;
  const totalsX = pad + contentW * 0.4;
  const totalsW = contentW - (totalsX - pad);
  const totalRow = (label: string, value: string) => {
    doc.font('regular').fontSize(9.5).fillColor(COLOR.muted).text(label, totalsX, y, { width: totalsW * 0.55 });
    doc.font('semibold').fontSize(9.5).fillColor(COLOR.ink).text(value, totalsX, y, { width: totalsW - TABLE_PAD, align: 'right' });
    y += 17;
  };
  totalRow(lines.length > 1 ? 'Dues total' : 'Due amount', formatNaira(d.netToSpace));
  totalRow('Service charge', formatNaira(fee));
  y += 3;
  doc.roundedRect(totalsX - TABLE_PAD, y, totalsW + TABLE_PAD, 32, 10).fill(COLOR.brand);
  doc.font('semibold').fontSize(10).fillColor(COLOR.onBrandMuted).text('Total paid', totalsX, y + 11, { width: totalsW * 0.55 });
  doc
    .font('bold')
    .fontSize(12.5)
    .fillColor(COLOR.onBrand)
    .text(formatNaira(d.amountPaid), totalsX, y + 9.5, { width: totalsW - TABLE_PAD, align: 'right' });
  y += 32;

  // A tilted rubber-stamp "PAID" in the empty space left of the totals.
  const stampX = pad + contentW * 0.18;
  const stampY = (totalsTop + y) / 2;
  doc.save();
  doc.rotate(-14, { origin: [stampX, stampY] });
  doc.circle(stampX, stampY, 30).lineWidth(1.6).strokeColor(COLOR.brand).stroke();
  doc.circle(stampX, stampY, 25.5).lineWidth(0.6).strokeColor(COLOR.brand).stroke();
  doc.font('bold').fontSize(13).fillColor(COLOR.brand).text('PAID', stampX - 30, stampY - 10, {
    width: 60,
    align: 'center',
    characterSpacing: 1.5,
  });
  doc.font('semibold').fontSize(5.5).fillColor(COLOR.brand).text('DUEVY', stampX - 30, stampY + 6, {
    width: 60,
    align: 'center',
    characterSpacing: 1.8,
  });
  doc.restore();
  y += 22;

  // ── Perforation: a torn-ticket edge between the bill and its details ───
  doc
    .moveTo(CARD_X + 16, y)
    .lineTo(CARD_X + CARD_W - 16, y)
    .lineWidth(1)
    .dash(3, { space: 3.5 })
    .strokeColor('#d9ddd9')
    .stroke()
    .undash();
  if (!measuring) {
    // Notches bitten out of the card's edges, in the page colour.
    doc.circle(CARD_X, y, 9).fill(COLOR.page);
    doc.circle(CARD_X + CARD_W, y, 9).fill(COLOR.page);
  }
  y += 20;

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
  return y + 12;
}

/**
 * Render a payment receipt as a PDF buffer (§6.5/§9.3 — `application/pdf`).
 * One layout for one due or many: the dues are always itemised, and the page
 * grows past A5 rather than splitting a long basket across pages.
 */
export function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  const lines: Line[] = d.lines && d.lines.length > 0 ? d.lines : [{ title: d.title, amountKobo: d.netToSpace }];

  // Measure on a scratch document first.
  const scratch = new PDFDocument({ size: [PAGE_W, 5000], margin: 0 });
  registerFonts(scratch);
  const cardBottom = drawCardContent(scratch, d, lines, true);
  scratch.end();
  const pageH = Math.max(A5_H, Math.ceil(cardBottom + FOOTER_H));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, pageH],
      margin: 0,
      info: { Title: `Duevy receipt ${d.receiptNumber ?? d.reference}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerFonts(doc);

    doc.rect(0, 0, PAGE_W, pageH).fill(COLOR.page);

    // ── Header: doodle artwork, logo, and the amount that matters ─────────
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(COLOR.brandDeep);
    doc.save();
    doc.rect(0, 0, PAGE_W, HEADER_H).clip();
    tryImage(doc, IMAGE.doodle, 0, 0, { cover: [PAGE_W, HEADER_H], align: 'center', valign: 'center' });
    doc.restore();

    tryImage(doc, IMAGE.logoWhite, CARD_X + 6, 22, { height: 22 });
    doc
      .font('semibold')
      .fontSize(7)
      .fillColor(COLOR.onBrandMuted)
      .text('PAYMENT RECEIPT', CARD_X, 24, { width: CARD_W - 6, align: 'right', characterSpacing: 1.4 });
    if (d.receiptNumber) {
      doc.font('bold').fontSize(9.5).fillColor(COLOR.onBrand).text(d.receiptNumber, CARD_X, 35, { width: CARD_W - 6, align: 'right' });
    }

    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text('Total paid', 0, 62, { width: PAGE_W, align: 'center' });
    doc.font('bold').fontSize(30).fillColor(COLOR.onBrand).text(formatNaira(d.amountPaid), 0, 74, { width: PAGE_W, align: 'center' });

    // Status pill styled like the app's payment sheet — a frosted capsule with
    // a mint dot — and the payment time, centred together under the amount.
    const when = formatPaidAt(d.paidAt);
    doc.font('semibold').fontSize(8);
    const labelW = doc.widthOfString('Paid');
    const pillW = 10 + 4 + 6 + labelW + 10; // pad · dot · gap · label · pad
    doc.font('regular').fontSize(9);
    const whenW = doc.widthOfString(when);
    const rowX = (PAGE_W - (pillW + 8 + whenW)) / 2;
    const rowY = 115;
    doc.save().roundedRect(rowX, rowY, pillW, 18, 9).fillOpacity(0.15).fill(COLOR.onBrand).restore();
    doc.circle(rowX + 12, rowY + 9, 2.2).fill(COLOR.paidDot);
    doc.font('semibold').fontSize(8).fillColor(COLOR.onBrand).text('Paid', rowX + 20, rowY + 4.6, { lineBreak: false });
    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text(when, rowX + pillW + 8, rowY + 4.2, { lineBreak: false });

    // ── Ticket card ────────────────────────────────────────────────────────
    doc.roundedRect(CARD_X, CARD_TOP, CARD_W, cardBottom - CARD_TOP, 16).fill('#ffffff');
    drawCardContent(doc, d, lines, false);

    // ── Footer ─────────────────────────────────────────────────────────────
    const footerY = cardBottom + 20;
    doc
      .font('semibold')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text('Thank you for your payment.', 0, footerY + 3, { width: PAGE_W, align: 'center' });
    doc
      .font('regular')
      .fontSize(7)
      .fillColor(COLOR.faint)
      .text('Computer-generated receipt — no signature needed · duevy.app · support@duevy.app', 0, footerY + 26, {
        width: PAGE_W,
        align: 'center',
      });

    doc.end();
  });
}
