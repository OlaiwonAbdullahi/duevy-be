/**
 * Send a correctly signed Bachs-format webhook to a running API, for local
 * testing (works against PAYMENT_PROVIDER=fake or bachs — both verify the
 * real Bachs signature scheme with BACHS_WEBHOOK_SECRET).
 *
 *   npm run webhook:test -- paid      DVY-XXXX-XXXX [amountNaira]
 *   npm run webhook:test -- overpaid  DVY-XXXX-XXXX <receivedNaira> <expectedNaira>
 *   npm run webhook:test -- underpaid DVY-XXXX-XXXX <paidNaira> <expectedNaira>
 *   npm run webhook:test -- expired   DVY-XXXX-XXXX
 *   npm run webhook:test -- payout-paid   WD-2026-XXXXXX
 *   npm run webhook:test -- payout-failed WD-2026-XXXXXX
 *   npm run webhook:test -- identity  acct_...
 *
 * Options (env): WEBHOOK_URL (default http://localhost:$PORT/v1/webhooks/bachs),
 * EVENT_ID (reuse one to test duplicate delivery).
 *
 * For amounts, `paid` without an amount reads the checkout's total from
 * GET /v1/payments/:reference — pass it explicitly when you have no token.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { computeBachsSignature } from '../src/providers/payment/bachs/signature';

const [kind, ref, a, b] = process.argv.slice(2);
const secret = process.env.BACHS_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/v1/webhooks/bachs`;

function usage(): never {
  console.error('usage: send-test-webhook <paid|overpaid|underpaid|expired|payout-paid|payout-failed|identity> <reference|accountId> [amounts]');
  process.exit(1);
}
if (!kind || !ref) usage();
if (!secret) {
  console.error('BACHS_WEBHOOK_SECRET is not set');
  process.exit(1);
}

const naira = (v: string | undefined) => (v ? Number(v).toFixed(2) : undefined);

function build(): { type: string; data: Record<string, unknown>; account?: string } {
  switch (kind) {
    case 'paid':
      if (!a) {
        console.error('pass the amount in naira (the checkout total), e.g. 5120');
        process.exit(1);
      }
      return { type: 'collection.succeeded', data: { reference: ref, status: 'SUCCEEDED', amount: naira(a), currency: 'NGN' } };
    case 'overpaid':
      return {
        type: 'collection.succeeded',
        data: {
          reference: ref,
          status: 'OVERPAID',
          amount: naira(b),
          expected_amount: naira(b),
          received_amount: naira(a),
          overpaid_amount: (Number(a) - Number(b)).toFixed(2),
          currency: 'NGN',
        },
      };
    case 'underpaid':
      return {
        type: 'collection.underpaid',
        data: { reference: ref, status: 'UNDERPAID', amount_paid: naira(a), amount_expected: naira(b), currency: 'NGN' },
      };
    case 'expired':
      return { type: 'collection.failed', data: { reference: ref, status: 'EXPIRED' } };
    case 'payout-paid':
      return { type: 'payout.paid', data: { reference: ref, withdrawal_id: `pay_${ref}`, status: 'completed', withdrawal_fee: '50.00' } };
    case 'payout-failed':
      return { type: 'payout.failed', data: { reference: ref, withdrawal_id: `pay_${ref}`, status: 'failed', failure_reason: 'Test failure' } };
    case 'identity':
      return { type: 'capability.updated', account: ref, data: { account: ref, capability: 'payouts', status: 'active', requested: true } };
    default:
      usage();
  }
}

async function main() {
  const event = build();
  const body = JSON.stringify({
    id: process.env.EVENT_ID ?? `evt_test_${randomUUID().replace(/-/g, '')}`,
    created_at: new Date().toISOString(),
    organization_id: 'acct_platform',
    ...event,
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = computeBachsSignature(secret!, t, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bachs-Signature-V2': `t=${t},v1=${sig}` },
    body,
  });
  console.log(`${res.status} ${await res.text()}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
