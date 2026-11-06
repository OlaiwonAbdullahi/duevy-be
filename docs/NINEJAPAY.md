# 9jaPay integration

Duevy collects dues through 9jaPay virtual accounts ([docs.9japay.com](https://docs.9japay.com)) and checks rep identity with Didit ([docs.didit.me](https://docs.didit.me)). This replaces Bachs Connect ([`BACHS.md`](BACHS.md), kept for history).

## Why this shape

Under Bachs every rep held their own provider account, so every rep had to clear the provider's KYC. On a NIN-only tier those accounts are capped (CBN Tier 1: ₦300,000 balance, ₦50,000 a day), far below what a department collects. Here no rep holds an account:

- Every account sits under **Duevy's own 9jaPay business**, so its limits are Duevy's, not a student's.
- The **space (department) owns the money**. Each space has its own permanent 9jaPay account; reps only manage it.
- Rep KYC is just **NIN + date of birth** (Didit, against NIMC) plus the student ID card an admin reviews. It records who is accountable for a space, not who owns the funds.

## How money moves

| Step | What happens | Code |
|---|---|---|
| 1. Checkout | A one-time (transient) account for exactly face + 1.5%, single payment, expires with the checkout. `requestReference` = the checkout reference without punctuation. | `checkout.service` → `createCollectionAccount` |
| 2. Payment | Settles straight into Duevy's business account. `new_transaction` arrives; Duevy reads the account's transactions back (`GET /v1/api/transactions?account-number=`) and credits the space's ledger with the face amount. | `webhookProcessor` → `confirmReceivedPayment` |
| 3. Sweep | Once a Lagos day from 02:00, and whenever a withdrawal needs it, the space's collections move from the business account to the space's own account (`POST /v1/api/transfers`). The ledger doesn't change. | `sweep.service` |
| 4. Withdrawal | From the space's account to a beneficiary saved on the space (`POST /v1/api/transfers/virtual-account`). If the space's account doesn't hold enough yet, a sweep goes first and the withdrawal waits `pending`. | `withdrawal.service` |

Where a space's money is:

- **Unswept** = its 9jaPay collections (`due_payment` ledger credits on 9jaPay checkouts) − its sweeps that haven't failed.
- **In the space's account** = ledger balance − unswept.

A manual credit by an admin moves no money. It is counted as already in the space's account, so a withdrawal against it fails at the bank and is restored.

## Fees

| Who pays | What | Covers |
|---|---|---|
| Student | Face + **1.5%** (rounded up), shown separately | 9jaPay's 0.5% (capped at ₦750) + ₦50 stamp duty from ₦10,000 on the student's transfer, **and** the same charges again when the sweep lands in the space's account, plus the sweep's transfer fee |
| Space | **₦10 / ₦15 / ₦20** per withdrawal (under ₦5,000 / under ₦100,000 / from ₦100,000), deducted from it | 9jaPay's transfer charge |

Duevy pays for sweeps out of the 1.5%. `Sweep.feeKobo` is for Duevy's own reporting and is not on any space's ledger. Partner discounts still apply to the withdrawal fee; Duevy covers what they take off.

## Limits

Each space's permanent account may move at most **₦10,000,000 a day**. Duevy counts sweeps in **and** withdrawals out against it (the safe reading; confirm with 9jaPay), on Lagos days.

- A sweep moves at most what's left today. The rest goes the next day.
- A withdrawal that would pass it (including any sweep it needs) is refused with `422 DAILY_LIMIT_EXCEEDED` before anything is debited.

## Webhooks

`POST /v1/webhooks/9japay`. Register it in the dashboard (Settings → Developer), test and live separately.

- **Signature:** `Signature: base64(HMAC-SHA256(SECRET_KEY, raw body))`.
- **No timestamp, so no replay protection.** Every event is deduplicated by id (`eventId`, or `new_transaction:<data.id>`), and **no handler acts on the body**: each asks 9jaPay (transactions list, TSQ) and applies that.
- 9jaPay resends up to 10 times until it gets a 200.
- `new_transaction` doesn't say which kind of account was credited. Space accounts are created with a request reference starting `SPACE`, and that prefix is how they're told apart.
- `transfer_response` is only sent for transfers that started `PROCESSING`. Ones that answered `SUCCESS` or `FAILED` up front are settled from that answer.

## References

9jaPay accepts letters and digits only. Duevy sends its references with everything else stripped (`DVY-7KQ2-MN4X` → `DVY7KQ2MN4X`, `WD-2026-ABCDEF` → `WD2026ABCDEF`) and stores that form (`Checkout.providerCheckoutId`, `Payout.providerPayoutId`, `Sweep.providerReference`) **before** sending. Events can then always be matched, even after a timeout. A duplicate reference (`26`) is treated as "already sent: ask TSQ".

## Rep KYC (Didit)

`POST https://verification.didit.me/v3/database-validation/` (multipart, `x-api-key`) with `services=nga_national_id`, `issuing_state=NGA`, the rep's first and last name, `national_id`, `date_of_birth` and `vendor_data` = our user id. One synchronous call.

| `outcome_code` | Result |
|---|---|
| `MATCH` | `verified` |
| `PARTIAL_MATCH` | `pending` + admin review (`/admin/kyc/nin-reviews`) |
| `NO_MATCH` (or a 400) | `422`, a failed attempt (3 → 24-hour lock) |
| `REGISTRY_UNAVAILABLE` / `REGISTRY_ERROR` / 5xx / timeout | `503`, not an attempt |

Only the outcome, the match score and Didit's `request_id` are stored. The NIN and date of birth never are.

## Cutover from Bachs (hard cutover)

1. **Turn off new checkouts** and wait for open ones to expire (`CHECKOUT_EXPIRY_MINUTES`).
2. **Pay out every space's Bachs balance to zero**, and resolve any Bachs payout still `pending`/`processing` (`GET /admin/payouts?status=processing`). The ledger carries over: a balance left at Bachs would show in Duevy with the money not in 9jaPay. The 9jaPay withdrawal would then fail at the bank and be restored, which is safe but confusing.
3. **Set the env** (`NINEJAPAY_*`, `DIDIT_*`, `PAYMENT_PROVIDER=ninejapay`), deploy, run `npm run db:deploy`. The migration (`20261106120000_ninejapay_didit`) is data-preserving:
   - Reps verified under Bachs stay verified. With an approved student ID they can collect straight away; nobody re-verifies.
   - Reps who were `pending` or `rejected` at Bachs are reset to `unverified` with a clean slate, and verify through Didit.
   - Existing checkouts, payouts and webhook events keep `provider = 'bachs'`; reconciliation only touches `ninejapay` rows.
4. **Space accounts** open on their own: the reconciliation job (every minute, from 02:00 Lagos) opens a permanent account for any space without one, 25 at a time. A space can't withdraw until it has one (`409 SPACE_ACCOUNT_NOT_READY`).
5. **Register the webhook** `https://api.duevy.app/v1/webhooks/9japay` as the Live Webhook URL.
6. **Smoke test** with real money: a small payment, a sweep, a small withdrawal. Then reopen checkouts.
7. `POST /v1/webhooks/bachs` keeps answering `200` (and dropping events) until Bachs is switched off.

## Sandbox findings (2026-11-06)

Tested against `https://developer.test.9japay.com` with Duevy's test keys:

| Call | Result |
|---|---|
| Bank list | 94 banks; 9jaPay itself is `090629` "9jaPay MFB". |
| Name enquiry, collection account | "Duevy Labs Ltd-test-account". |
| Name enquiry, unknown account | **HTTP 500**, `06` "Unable to validate account number!" — handled as unverifiable, not an outage. |
| One-time account | Created; 9jaPay names it **"DUEVY COLLECTION ACCOUNT"** (what students see) and returns its own `expiresAt`, which Duevy uses. |
| Its transactions | `GET /v1/api/transactions?account-number=` works; response also carries `totalCreditSum` etc. |
| Space account | Created. Name enquiry shows **"DUEVY/<accountName>"**: 9jaPay prefixes the business name, so Duevy sends just the space name and stores the name the bank shows. `GET /v1/api/virtual-accounts/{number}` on a permanent account returned 500, so Duevy doesn't rely on it. |
| Sweep with no funds | HTTP 400, `09` "insufficient funds" — the sweep fails and the money counts as unswept. TSQ then reports `Failed`. |
| TSQ, never sent | HTTP 404, `25` "No record found." — sent again. |
| `simulate-deposit` | `27` "The auth key is invalid" with both the Test Secret Key and the Test API Key. |

The API key is a GUID; 9jaPay refuses anything else with "{Api Key} must be valid GUID."

## Limits (from the dashboard)

- **₦1,000,000 per transfer** and **₦10,000,000 of transfers a day for the whole business**, for now.
- Not handled yet: a sweep or withdrawal over ₦1M is refused by 9jaPay (the sweep fails and stays unswept; the withdrawal fails and is restored). Duevy's own ₦10M check is per space account, not business-wide. See the recommendation in the PR: split at ₦1M, a platform-wide daily budget, sweep only for withdrawals while the cap stands.

## Open questions for 9jaPay

1. **The sandbox `authKey` for `simulate-deposit`.** It isn't the API key or the secret key, and the dashboard doesn't show one. Without it no inflow (and so no `new_transaction` webhook) can be tested in the sandbox.
2. **Live base URL.**
3. Do transfers **out of a space's own account** (`/transfers/virtual-account`) count toward the business's ₦10M a day? If they do, every swept naira is counted twice.
4. Must `senderAccountName` match the collection account's name exactly? Duevy sidesteps it: the name is taken from name enquiry on the collection account ("Duevy Labs Ltd-test-account" in the sandbox).
5. Is `transfer_response`'s `requestReference` the `paymentReference` we sent? The handler assumes so and also accepts `paymentReference`.
6. TSQ for a transfer still processing: what does `data.status` say? Duevy treats anything other than Success/Failed as processing.
7. If opening a space account times out, a retry with the same reference is refused as a duplicate, and the account number from the first attempt is unknown. Is there a lookup by request reference?
