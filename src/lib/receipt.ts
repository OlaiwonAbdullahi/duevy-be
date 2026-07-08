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
 * Render a payment receipt as HTML. Mirrors the client's receipt layout so the
 * numbers always match the ledger.
 *
 * NOTE: the spec (§6.5/§9.3) calls for `application/pdf`. This returns HTML for
 * now; swapping in a PDF renderer (e.g. pdfkit) is a drop-in follow-up.
 */
export function renderReceiptHtml(d: ReceiptData): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#7a847f">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600">${value}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Receipt ${d.reference}</title></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1b2520;max-width:520px;margin:40px auto;padding:0 20px">
  <div style="border-bottom:3px solid #0b6e4f;padding-bottom:12px;margin-bottom:20px">
    <div style="font-size:20px;font-weight:700">Duevy.</div>
    <div style="color:#7a847f;font-size:13px">Payment Receipt</div>
  </div>
  <h1 style="font-size:18px;margin:0 0 4px">${d.title}</h1>
  <p style="color:#7a847f;margin:0 0 20px">${d.spaceName}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${row('Reference', d.reference)}
    ${row('Paid by', d.payerName)}
    ${row('Date', d.paidAt.toISOString())}
    ${row('Method', d.method)}
    ${row('Due amount', formatNaira(d.netToSpace))}
    ${row('Processing fee (3%)', formatNaira(d.monnifyFee + d.duevyFee))}
    ${row('Total paid', formatNaira(d.amountPaid))}
  </table>
  <p style="color:#7a847f;font-size:12px;margin-top:8px">
    Processing fee breakdown: Monnify ${formatNaira(d.monnifyFee)} · Duevy ${formatNaira(d.duevyFee)}.
    The department receives the full ${formatNaira(d.netToSpace)}.
  </p>
  <p style="color:#7a847f;font-size:12px;margin-top:24px">Thank you for your payment. Duevy — duevy.app</p>
</body></html>`;
}
