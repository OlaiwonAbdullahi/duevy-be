import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { formatNaira } from './money';
import { resolveReceiptDesign, type ResolvedReceiptDesign } from '../services/receiptDesign.service';

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
  /** The space's custom design; omitted = the standard Duevy receipt. */
  design?: ResolvedReceiptDesign;
  /** A guest's answers to the due's questions, printed when the design allows. */
  answers?: { label: string; value: string }[];
}

type Colors = typeof COLOR;

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

/** Mix a #rrggbb colour toward black, for the header behind the accent. */
function darken(hex: string, by: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - by));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

function colorsFor(design: ResolvedReceiptDesign): Colors {
  return design.accent ? { ...COLOR, brand: design.accent, brandDeep: darken(design.accent, 0.2) } : COLOR;
}

/** An image's size scaled to fit a box, or null if PDFKit can't read it. */
function fitImage(doc: PDFKit.PDFDocument, src: Buffer, maxW: number, maxH: number) {
  try {
    // openImage exists at runtime but is missing from @types/pdfkit.
    const img = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(src);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    return { w: img.width * scale, h: img.height * scale };
  } catch {
    return null;
  }
}

const PAGE_W = 419.53; // A5
const A5_H = 595.28;
const HEADER_H = 190;
const CARD_X = 18;
const CARD_W = PAGE_W - CARD_X * 2;
const CARD_TOP = 150; // overlaps the header
/** A rep's logo is drawn bigger than Duevy's, so the header grows by this much under it. */
const LOGO_SHIFT = 26;
const LOGO_MAX = { w: 200, h: 44 };
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

/**
 * Asset bytes, read from disk once per process. Passing paths made pdfkit
 * re-read ~1.25 MB of fonts (twice: scratch + real document) and the header
 * images synchronously on every receipt, on the event loop.
 */
const assetCache = new Map<string, Buffer>();
function asset(file: string): Buffer {
  let buf = assetCache.get(file);
  if (!buf) {
    buf = fs.readFileSync(file);
    assetCache.set(file, buf);
  }
  return buf;
}

function registerFonts(doc: PDFKit.PDFDocument) {
  doc.registerFont('regular', asset(FONT.regular));
  doc.registerFont('semibold', asset(FONT.semibold));
  doc.registerFont('bold', asset(FONT.bold));
}

/** A bundled image's bytes, or its path if it can't be read (tryImage then skips it). */
function bundledImage(file: string): Buffer | string {
  try {
    return asset(file);
  } catch {
    return file;
  }
}

/** Draw an image if it's there; a missing asset must never break a receipt. */
function tryImage(doc: PDFKit.PDFDocument, src: string | Buffer, x: number, y: number, opts: PDFKit.Mixins.ImageOption) {
  try {
    doc.image(src, x, y, opts);
  } catch {
    // Skip it.
  }
}

/**
 * The stamp, centred on (x, y): the space's own stamp image if it uploaded
 * one, else a drawn round seal, rectangular rubber stamp or ribbon carrying
 * the stamp word ("PAID" by default).
 */
function drawStamp(doc: PDFKit.PDFDocument, design: ResolvedReceiptDesign, x: number, y: number, color: string) {
  if (design.stampImage) {
    const fit = fitImage(doc, design.stampImage, 76, 66);
    if (fit) tryImage(doc, design.stampImage, x - fit.w / 2, y - fit.h / 2, { width: fit.w, height: fit.h });
    return;
  }

  const word = design.stampText.toUpperCase();
  const long = word.length > 5;
  const label = (size: number, top: number, width: number, spacing: number, fill = color) =>
    doc.font('bold').fontSize(size).fillColor(fill).text(word, x - width / 2, top, {
      width,
      align: 'center',
      characterSpacing: spacing,
      lineBreak: false,
    });
  const brand = (top: number) =>
    doc.font('semibold').fontSize(5.5).fillColor(color).text('DUEVY', x - 30, top, { width: 60, align: 'center', characterSpacing: 1.8 });

  doc.save();
  if (design.stampStyle === 'rect') {
    doc.rotate(-10, { origin: [x, y] });
    doc.roundedRect(x - 40, y - 18, 80, 36, 4).lineWidth(1.8).strokeColor(color).stroke();
    doc.roundedRect(x - 36.5, y - 14.5, 73, 29, 2.5).lineWidth(0.6).strokeColor(color).stroke();
    label(long ? 9.5 : 13, y - (long ? 9 : 11), 70, long ? 0.5 : 2);
    brand(y + 4);
  } else if (design.stampStyle === 'ribbon') {
    doc.rotate(-8, { origin: [x, y] });
    // A banner with notched ends.
    doc
      .polygon([x - 46, y - 12], [x + 46, y - 12], [x + 38, y], [x + 46, y + 12], [x - 46, y + 12], [x - 38, y])
      .fill(color);
    doc.moveTo(x - 34, y - 8.5).lineTo(x + 34, y - 8.5).moveTo(x - 34, y + 8.5).lineTo(x + 34, y + 8.5);
    doc.lineWidth(0.5).dash(1.5, { space: 1.5 }).strokeColor('#ffffff').stroke().undash();
    label(long ? 8.5 : 11, y - (long ? 5 : 6.5), 66, long ? 0.4 : 1.6, '#ffffff');
  } else {
    doc.rotate(-14, { origin: [x, y] });
    doc.circle(x, y, 30).lineWidth(1.6).strokeColor(color).stroke();
    doc.circle(x, y, 25.5).lineWidth(0.6).strokeColor(color).stroke();
    label(long ? 8.5 : 13, y - (long ? 7 : 10), 52, long ? 0.6 : 1.5);
    brand(y + 6);
  }
  doc.restore();
}

/**
 * Lay out everything on the ticket card and return where the card ends. Run
 * once on a scratch document to measure, then for real — so the card and the
 * page are always exactly as tall as their content.
 */
function drawCardContent(
  doc: PDFKit.PDFDocument,
  d: ReceiptData,
  lines: Line[],
  design: ResolvedReceiptDesign,
  C: Colors,
  cardTop: number,
  measuring: boolean,
): number {
  const pad = PAD;
  const contentW = CONTENT_W;
  const fee = d.processingFee + d.duevyFee;
  let y = cardTop + 20;

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
  doc.roundedRect(totalsX - TABLE_PAD, y, totalsW + TABLE_PAD, 32, 10).fill(C.brand);
  doc.font('semibold').fontSize(10).fillColor(COLOR.onBrandMuted).text('Total paid', totalsX, y + 11, { width: totalsW * 0.55 });
  doc
    .font('bold')
    .fontSize(12.5)
    .fillColor(COLOR.onBrand)
    .text(formatNaira(d.amountPaid), totalsX, y + 9.5, { width: totalsW - TABLE_PAD, align: 'right' });
  y += 32;

  // The stamp, in the space left of the totals.
  if (design.showStamp) drawStamp(doc, design, pad + contentW * 0.18, (totalsTop + y) / 2, design.stampColor ?? C.brand);
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
  const rows = (items: [string, string][]) => {
    for (const [label, value] of items) {
      doc.font('regular').fontSize(9).fillColor(COLOR.muted).text(label, pad, y, { width: contentW * 0.35 });
      doc.font('semibold').fontSize(9).fillColor(COLOR.ink).text(value, pad + contentW * 0.35, y, { width: contentW * 0.65, align: 'right' });
      y = Math.max(y + 16, doc.y + 4);
    }
  };
  const heading = (label: string) => {
    doc.font('semibold').fontSize(7).fillColor(COLOR.faint).text(label, pad, y, { width: contentW, characterSpacing: 1 });
    y += 14;
  };
  heading('DETAILS');
  rows(details);

  // ── The rep's additions: guest answers, a note, signatures ────────────
  if (design.showAnswers && d.answers?.length) {
    y += 8;
    heading('YOUR DETAILS');
    rows(d.answers.map((a) => [a.label, a.value]));
  }

  if (design.note) {
    y += 8;
    heading('NOTE');
    doc.font('regular').fontSize(9);
    const h = doc.heightOfString(design.note, { width: contentW - 24 });
    doc.roundedRect(pad, y, contentW, h + 18, 8).fill(COLOR.paper);
    doc.fillColor(COLOR.ink).text(design.note, pad + 12, y + 9, { width: contentW - 24 });
    y += h + 18 + 4;
  }

  // Signatures side by side, right-aligned, every line at the same height.
  const sigs = design.signatures.filter((s) => s.image || s.name || s.role);
  if (sigs.length) {
    const gap = 14;
    const blockW = Math.min(150, (contentW - gap * (sigs.length - 1)) / sigs.length);
    const fits = sigs.map((s) => (s.image ? fitImage(doc, s.image, blockW, 44) : null));
    y += 14;
    const lineY = y + Math.max(24, ...fits.map((f) => (f ? f.h + 2 : 0))); // 24 = room to sign by hand
    let bottom = lineY;
    sigs.forEach((s, i) => {
      const x = pad + contentW - (sigs.length - i) * blockW - (sigs.length - 1 - i) * gap;
      const fit = fits[i];
      if (fit && s.image) tryImage(doc, s.image, x + (blockW - fit.w) / 2, lineY - 2 - fit.h, { width: fit.w, height: fit.h });
      doc.moveTo(x, lineY).lineTo(x + blockW, lineY).lineWidth(0.8).strokeColor(COLOR.faint).stroke();
      let ty = lineY + 5;
      if (s.name) {
        doc.font('semibold').fontSize(9).fillColor(COLOR.ink).text(s.name, x, ty, { width: blockW, align: 'center' });
        ty = doc.y + 1;
      }
      if (s.role) {
        doc.font('regular').fontSize(8).fillColor(COLOR.muted).text(s.role, x, ty, { width: blockW, align: 'center' });
        ty = doc.y;
      }
      bottom = Math.max(bottom, ty);
    });
    y = bottom + 4;
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
  const design = d.design ?? resolveReceiptDesign(null);
  const C = colorsFor(design);
  const shift = design.logo ? LOGO_SHIFT : 0;
  const headerH = HEADER_H + shift;
  const cardTop = CARD_TOP + shift;

  // Measure on a scratch document first.
  const scratch = new PDFDocument({ size: [PAGE_W, 5000], margin: 0 });
  registerFonts(scratch);
  const cardBottom = drawCardContent(scratch, d, lines, design, C, cardTop, true);
  scratch.end();
  const pageH = Math.max(A5_H, Math.ceil(cardBottom + FOOTER_H));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, pageH],
      margin: 0,
      info: { Title: `${design.title} ${d.receiptNumber ?? d.reference}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerFonts(doc);

    doc.rect(0, 0, PAGE_W, pageH).fill(COLOR.page);

    // ── Header: doodle artwork, logo, and the amount that matters ─────────
    doc.rect(0, 0, PAGE_W, headerH).fill(C.brandDeep);
    // The artwork is Duevy-green, so a custom colour tints it rather than hiding it.
    if (design.headerStyle === 'artwork') {
      doc.save();
      doc.rect(0, 0, PAGE_W, headerH).clip();
      if (design.accent) doc.opacity(0.35);
      tryImage(doc, bundledImage(IMAGE.doodle), 0, 0, { cover: [PAGE_W, headerH], align: 'center', valign: 'center' });
      doc.restore();
    }

    // The rep's logo straight on the header, else Duevy's.
    const logo = design.logo ? fitImage(doc, design.logo, LOGO_MAX.w, LOGO_MAX.h) : null;
    if (logo && design.logo) {
      tryImage(doc, design.logo, CARD_X + 6, 16, { width: logo.w, height: logo.h });
    } else {
      tryImage(doc, bundledImage(IMAGE.logoWhite), CARD_X + 6, 22, { height: 22 });
    }
    // The title takes whatever width the logo leaves.
    const titleX = CARD_X + 6 + (logo ? logo.w : 90) + 16;
    doc
      .font('semibold')
      .fontSize(7)
      .fillColor(COLOR.onBrandMuted)
      .text(design.title.toUpperCase(), titleX, 24, { width: CARD_X + CARD_W - 6 - titleX, align: 'right', characterSpacing: 1.4 });
    if (d.receiptNumber) {
      doc.font('bold').fontSize(9.5).fillColor(COLOR.onBrand).text(d.receiptNumber, CARD_X, 35, { width: CARD_W - 6, align: 'right' });
    }

    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text('Total paid', 0, 62 + shift, { width: PAGE_W, align: 'center' });
    doc.font('bold').fontSize(30).fillColor(COLOR.onBrand).text(formatNaira(d.amountPaid), 0, 74 + shift, { width: PAGE_W, align: 'center' });

    // Status pill styled like the app's payment sheet — a frosted capsule with
    // a mint dot — and the payment time, centred together under the amount.
    const when = formatPaidAt(d.paidAt);
    doc.font('semibold').fontSize(8);
    const labelW = doc.widthOfString('Paid');
    const pillW = 10 + 4 + 6 + labelW + 10; // pad · dot · gap · label · pad
    doc.font('regular').fontSize(9);
    const whenW = doc.widthOfString(when);
    const rowX = (PAGE_W - (pillW + 8 + whenW)) / 2;
    const rowY = 115 + shift;
    doc.save().roundedRect(rowX, rowY, pillW, 18, 9).fillOpacity(0.15).fill(COLOR.onBrand).restore();
    doc.circle(rowX + 12, rowY + 9, 2.2).fill(COLOR.paidDot);
    doc.font('semibold').fontSize(8).fillColor(COLOR.onBrand).text('Paid', rowX + 20, rowY + 4.6, { lineBreak: false });
    doc.font('regular').fontSize(9).fillColor(COLOR.onBrandMuted).text(when, rowX + pillW + 8, rowY + 4.2, { lineBreak: false });

    // ── Ticket card ────────────────────────────────────────────────────────
    doc.roundedRect(CARD_X, cardTop, CARD_W, cardBottom - cardTop, 16).fill('#ffffff');
    drawCardContent(doc, d, lines, design, C, cardTop, false);

    // ── Footer ─────────────────────────────────────────────────────────────
    const footerY = cardBottom + 20;
    doc
      .font('semibold')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text(design.thankYou, 0, footerY + 3, { width: PAGE_W, align: 'center' });
    doc
      .font('regular')
      .fontSize(7)
      .fillColor(COLOR.faint)
      .text(`${design.logo ? 'Powered by Duevy · ' : ''}duevy.app · support@duevy.app`, 0, footerY + 26, {
        width: PAGE_W,
        align: 'center',
      });

    doc.end();
  });
}
