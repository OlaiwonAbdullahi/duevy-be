import PDFDocument from 'pdfkit';

/**
 * Render a simple tabular report as a PDF buffer (§14.9, `format: "pdf"`).
 * Rows are plain cell arrays — same shape the CSV export uses — with the
 * first row treated as the header.
 */
export function renderTablePdf(title: string, rows: (string | number | null)[][]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#1b2520';
    const muted = '#7a847f';
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fontSize(16).fillColor(ink).text(title);
    doc.moveDown(1);

    const [header, ...body] = rows;
    if (header) {
      const colWidth = usableWidth / header.length;

      const renderRow = (cells: (string | number | null)[], bold: boolean) => {
        const y = doc.y;
        cells.forEach((cell, i) => {
          doc
            .fontSize(9)
            .fillColor(bold ? ink : muted)
            .font(bold ? 'Helvetica-Bold' : 'Helvetica')
            .text(cell === null ? '' : String(cell), doc.page.margins.left + i * colWidth, y, {
              width: colWidth - 8,
            });
        });
        doc.moveDown(0.5);
      };

      renderRow(header, true);
      doc
        .strokeColor(muted)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(0.3);

      for (const row of body) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage({ size: 'A4', margin: 40, layout: 'landscape' });
        renderRow(row, false);
      }
    }

    doc.end();
  });
}
