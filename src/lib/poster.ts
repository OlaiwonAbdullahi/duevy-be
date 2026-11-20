import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { computeCharge, formatNaira } from './money';
import { buildQrModules, drawStylishQr } from './qr';

/**
 * A printable A4 "scan to pay" poster for a guest-enabled due. A rep downloads
 * it, prints it, and sticks it up somewhere (a hostel notice board, a desk);
 * anyone scans the QR to open the due's public pay page and pays as a guest —
 * no account needed.
 *
 * Same visual language as the receipt (lib/receipt.ts): the green doodle header
 * with the white wordmark, Manrope type, and the branded rounded QR with the
 * Duevy "D" in its centre. Manrope has no ₦ glyph, so amounts draw the naira
 * sign in Inter (which does) and the number in Manrope.
 */

const ASSETS = path.join(__dirname, '../../assets');
const FONT = {
  manrope: path.join(ASSETS, 'fonts/Manrope-Medium.woff'),
  manropeBold: path.join(ASSETS, 'fonts/Manrope-Bold.woff'),
  // Only for the ₦ sign, which Manrope lacks.
  interSymbol: path.join(ASSETS, 'fonts/Inter-SemiBold.ttf'),
  interSymbolBold: path.join(ASSETS, 'fonts/Inter-Bold.ttf'),
};
const IMAGE = {
  doodle: path.join(ASSETS, 'images/doodle-card.jpg'),
  logoWhite: path.join(ASSETS, 'images/duevy-logo-white.png'),
};

// Shared with the receipt palette (lib/receipt.ts COLOR).
const COLOR = {
  ink: '#16201b',
  muted: '#6b7672',
  faint: '#9aa39e',
  brand: '#0b6e4f',
  brandDeep: '#08583f',
  gold: '#f6b64c',
  line: '#e8ece9',
  paper: '#ffffff',
  onBrand: '#ffffff',
  onBrandMuted: '#cfe6dc',
};

// A4 portrait, in points.
const PAGE = { width: 595.28, height: 841.89, margin: 52 };

/** An image scaled to fit a box, or null if PDFKit can't read it. */
function fitImage(doc: PDFKit.PDFDocument, src: Buffer, maxW: number, maxH: number) {
  try {
    const img = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(src);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    return { w: img.width * scale, h: img.height * scale };
  } catch {
    return null;
  }
}

export interface PosterData {
  spaceName: string;
  dueTitle: string;
  /** Face amount in kobo; the poster shows it plus the processing fee. */
  amountKobo: number;
  /** The deadline as a long date, e.g. "Fri, 14 Nov 2026"; omitted = no deadline. */
  deadline?: string;
  /** The public pay page, e.g. https://duevy.com/pay/<dueId>. */
  payUrl: string;
}

export async function renderDuePoster(data: PosterData): Promise<Buffer> {
  const charge = computeCharge(data.amountKobo);
  const modules = buildQrModules(data.payUrl);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: `Pay ${data.dueTitle} — Duevy`, Author: 'Duevy Labs Ltd' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('body', FONT.manrope);
    doc.registerFont('bold', FONT.manropeBold);
    doc.registerFont('sym', FONT.interSymbol);
    doc.registerFont('sym-bold', FONT.interSymbolBold);

    const W = PAGE.width;
    const M = PAGE.margin;
    const usable = W - M * 2;
    const centre = { width: usable, align: 'center' as const };

    /** Draw a centred amount: the ₦ in Inter (Manrope lacks it), the number in
     *  Manrope. Baselines are aligned by nudging the symbol to sit on the number. */
    const nairaCentred = (amount: string, y: number, size: number, numberFont: 'body' | 'bold', color: string) => {
      const symbol = '₦';
      const rest = amount.replace(/^₦/, '');
      const symFont = numberFont === 'bold' ? 'sym-bold' : 'sym';
      const wSym = doc.font(symFont).fontSize(size).widthOfString(symbol);
      const wRest = doc.font(numberFont).fontSize(size).widthOfString(rest);
      const startX = M + (usable - (wSym + wRest)) / 2;
      doc.fillColor(color);
      // Inter's ascender sits a touch higher than Manrope's; drop the sign a
      // hair so the two baselines line up.
      doc.font(symFont).fontSize(size).text(symbol, startX, y + size * 0.03, { lineBreak: false });
      doc.font(numberFont).fontSize(size).text(rest, startX + wSym, y, { lineBreak: false });
    };

    // ── Header: the green doodle band with the white wordmark ────────────────
    const bandH = 156;
    doc.rect(0, 0, W, bandH).fill(COLOR.brandDeep);
    doc.save();
    doc.rect(0, 0, W, bandH).clip();
    try {
      doc.image(IMAGE.doodle, 0, 0, { cover: [W, bandH], align: 'center', valign: 'center' });
    } catch {
      /* no doodle: the solid green band stands on its own */
    }
    doc.restore();

    try {
      const logo = fs.readFileSync(IMAGE.logoWhite);
      const fit = fitImage(doc, logo, 196, 58);
      if (fit) doc.image(logo, (W - fit.w) / 2, 50, { width: fit.w, height: fit.h });
    } catch {
      doc.font('bold').fontSize(30).fillColor(COLOR.onBrand).text('Duevy', 0, 58, centre);
    }
    doc.font('body').fontSize(10.5).fillColor(COLOR.onBrandMuted)
      .text('SCAN TO PAY', 0, bandH - 40, { ...centre, characterSpacing: 3 });

    // ── Space + due title ────────────────────────────────────────────────────
    let y = bandH + 44;
    doc.font('body').fontSize(12).fillColor(COLOR.muted)
      .text(data.spaceName.toUpperCase(), M, y, { ...centre, characterSpacing: 1.2 });
    y = doc.y + 8;
    doc.font('bold').fontSize(29).fillColor(COLOR.ink).text(data.dueTitle, M, y, centre);
    y = doc.y + 20;

    // ── Amount + fine print ──────────────────────────────────────────────────
    nairaCentred(formatNaira(charge.total), y, 38, 'bold', COLOR.brand);
    y += 44;
    const fineprint = `Includes ${formatNaira(charge.fee)} processing fee${data.deadline ? `  ·  Due ${data.deadline}` : ''}`;
    doc.font('sym').fontSize(11.5).fillColor(COLOR.muted).text(fineprint, M, y, centre);
    y = doc.y + 24;

    // ── The branded QR in a framed card ──────────────────────────────────────
    const qrBox = 262;
    const pad = 22;
    const cardW = qrBox + pad * 2;
    const cardX = (W - cardW) / 2;
    doc.roundedRect(cardX, y, cardW, cardW, 28).lineWidth(1.25).fillAndStroke(COLOR.paper, COLOR.line);
    drawStylishQr(doc, modules, cardX + pad, y + pad, qrBox, COLOR.paper);
    y += cardW + 28;

    // ── Call to action ───────────────────────────────────────────────────────
    doc.font('bold').fontSize(17).fillColor(COLOR.ink).text('Scan with your phone camera to pay', M, y, centre);
    y = doc.y + 7;
    doc.font('body').fontSize(12).fillColor(COLOR.muted).text('No Duevy account needed — you get a receipt by email.', M, y, centre);
    y = doc.y + 16;
    doc.font('body').fontSize(10).fillColor(COLOR.brand)
      .text(data.payUrl, M, y, { ...centre, link: data.payUrl, underline: false });

    // ── Footer ───────────────────────────────────────────────────────────────
    const footH = 50;
    const footY = PAGE.height - footH;
    doc.rect(0, footY, W, footH).fill(COLOR.brandDeep);
    doc.font('body').fontSize(10.5).fillColor(COLOR.onBrandMuted);
    doc.text('Powered by Duevy', 0, footY + (footH - doc.currentLineHeight()) / 2, centre);

    doc.end();
  });
}
