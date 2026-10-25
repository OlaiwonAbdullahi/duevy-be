# Kredi Pay and Didit

How Duevy collects dues, pays reps out, and verifies reps. Code: `src/providers/payment/kredi/` and `src/providers/identity/didit/`, behind the `PaymentProvider` and `IdentityVerifier` interfaces.

## The model: pooled money, per-space ledger

- Every student payment lands in **Duevy's Kredi merchant account**. Kredi keeps a flat ₦20 per payment.
- Each space's append-only **ledger** says how much of that pool is the space's. Withdrawals are checked against the ledger, never against a Kredi balance.
- Withdrawals are **Kredi Payout V2** transfers from the merchant account to the beneficiary's bank. Duevy's withdrawal fee is debited from the space's ledger and simply stays in the merchant account.
- Each verified rep is also a **Kredi customer** (BVN-backed, with its own NUBAN). That is Kredi's record of who the rep is; no money moves through it. V2 can only pay from the merchant account (or a sub-merchant, which needs CAC documents), so money is not routed through rep wallets.
- `GET /v1/admin/health` compares the sum of all ledgers with the merchant account's `availableBalance`. The merchant account also holds Duevy's fees, so it should always be the larger; a shortfall marks the platform unhealthy.

## Pricing

| | Student pays | Duevy's cost | Code |
|---|---|---|---|
| Checkout | 1.5% of the dues + ₦20, capped at ₦250, on top | ₦20 | `checkoutFee` |
| Withdrawal under ₦10,000 | ₦50, deducted | ₦10–₦25 | `withdrawalFee` |
| ₦10,000 to ₦50,000 | ₦120 | about ₦75 (₦25 + stamp duty) | |
| Above ₦50,000 | ₦200 | about ₦100 (₦50 + stamp duty) | |

Kredi's costs live in `krediPayoutCostKobo` and `KREDI_INWARD_COST_KOBO` (reporting only). Admin revenue is the fees net of those costs (`Payout.feeMarginKobo`). Intra-Kredi transfers are free. Partner discounts reduce the withdrawal fee only.

## Checkout

1. `POST /api/link/generate` with `transaction_ref` = our checkout reference, `amount` = face + fee (naira), `webhook_url` = `${APP_BASE_URL}/v1/webhooks/kredi`, `redirect_url` = the pay page. The student is redirected to the returned link.
2. Kredi posts a **collection webhook** to that URL: `merchantRef` (our reference), `amount`/`amountReceived`, `status: "successful"`, `remitReference` (one per transfer).
3. The checkout service compares the amount with the total: equal → paid; less → underpaid (no due marked paid, admins notified); more → paid with the excess flagged; after expiry → paid and flagged. A second, different `remitReference` into a paid checkout is flagged for a refund.
4. Backstop: reconciliation polls `GET /api/payment?keyword=<reference>` every minute for checkouts pending over 2 minutes; a row with `transaction_completion = 1` is paid.

## Withdrawal

1. The ledger is debited (net + fee) under the space lock, and the payout copies the destination (bank code, encrypted account number, the bank's name).
2. `GET /api/kredipay/nameenquiry` runs again. A different holder → `ACCOUNT_CHANGED`, the withdrawal fails and the balance is restored. Name enquiry also returns the holder's BVN and KYC level, which V2 needs; neither is stored.
3. `POST /api/kredipay/fundtransfer` with `transaction_reference` = our payout reference. `responseCode "00"` → succeeded.
4. A reused reference is refused by Kredi ("Duplicate transaction reference"), so a retry after a timeout can't pay twice; the provider reads the first attempt's outcome instead.
5. Outcome: the payout webhook (`transactionStatus.code` 200 / 401), or TSQ `GET /api/kredipay/transactions/{ref}` with `GET /api/v2/transactions/search?yourReference=` as the fallback. Without a final answer the payout stays `processing`; it is never failed on a guess.

## Rep verification

| Step | Call | Notes |
|---|---|---|
| Phone | Didit `POST /v3/phone/send/`, `POST /v3/phone/check/` | 6-digit code, 5-minute life. VoIP and disposable numbers declined. One verified number per account (`users.verifiedPhone` is unique). Resend after 60s, 5 per hour; Didit also caps 4 per number per hour. |
| BVN | Didit `POST /v3/database-validation/` | `issuing_state: "NGA"`, `bvn`, names, date of birth, `consent: true`. Only `full_match` + `Approved` passes. A mismatch counts toward the 3-attempt lock; an unknown BVN or an unavailable registry doesn't. One BVN per rep (`users.bvnHash`, HMAC-SHA256 with `BVN_HASH_PEPPER`). |
| Kredi | `POST /api/wallet/customers/create` | Only after both Didit checks. Sends the verified phone (local format) and the matched BVN. If Kredi is down, the BVN match is kept so resubmitting doesn't re-bill Didit. |
| Admin | — | Unchanged: an admin approves the student ID card and the rep application. A space collects only after that. |

The BVN, date of birth and codes are never stored or logged. NIN is no longer collected.

## Webhook security

`signature-key` = SHA-512 hex of `"<amount>-<secret>-<reference>"`, compared in constant time against the current and previous secret. There is no timestamp, so replays are stopped by deduplicating on Kredi's references (`collection:<remitReference>`, `payout:<merchantReference>:<code>`) and by the idempotent, row-locked handlers. Every event is also cross-checked by reconciliation.

## Configuration

`KREDI_BASE_URL` (test: `https://walletv2-api.test.kredimfb.com`), `KREDI_API_KEY`, `KREDI_AUTH_TOKEN`, `KREDI_WEBHOOK_SECRET`, `DIDIT_API_KEY`, `DIDIT_PHONE_CHANNEL`, `DIDIT_BVN_SERVICE`, `BVN_HASH_PEPPER`. See `.env.example`. On the Kredi dashboard, set the payout (outward) webhook to `https://<api>/v1/webhooks/kredi` with the same secret.

## Open questions

Each is a one-place change once answered.

**Kredi**

1. The live API base URL.
2. Which secret signs webhooks (the dashboard webhook secret or the API secret), and how the amount is rendered in the hashed string. We accept `"2.00"`, `"2"` and the raw JSON value (`signature.ts`); fire `POST /api/webhook/test` at the sandbox to pin it down.
3. The exact stamp duty on transfers of ₦10,000 and above (assumed ₦50 in `krediPayoutCostKobo`).
4. Whether `beneficiary_bvn` is strictly required on V2 `fundtransfer` (some banks' name enquiry returns none) and whether `beneficiary_kyc_level` is.
5. What the payment log's `transaction_status` and `transaction_completion` values mean (we treat `transaction_completion = 1` as paid), how long a payment link lives, how the hosted page handles under- and overpayment, whether a link can be regenerated for the same `transaction_ref`, and whether the page also takes cards (a different cost).
6. Whether customer creation validates the BVN against the name. Didit checks it first, so this only affects error handling.

**Didit**

1. The Nigeria BVN `service_id` to pin in `DIDIT_BVN_SERVICE` (unpinned runs the country default, which may be NIN-based), and whether it requires `consent`.
2. Whether `source_data` returns the phone number on the BVN record; if so, also require it to match the verified phone.
3. SMS deliverability to Nigerian numbers, or whether WhatsApp (Didit's default) is better.
