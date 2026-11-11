import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument, rgb, type PDFPage } from 'pdf-lib';
import { formatCell, lagosDate, type Cell, type ReportTable } from '../services/reports.service';

/**
 * Admin report PDFs (§14.9, `format: "pdf"`) on Duevy's letterhead.
 *
 * pdfkit lays the table out inside the letterhead's writing area; pdf-lib then
 * stamps the letterhead onto every page. The logo, email/domain and footer text are
 * cut straight from assets/letterhead.pdf (vector, exact), and the full-width
 * rule and footer band are redrawn in its colours, so the same letterhead fits
 * portrait (short reports) and landscape (wide tables).
 */

const ASSETS = path.join(__dirname, '../../assets');
const asset = (name: string) => path.join(ASSETS, name);

// --- The letterhead's geometry, in points on its A4 portrait page -----------
const LH = { width: 595.2756, height: 841.8898, margin: 50 };
const BRAND_GREEN = rgb(2 / 255, 62 / 255, 58 / 255); // #023E3A
const BRAND_GOLD = rgb(250 / 255, 190 / 255, 76 / 255); // #FABE4C
/** Pieces cut from the letterhead: [left, bottom, right, top]. */
const PIECES = {
  logo: { left: 48, bottom: 749, right: 202, top: 796 },
  /** Just the email and domain lines; the street address above them is left out. */
  contact: { left: 420, bottom: 748, right: 548, top: 774 },
  footerLeft: { left: 40, bottom: 12, right: 330, top: 40 },
  footerRight: { left: 430, bottom: 12, right: 552, top: 40 },
} as const;
const RULE = { y: 721.3772, height: 2.2, goldWidth: 60 };
const FOOTER = { band: 46, gold: 2.5 };

/** Where the report itself may write, below the rule and above the footer. */
const CONTENT_MARGINS = { top: LH.height - RULE.y + 26, bottom: FOOTER.band + FOOTER.gold + 34, left: LH.margin, right: LH.margin };

const INK = '#1b2520';
const MUTED = '#6b7672';
const RULE_COLOR = '#d9dedb';

let letterheadBytes: Buffer | null = null;
function letterhead(): Buffer {
  letterheadBytes ??= fs.readFileSync(asset('letterhead.pdf'));
  return letterheadBytes;
}

/** Wide text columns get more room than numbers. */
const WIDE = new Set(['Metric', 'Description', 'Email', 'Payer', 'Space', 'Rep']);

export async function renderReportPdf(table: ReportTable): Promise<Buffer> {
  // Up to 4 columns reads best on the letterhead as designed (portrait).
  const layout = table.columns.length <= 4 ? 'portrait' : 'landscape';
  const body = await renderTable(table, layout);
  return stampLetterhead(body);
}

function renderTable(table: ReportTable, layout: 'portrait' | 'landscape'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const page = { size: 'A4', layout, margins: CONTENT_MARGINS } as const;
    const doc = new PDFDocument({ ...page, bufferPages: true, info: { Title: `Duevy - ${table.title}`, Author: 'Duevy Labs Ltd' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('regular', asset('fonts/Inter-Regular.ttf'));
    doc.registerFont('semibold', asset('fonts/Inter-SemiBold.ttf'));
    doc.registerFont('bold', asset('fonts/Inter-Bold.ttf'));

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const size = layout === 'portrait' ? 9 : 8;

    doc.font('bold').fontSize(15).fillColor(INK).text(table.title, left);
    doc.moveDown(0.25);
    doc.font('regular').fontSize(8.5).fillColor(MUTED);
    for (const line of table.subtitle) doc.text(line);
    doc.text(`Generated ${lagosDate(new Date())}`);
    doc.moveDown(0.9);

    const weights = table.columns.map((c, i) =>
      c.kind && c.kind !== 'text' ? 1 : i === 0 && table.columns.length <= 4 ? 3.2 : WIDE.has(c.label) ? 2 : c.label === 'Reference' || c.label.startsWith('Date') ? 1.5 : 1.2,
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (usable * w) / sum);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const PAD = 6;

    const drawRow = (cells: Cell[], opts: { bold?: boolean; header?: boolean }) => {
      const texts = cells.map((c, i) => (opts.header ? String(c ?? '') : formatCell(c, table.columns[i]?.kind, true)));
      const font = opts.header || opts.bold ? 'semibold' : 'regular';
      doc.font(font).fontSize(size);
      const height = Math.max(...texts.map((t, i) => doc.heightOfString(t || ' ', { width: widths[i]! - PAD }))) + 7;
      if (doc.y + height > bottom()) {
        doc.addPage(page);
        if (!opts.header) drawHeader();
        doc.font(font).fontSize(size);
      }
      const y = doc.y;
      if (opts.header) doc.rect(left, y, usable, height).fill('#f1f4f2');
      texts.forEach((t, i) => {
        const kind = table.columns[i]?.kind;
        doc.fillColor(opts.header ? MUTED : INK).text(t, xs[i]! + (i === 0 ? 4 : 0), y + 3.5, {
          width: widths[i]! - PAD - (i === 0 ? 4 : 0),
          align: kind && kind !== 'text' ? 'right' : 'left',
        });
      });
      doc.y = y + height;
      doc
        .strokeColor(opts.bold ? INK : RULE_COLOR)
        .lineWidth(opts.bold ? 0.6 : 0.3)
        .moveTo(left, doc.y)
        .lineTo(left + usable, doc.y)
        .stroke();
    };
    const drawHeader = () => drawRow(table.columns.map((c) => c.label), { header: true });

    drawHeader();
    if (table.rows.length === 0) {
      doc.moveDown(0.8).font('regular').fontSize(9).fillColor(MUTED).text('Nothing in this period.', left);
    }
    for (const row of table.rows) {
      // A row with only its first cell filled, in capitals, is a section heading.
      const first = row[0];
      const isSection = typeof first === 'string' && row.slice(1).every((c) => c === null) && first === first.toUpperCase();
      drawRow(row, { bold: isSection });
    }
    if (table.totals) drawRow(table.totals, { bold: true });

    // "Page n of N" just above the footer band.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const y = doc.page.height - FOOTER.band - FOOTER.gold - 20;
      // Writing below the bottom margin would add a page; lift it while we stamp.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('regular').fontSize(7.5).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, left, y, { width: usable, align: 'right', lineBreak: false });
      doc.page.margins.bottom = keep;
    }

    doc.end();
  });
}

/** Stamp the letterhead's header and footer onto every page of `body`. */
async function stampLetterhead(body: Buffer): Promise<Buffer> {
  const out = await PdfLibDocument.load(body);
  const source = (await PdfLibDocument.load(letterhead())).getPage(0);
  const [logo, contact, footerLeft, footerRight] = await out.embedPages(
    [source, source, source, source],
    [PIECES.logo, PIECES.contact, PIECES.footerLeft, PIECES.footerRight],
  );
  // Centre the email and domain on the logo, now the address no longer sits above them.
  const centre = (b: { bottom: number; top: number }) => (b.bottom + b.top) / 2;
  const contactLift = centre(PIECES.logo) - centre(PIECES.contact);

  for (const page of out.getPages()) {
    const { width: W, height: H } = page.getSize();
    const dx = W - LH.width; // shift for right-anchored pieces
    const dy = H - LH.height; // shift for top-anchored pieces
    const at = (p: PDFPage, piece: typeof logo, box: { left: number; bottom: number }, x: number, y: number) =>
      p.drawPage(piece!, { x: box.left + x, y: box.bottom + y, width: piece!.width, height: piece!.height });

    // Header: logo left, email and domain right, then the green rule ending in gold.
    at(page, logo, PIECES.logo, 0, dy);
    at(page, contact, PIECES.contact, dx, dy + contactLift);
    const ruleRight = W - LH.margin;
    page.drawRectangle({ x: LH.margin, y: RULE.y + dy, width: ruleRight - RULE.goldWidth - LH.margin, height: RULE.height, color: BRAND_GREEN });
    page.drawRectangle({ x: ruleRight - RULE.goldWidth, y: RULE.y + dy, width: RULE.goldWidth, height: RULE.height, color: BRAND_GOLD });

    // Footer: the green band with its gold edge, company left, tagline right.
    page.drawRectangle({ x: 0, y: 0, width: W, height: FOOTER.band, color: BRAND_GREEN });
    page.drawRectangle({ x: 0, y: FOOTER.band, width: W, height: FOOTER.gold, color: BRAND_GOLD });
    at(page, footerLeft, PIECES.footerLeft, 0, 0);
    at(page, footerRight, PIECES.footerRight, dx, 0);
  }
  return Buffer.from(await out.save());
}
