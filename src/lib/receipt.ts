import PDFDocument from 'pdfkit';
import { formatNaira } from './money';

interface ReceiptData {
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

/**
 * Render a payment receipt as a PDF buffer (§6.5/§9.3 — `application/pdf`).
 * Mirrors the client's receipt layout so the numbers always match the ledger.
 */
export function renderReceiptPdf(d: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#1b2520';
    const muted = '#7a847f';
    const brand = '#0b6e4f';

    doc
      .lineWidth(2)
      .strokeColor(brand)
      .moveTo(doc.page.margins.left, 96)
      .lineTo(doc.page.width - doc.page.margins.right, 96)
      .stroke();

    doc.fontSize(20).fillColor(ink).text('Duevy.', { continued: false });
    doc.fontSize(11).fillColor(muted).text('Payment Receipt');
    doc.moveDown(1.5);

    doc.fontSize(15).fillColor(ink).text(d.title);
    doc.fontSize(11).fillColor(muted).text(d.spaceName);
    doc.moveDown(1);

    const row = (label: string, value: string) => {
      const y = doc.y;
      doc.fontSize(11).fillColor(muted).text(label, doc.page.margins.left, y);
      doc.fontSize(11).fillColor(ink).text(value, doc.page.margins.left, y, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'right',
      });
      doc.moveDown(0.6);
    };

    row('Reference', d.reference);
    row('Paid by', d.payerName);
    row('Date', d.paidAt.toISOString());
    row('Method', d.method);

    // Itemise only when the payment actually covered more than one due —
    // repeating a single line above the identical summary reads as a bug.
    if (d.lines && d.lines.length > 1) {
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor(muted).text('Dues settled');
      doc.moveDown(0.4);
      for (const line of d.lines) row(line.title, formatNaira(line.amountKobo));
      doc.moveDown(0.2);
    }

    row('Due amount', formatNaira(d.netToSpace));
    row('Service charge', formatNaira(d.processingFee + d.duevyFee));
    row('Total paid', formatNaira(d.amountPaid));

    doc.moveDown(1);
    doc
      .fontSize(9)
      .fillColor(muted)
      .text(
        `Service charge breakdown: processing ${formatNaira(d.processingFee)} · Duevy ${formatNaira(d.duevyFee)}. ` +
          `The department receives the full ${formatNaira(d.netToSpace)}.`,
      );

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor(muted).text('Thank you for your payment. Duevy — duevy.app');

    doc.end();
  });
}
