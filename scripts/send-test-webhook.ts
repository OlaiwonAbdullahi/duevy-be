/**
 * Send a correctly signed Bank78-format (merchant API v2) webhook to a running
 * API, for local testing. Signed with BANK78_WEBHOOK_SECRET, exactly as Bank78
 * signs deliveries.
 *
 *   npm run webhook:test -- paid         DVY-XXXX-XXXX <amountNaira>
 *   npm run webhook:test -- payout-paid  WD-2026-XXXXXX [feeNaira]
 *   npm run webhook:test -- wrong-amount DVY-XXXX-XXXX <paidNaira> <expectedNaira>
 *
 * Options (env): WEBHOOK_URL (default http://localhost:$PORT/v1/webhooks/bank78),
 * SESSION_ID (reuse one to test duplicate delivery).
 *
 * `paid` needs the checkout total in naira (GET /v1/payments/:reference shows it).
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { computeBank78Signature } from '../src/providers/payment/bank78/signature';

const [kind, ref, a, b] = process.argv.slice(2);
const secret = process.env.BANK78_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/v1/webhooks/bank78`;
const sessionId = process.env.SESSION_ID ?? `100033${Date.now()}${randomUUID().replace(/\D/g, '').slice(0, 8)}`;

function usage(): never {
  console.error('usage: send-test-webhook <paid|payout-paid|wrong-amount> <reference> [amounts]');
  process.exit(1);
}
if (!kind || !ref) usage();
if (!secret) {
  console.error('BANK78_WEBHOOK_SECRET is not set');
  process.exit(1);
}

function build(): { eventType: string; data: Record<string, unknown> } {
  switch (kind) {
    case 'paid':
      if (!a) {
        console.error('pass the amount in naira (the checkout total), e.g. 5075');
        process.exit(1);
      }
      return {
        eventType: 'virtual-nuban-transaction-credit',
        data: {
          accountReference: ref,
          accountNumber: '7001646987',
          amount: Number(a),
          paymentDate: new Date().toISOString().slice(0, 19),
          sessionId,
          paymentReference: sessionId,
          transactionReference: sessionId,
          senderAccountNumber: '8084101999',
          senderAccountName: 'TEST PAYER',
          senderBank: 'Test Bank',
          notificationType: 'credit',
          status: 'transaction.success',
        },
      };
    case 'payout-paid':
      return {
        eventType: 'transfer.success',
        data: { reference: ref, sessionId, amount: 0, fee: Number(a ?? 50), status: 'success', responseCode: '00', currencyCode: 'NGN' },
      };
    case 'wrong-amount':
      return {
        eventType: 'virtual-nuban-transaction.failed',
        data: { accountReference: ref, sessionId, status: 'invalid_amount', failureReason: 'Transaction amount is invalid.', actualAmount: Number(a), expectedAmount: Number(b) },
      };
    default:
      usage();
  }
}

async function main() {
  const body = JSON.stringify(build());
  const t = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Source': 'BANK78',
      'X-Bank78-Webhook-Timestamp': String(t),
      'X-Bank78-Webhook-Signature-Version': 'v1',
      'X-Bank78-Webhook-Signature': computeBank78Signature(secret!, t, body),
    },
    body,
  });
  console.log(`${res.status} ${await res.text()}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
