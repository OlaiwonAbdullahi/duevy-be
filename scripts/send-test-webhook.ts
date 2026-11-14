/**
 * Send a correctly signed webhook to a running API, for local testing against
 * PAYMENT_PROVIDER=fake (the fake rail's wire format and HMAC scheme, see
 * src/providers/payment/fake/wire.ts; secret = WEBHOOK_SECRET).
 *
 *   npm run webhook:test -- paid      DVY-XXXX-XXXX <accountNumber> <amountNaira>
 *   npm run webhook:test -- credited  <spaceId> <spaceAccountNumber> <amountNaira>
 *   npm run webhook:test -- transfer  WD-2026-XXXXXX|SWP2026XXXXXXXX <Success|Failed>
 *
 * Remember the handlers don't trust the event: they ask the provider what
 * happened. Against the fake provider, set its state first (see the tests).
 *
 * Options (env): WEBHOOK_URL (default http://localhost:$PORT/v1/webhooks/interswitch),
 * WEBHOOK_SECRET (default whsec_fake), EVENT_ID (reuse one to test duplicate delivery).
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { computeFakeSignature, SPACE_ACCOUNT_PREFIX } from '../src/providers/payment/fake/wire';

const [kind, ref, a, b] = process.argv.slice(2);
const secret = process.env.WEBHOOK_SECRET ?? 'whsec_fake';
const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/v1/webhooks/interswitch`;

function usage(): never {
  console.error('usage: send-test-webhook <paid|credited|transfer> <reference|spaceId> [accountNumber|status] [amountNaira]');
  process.exit(1);
}
if (!kind || !ref) usage();

const wire = (r: string) => r.replace(/[^A-Za-z0-9]/g, '');
const kobo = (v: string | undefined) => Math.round(Number(v ?? 0) * 100);

function credit(accountNumber: string, accountRequestReference: string, amountNaira: string | undefined) {
  return {
    eventId: process.env.EVENT_ID ?? randomUUID(),
    eventType: 'new_transaction',
    data: {
      id: randomUUID(),
      transactionReference: randomUUID().replace(/-/g, '').toUpperCase(),
      accountNumber,
      accountName: 'Duevy',
      accountRequestReference,
      amount: kobo(amountNaira),
      senderName: 'TEST SENDER',
      senderAccountNumber: '0123456789',
      narration: 'test',
      transactionType: 'Credit',
      transactionDate: new Date().toISOString(),
    },
  };
}

function build(): unknown {
  switch (kind) {
    case 'paid':
      if (!a || !b) usage();
      return credit(a, wire(ref), b);
    case 'credited':
      if (!a || !b) usage();
      return credit(a, `${SPACE_ACCOUNT_PREFIX}${wire(ref)}`, b);
    case 'transfer':
      return {
        eventId: process.env.EVENT_ID ?? randomUUID(),
        eventType: 'transfer_response',
        data: { requestReference: wire(ref), sessionId: randomUUID().replace(/-/g, ''), status: a ?? 'Success' },
      };
    default:
      usage();
  }
}

async function main() {
  const body = JSON.stringify(build());
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Signature: computeFakeSignature(secret, body) },
    body,
  });
  console.log(`${res.status} ${await res.text()}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
