import PDFDocument from 'pdfkit';
import { formatNaira } from './money';

interface ReceiptData {
  reference: string;
  title: string;
  spaceName: string;
  payerName: string;
  amountPaid: number;
  monnifyFee: number;
  duevyFee: number;
  netToSpace: number;
  paidAt: Date;
  method: string;
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
    row('Due amount', formatNaira(d.netToSpace));
    row('Processing fee (3%)', formatNaira(d.monnifyFee + d.duevyFee));
    row('Total paid', formatNaira(d.amountPaid));

    doc.moveDown(1);
    doc
      .fontSize(9)
      .fillColor(muted)
      .text(
        `Processing fee breakdown: Monnify ${formatNaira(d.monnifyFee)} · Duevy ${formatNaira(d.duevyFee)}. ` +
          `The department receives the full ${formatNaira(d.netToSpace)}.`,
      );

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor(muted).text('Thank you for your payment. Duevy — duevy.app');

    doc.end();
  });
}
