# Interswitch integration

The hackathon payment rail (Interswitch Discovery Series). Set
`PAYMENT_PROVIDER=interswitch` to use it. It implements the same
`PaymentProvider` interface as 9jaPay (`src/providers/payment/types.ts`), so the
ledger, checkout, sweep, withdrawal and reconciliation machinery is unchanged —
the ledger stays the single source of truth and every amount stays in **kobo**.

Code: `src/providers/payment/interswitch/` — `client.ts` (Passport OAuth2 +
fetch), `InterswitchProvider.ts`, `events.ts` (webhook → `ProviderEvent`),
`signature.ts`.

## How money moves

| Step | What happens | Where |
|---|---|---|
| Student pays | **IPG Web Checkout** (hosted popup showing **all** methods enabled for the merchant — card, bank transfer, USSD, QR, …). The checkout returns the inline params; the one-time "account" is the per-attempt `txn_ref` (= our checkout reference, non-alphanumerics stripped), created and stored **before** the popup opens. | `createGatewayCheckout` → `serializeCheckout.gateway` |
| Confirm | The server requeries `GET /collections/api/v1/gettransaction.json` and accepts the payment **only when `ResponseCode` is `00` and the amount matches** (whatever method was used). Runs from the pay-page poll, the `/public/pay/callback` redirect, the webhook, and the reconciliation backstop — all idempotent, so a repeat makes **one** ledger entry. | `verifyGatewayCheckout` → `fulfilCheckout` |
| Space account | Each space has a permanent **Interswitch Virtual Account** (direct transfers in become `direct_deposit` ledger credits via webhook). | `createSpaceAccount`, `listAccountCredits` |
| Withdrawal | Space account → beneficiary bank via the **Payouts API** (`singleCall`). | `initiateTransfer`, `getTransfer` |

Checklist behaviours covered: a declined/abandoned payment → stays unpaid; closed popup → stays
pending (expires later); repeated confirmation → one ledger entry; `txn_ref`
server-created, unique and stored before the popup; amount in kobo; currency 566.

## Configuration (`.env`)

```
PAYMENT_PROVIDER=interswitch
INTERSWITCH_ENV=test                 # test | live
INTERSWITCH_CLIENT_ID=...            # Quickteller Business → Developer Tools
INTERSWITCH_CLIENT_SECRET=...
INTERSWITCH_MERCHANT_CODE=MX6072     # LIVE: MX153376
INTERSWITCH_PAY_ITEM_ID=9405967     # LIVE: your team's Pay Item ID
INTERSWITCH_CURRENCY=566
INTERSWITCH_WEBHOOK_SECRET=...       # required in live
# base URLs default to TEST; set LIVE hosts for production
INTERSWITCH_INLINE_CHECKOUT_URL=https://newwebpay.qa.interswitchng.com/inline-checkout.js
```

Register the webhook URL `https://<api>/v1/webhooks/interswitch` in the
Quickteller Business dashboard. The `site_redirect_url` the frontend passes to
the popup must be a real URL — use `https://<api>/v1/public/pay/callback?ref=<reference>`
(built for you by `serializeCheckout.gateway.redirectUrl`).

## Frontend: opening the popup

`GET /v1/public/dues/:dueId` then `POST /v1/public/dues/:dueId/checkout` returns
a checkout whose `gateway` object has everything the inline script needs. The
popup itself shows every method enabled for the merchant (card, bank transfer,
USSD, QR, …) — nothing here restricts it to card:

```js
const g = checkout.gateway;
// load g.scriptUrl (inline-checkout.js), then:
window.webpayCheckout({
  merchant_code: g.merchantCode,
  pay_item_id: g.payItemId,
  txn_ref: g.txnRef,
  amount: g.amountKobo,        // kobo
  currency: g.currency,        // 566
  mode: g.mode,                // TEST | LIVE
  site_redirect_url: g.redirectUrl,
  onComplete: () => { /* poll GET /v1/payments/:reference/status or /public/checkouts/:ref */ },
});
```

Which methods appear is configured on the merchant/pay-item in the Quickteller
Business dashboard. Verification is always server-side; the client callback is
only a nudge.

## Sandbox testing without going through the popup

In `INTERSWITCH_ENV=test` the dev route `POST /v1/dev/simulate-payment { reference }`
marks a pending checkout paid through the same idempotent path a real `00`
would, so the flow can be demoed without completing a live payment. (404 in
production.)

## Open items to confirm in the Quickteller Business portal

The gateway flow (`createGatewayCheckout` + `gettransaction.json`) is grounded in the
docs. These other calls use best-effort field names, isolated to `client.ts` /
`InterswitchProvider.ts` — confirm and adjust if a shape differs:

- Virtual Account **create** endpoint + payload and the credit **webhook** event
  name & signature scheme.
- **Payouts** request/response fields (`singleCall`), and the name-enquiry and
  bank-list endpoints.
- The current **Passport** host for your environment.
