import QRCode from 'qrcode';

/**
 * The branded QR code shared by the receipt (lib/receipt.ts) and the due poster
 * (lib/poster.ts): rounded data dots and rounded locator eyes in black, with
 * the Duevy "D" sitting in a cleared square at the centre. Built at error
 * correction level H so the cleared centre still scans.
 */

/** A QR code as a square bit matrix (1 = dark module), from `QRCode.create`. */
export type QrModules = { size: number; data: Uint8Array };

/** The QR matrix for a URL/text, at error correction level H. */
export function buildQrModules(text: string): QrModules {
  return QRCode.create(text, { errorCorrectionLevel: 'H' }).modules as QrModules;
}

/** One of the three 7×7 locator "eyes": a rounded frame around a rounded centre. */
function drawQrEye(doc: PDFKit.PDFDocument, x: number, y: number, cell: number, dark: string, light: string): void {
  const s = cell * 7;
  doc.roundedRect(x, y, s, s, cell * 2.1).fill(dark);
  doc.roundedRect(x + cell, y + cell, cell * 5, cell * 5, cell * 1.5).fill(light);
  doc.roundedRect(x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell * 1.05).fill(dark);
}

/**
 * The Duevy "D" as two filled vector sub-paths (from logos/duevylogo-only.svg,
 * viewBox 0 0 573 573 — the glyph is centred in it). Drawn straight into the
 * PDF so the QR's centre mark is crisp at any size, with no background.
 */
const DUEVY_D_PATHS = [
  'M414.69,309.6c-.97,2.33-2.02,4.6-3.14,6.73-10.8,20.79-28.59,32.6-52.96,34.77-11.74,1.05-23.68.17-35.55.17,12.33-7.22,22.27-16.58,29.59-28.76,25.99-43.23-2.07-101.27-52.1-107.59-2.7-.34-5.4-.73-8.1-.73-29.47-.05-58.96-.32-88.43.07-17.82.22-33.38,6.91-46.59,18.99-.63.58-1.26,1.17-1.9,1.73-.22.17-.49.27-.73.39-.34-.17-.66-.36-.97-.53v-84.51h122.91c13.56,0,26.87-.57,40.1,2.98,10.71,2.87,21.07,6.82,30.79,12.17,29.47,16.22,52.71,43.28,63.92,75.69,2.8,8,4.84,16.34,6.05,24.9,2.09,14.73,2.92,29.47-2.92,43.55Z',
  'M411.55,330.15v.85c-3.77,11.5-8.92,22.1-15.73,31.73-14.1,19.94-32.36,37.02-54.49,47.66-12.58,6.05-26.13,10.13-40.02,11.66-8.88.97-17.85.59-26.77.59h-120.71v-175.45c2.36-3.04,5.08-5.86,7.95-8.56,12.47-11.79,27.57-17.48,44.74-17.65,3.72-.02,7.42,0,11.74,0v127.45c0,7.9,2.02,9.9,9.85,9.9,40.48,0,80.99-.22,121.45.07,24.9.17,45.47-8.44,61.22-27.91.12-.15.37-.19.78-.34Z',
];
// The glyph's tight bounds inside that viewBox (measured): 264×272, centred at (286, 286).
const DUEVY_D = { cx: 286, cy: 286, w: 264, h: 272 };

/** Fill the "D" in `color`, `heightPt` tall, centred on (cx, cy). */
function drawDuevyD(doc: PDFKit.PDFDocument, cx: number, cy: number, heightPt: number, color: string): void {
  doc.save();
  doc.translate(cx, cy).scale(heightPt / DUEVY_D.h).translate(-DUEVY_D.cx, -DUEVY_D.cy);
  for (const d of DUEVY_D_PATHS) doc.path(d);
  doc.fill(color);
  doc.restore();
}

/**
 * Draw the branded QR: rounded modules and locator eyes in black (so it scans
 * whatever colour surrounds it), with the Duevy "D" on a cleared centre.
 */
export function drawStylishQr(
  doc: PDFKit.PDFDocument,
  modules: QrModules,
  x0: number,
  y0: number,
  sizePt: number,
  light: string,
): void {
  const n = modules.size;
  const cell = sizePt / n;
  const dark = '#000000';
  const on = (r: number, c: number) => modules.data[r * n + c] === 1;
  const inEye = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  // The "D" mark sits in a cleared square at the centre (no background), so the
  // module box below it is blanked to keep the mark clean and scannable.
  const markH = sizePt * 0.34;
  const markW = markH * (DUEVY_D.w / DUEVY_D.h);
  const cx = x0 + sizePt / 2;
  const cy = y0 + sizePt / 2;
  // Just a hairline of quiet space so the black "D" stays distinct from the modules.
  const marginX = cell * 0.35;
  const marginY = cell * 0.35;
  const clearX0 = cx - markW / 2 - marginX;
  const clearY0 = cy - markH / 2 - marginY;
  const clearX1 = cx + markW / 2 + marginX;
  const clearY1 = cy + markH / 2 + marginY;

  doc.save();

  // Data modules as rounded dots (locator eyes and the centre are drawn apart).
  const dotSize = cell * 0.9;
  const dotOff = (cell - dotSize) / 2;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!on(r, c) || inEye(r, c)) continue;
      const mx = x0 + c * cell + cell / 2;
      const my = y0 + r * cell + cell / 2;
      if (mx >= clearX0 && mx <= clearX1 && my >= clearY0 && my <= clearY1) continue;
      doc.roundedRect(x0 + c * cell + dotOff, y0 + r * cell + dotOff, dotSize, dotSize, dotSize * 0.35).fill(dark);
    }
  }

  drawQrEye(doc, x0, y0, cell, dark, light);
  drawQrEye(doc, x0 + (n - 7) * cell, y0, cell, dark, light);
  drawQrEye(doc, x0, y0 + (n - 7) * cell, cell, dark, light);

  // Centre: just the Duevy "D", filled black, no background.
  drawDuevyD(doc, cx, cy, markH, dark);

  doc.restore();
}
