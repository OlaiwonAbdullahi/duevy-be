/**
 * Send a correctly signed Kredi-format webhook to a running API, for local
 * testing (works against PAYMENT_PROVIDER=fake or kredi — both verify the
 * real Kredi signature scheme with KREDI_WEBHOOK_SECRET).
 *
 *   npm run webhook:test -- paid          DVY-XXXX-XXXX <amountNaira>
 *   npm run webhook:test -- payout-paid   WD-2026-XXXXXX <netNaira>
 *   npm run webhook:test -- payout-failed WD-2026-XXXXXX <netNaira>
 *
 * A short `paid` amount is recorded as an underpayment, a larger one as an
 * overpayment — the checkout service compares it to the checkout total.
 *
 * Options (env): WEBHOOK_URL (default http://localhost:$PORT/v1/webhooks/kredi),
 * REMIT_REFERENCE (reuse one to test duplicate delivery).
 */
import 'dotenv/config';
import { randomInt } from 'crypto';
import { computeKrediSignature } from '../src/providers/payment/kredi/signature';

const [kind, ref, amount] = process.argv.slice(2);
const secret = process.env.KREDI_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/v1/webhooks/kredi`;

function usage(): never {
  console.error('usage: send-test-webhook <paid|payout-paid|payout-failed> <reference> <amountNaira>');
  process.exit(1);
}
if (!kind || !ref || !amount) usage();
if (!secret) {
  console.error('KREDI_WEBHOOK_SECRET is not set');
  process.exit(1);
}

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
const now = new Date().toISOString();

function build(): { body: Record<string, unknown>; signedAmount: string; signedRef: string } {
  switch (kind) {
    case 'paid': {
      const remitReference = process.env.REMIT_REFERENCE ?? digits(30);
      const value = Number(amount).toFixed(2);
      return {
        signedAmount: value,
        signedRef: remitReference,
        body: {
          merchantRef: ref,
          amount: value,
          amountReceived: value,
          status: 'successful',
          narration: 'CR|FRM TRF test payment',
          sessionId: digits(30),
          senderAccountName: 'TEST PAYER',
          senderAccountNumber: '0123456789',
          senderBank: 'ACCESS BANK',
          senderBankCode: '000014',
          remitReference,
          accountType: 'collection',
          customer: { customerName: 'Test Payer', customerEmail: '', customerPhone: '' },
          createdAt: now,
          receivedAt: now,
        },
      };
    }
    case 'payout-paid':
    case 'payout-failed': {
      const code = kind === 'payout-paid' ? 200 : 401;
      const value = Number(amount);
      return {
        signedAmount: String(value),
        signedRef: ref,
        body: {
          id: `test-${digits(8)}`,
          krediReference: `KRDM_${digits(12)}`,
          merchantReference: ref,
          beneficiaryName: 'TEST BENEFICIARY',
          beneficiaryAccountNumber: '0123456789',
          beneficiaryBankCode: '000013',
          transactionAmount: value,
          narration: `Duevy payout ${ref}`,
          transactionStatus: { code, status_message: code === 200 ? 'Successful' : 'Failed' },
          transactionStatusMessage: code === 200 ? 'Approved' : 'Test failure',
          responseCode: code === 200 ? '00' : '91',
          createdAt: now,
        },
      };
    }
    default:
      usage();
  }
}

async function main() {
  const { body, signedAmount, signedRef } = build();
  const raw = JSON.stringify(body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'signature-key': computeKrediSignature(signedAmount, secret!, signedRef) },
    body: raw,
  });
  console.log(`${res.status} ${await res.text()}`);
  console.log(raw);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
