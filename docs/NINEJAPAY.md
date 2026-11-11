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
| 3. Sweep | Once a Lagos day from 02:00, and on every withdrawal, all of the space's unswept collections move from the business account to the space's own account (`POST /v1/api/transfers`). The ledger doesn't change. | `sweep.service` |
| Direct deposit | Someone sends money straight to the space's own account number, not through a checkout. It is already in the space's account, so it's credited to the space as it is (ledger `direct_deposit`, no due attached) and never swept. Found from the credit webhook, or by reconciliation reading each space account every 6 hours. | `directDeposit.service` |
| 4. Withdrawal | From the space's account to a beneficiary saved on the space (`POST /v1/api/transfers/virtual-account`). Every withdrawal also sweeps all the space's unswept money (as far as the day's limits allow, in transfers of at most ₦1M). If the account doesn't hold enough yet, the withdrawal waits `pending` for the first of those sweeps, which covers it; otherwise it goes at once. | `withdrawal.service` |

Where a space's money is:

- **Unswept** = its 9jaPay collections (`due_payment` ledger credits on 9jaPay checkouts) − its sweeps that haven't failed.
- **In the space's account** = ledger balance − unswept. Direct deposits are in the ledger and never unswept.

A manual credit by an admin moves no money. It is counted as already in the space's account, so a withdrawal against it fails at the bank and is restored.

## Fees

| Who pays | What | Covers |
|---|---|---|
| Student | Face + **1.5%** (rounded up), shown separately | 9jaPay's 0.5% (capped at ₦750) + ₦50 stamp duty from ₦10,000 on the student's transfer, **and** the same charges again when the sweep lands in the space's account, plus the sweep's transfer fee |
| Space | **₦10 / ₦15 / ₦20** per withdrawal (under ₦5,000 / under ₦100,000 / from ₦100,000), deducted from it | 9jaPay's transfer charge |

Duevy pays for sweeps out of the 1.5%. `Sweep.feeKobo` is for Duevy's own reporting and is not on any space's ledger.

## Limits

Duevy's own, all on Lagos days and checked before anything is debited:

| Limit | Amount | Error |
|---|---|---|
| One withdrawal | ₦1,000 – ₦500,000 | `422 BELOW_MIN_PAYOUT` / `ABOVE_MAX_PAYOUT` |
| Withdrawn per space per day | ₦5,000,000 | `422 DAILY_LIMIT_EXCEEDED` |
| Moved through a space account per day (sweeps and direct deposits in + withdrawals out) | ₦10,000,000 | `422 DAILY_LIMIT_EXCEEDED` (withdrawals); a sweep stops there and the rest goes the next day |
| One sweep transfer | ₦1,000,000 | — a bigger sweep goes as several transfers |

A failed, reversed or cancelled withdrawal gives its share of the day back.

## Webhooks

`POST /v1/webhooks/9japay`. Register it in the dashboard (Settings → Developer), test and live separately.

- **Signature:** `Signature: base64(HMAC-SHA256(SECRET_KEY, raw body))`.
- **No timestamp, so no replay protection.** Every event is deduplicated by id (`eventId`, or `new_transaction:<data.id>`), and **no handler acts on the body**: each asks 9jaPay (transactions list, TSQ) and applies that.
- 9jaPay resends up to 10 times until it gets a 200.
- `new_transaction` doesn't say which kind of account was credited. Space accounts are created with a request reference starting `SPACE`, and that prefix is how they're told apart.
- Credits and debits on **Duevy's business account itself** are ignored: they name no checkout or space.
- A credit on a space account is told apart by 9jaPay's transaction list, not the event: `metadata.senderAccountNumber` = the business account is our sweep; the space account itself, or a narration containing "revers", is a bounced withdrawal (already restored in our books); anything else is a direct deposit.
- An authenticated body that isn't JSON is acknowledged (200) and logged, since resending it would never help.
- `transfer_response` is only sent for transfers that started `PROCESSING`. Ones that answered `SUCCESS` or `FAILED` up front are settled from that answer: `data.status` decides it (the envelope's status is the request's), and without it only `statusCode` `00` counts as done.
- A transfer TSQ says it has never heard of (`25`) is sent again under the same reference, for withdrawals as for sweeps. TSQ `Reversed` counts as failed.

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
| Space account | Created. Name enquiry shows **"DUEVY/<accountName>"**: 9jaPay prefixes the business name, so Duevy sends `<space name>-<3 consonants>` (unique across spaces, `src/lib/spaceAccountName.ts`) and stores the name the bank shows. Renaming uses `PATCH /v1/api/virtual-accounts/permanent/{accountNumber}` with `{ accountName, autoPayoutEnabled: false }` (auto-payout is always sent off so an update can't switch it on); it runs when a space is renamed, and `node dist/scripts/renameSpaceAccounts.js [--apply]` renames accounts opened before the suffix. Sending-account names are re-read every 10 minutes, so a rename reaches withdrawals within that window. `GET /v1/api/virtual-accounts/{number}` on a permanent account returned 500, so Duevy doesn't rely on it. |
| Sweep with no funds | HTTP 400, `09` "insufficient funds" — the sweep fails and the money counts as unswept. TSQ then reports `Failed`. |
| TSQ, never sent | HTTP 404, `25` "No record found." — sent again. |
| `simulate-deposit` | Needs the separate sandbox `authKey` (`NINEJAPAY_SANDBOX_AUTH_KEY`); the API and secret keys give `27` "The auth key is invalid". Body: `{ recipientAccountNumber, amount (kobo), authKey }`. A wrong amount or a closed account is refused (`25` "Recipient account is invalid", or a 500). Wrapped as `POST /v1/dev/simulate-deposit` (sandbox only). |

**Money in, sweep and withdrawal (2026-11-07, with the sandbox `authKey`):**

| Step | Result |
|---|---|
| Pay a one-time account the wrong amount | Refused at the bank: `09` "Amount is different from configured amount". So an underpayment can't reach us. |
| Pay it the exact amount | Credited. 9jaPay closes the account at once and moves the money to the collection account ("VIRTUAL ACCOUNT CLOSURE TRANSFER" debit). The collection account went up by the **full** amount: no fee taken from it. |
| Pay it again | Refused (`06`): single payment only. |
| **Reused account numbers** | The new checkout got **the same account number and id** as the previous day's. Its transaction list therefore holds earlier checkouts' payments too. Duevy only counts credits between the checkout's creation and its 9jaPay expiry (no slack after it), reads every page of the list, and records the paying credit's `transactionId` on the checkout (`providerTransactionId`, unique) so one credit can never pay two checkouts. A `new_transaction` is also checked against every pending checkout now holding that number, in case it still carries the earlier checkout's reference. |
| Transaction dates | `transactionDate` is Lagos time with **no offset** (`2026-11-07T08:35:38`), unlike `expiresAt` (UTC, `Z`). Read as UTC+1. |
| Sweep ₦1,000, collection → space account | `00` SUCCESS at once (no webhook needed); TSQ `Success`. The space account received the full ₦1,000: **a sweep is not charged as an incoming payment**. The collection account was debited ₦1,002: a ₦2 sandbox transfer fee, charged to the sender. |
| Withdrawal ₦500, space account → bank | `00` SUCCESS at once; TSQ `Success`. The space account went down by exactly ₦500. No fee showed on either account in the sandbox. |
| Narration over 50 characters (2026-11-08) | Refused: "Narration cannot be above 50 characters" (no money moves; the withdrawal fails and its debit is reversed). Narrations are now `Duevy/<space code> sent you NGN<amount>` (e.g. `Duevy/CSC sent you NGN3000`), built by `transferNarration` (src/lib/narration.ts): plain ASCII, at most ~30 characters. The sender's side reads "You sent NGN3000 to Abdullahi Olaiwon": that text is Duevy's (withdrawal `summary`, ledger line, notification), since a transfer carries one narration that both statements share. Our reference is not in the narration; it travels as the transfer's `paymentReference`. `fitNarration` in the provider is the safety net. |

The API key is a GUID; 9jaPay refuses anything else with "{Api Key} must be valid GUID."


## Limits (from the dashboard)

- **₦1,000,000 per transfer.** Withdrawals are capped at ₦500,000 and sweeps are split into ₦1M transfers.
- **₦10,000,000 of transfers a day per sending account** (to be raised soon):
  - **The business account** sends every sweep, so all spaces' sweeps in a Lagos day share its ₦10M (`NINEJAPAY_BUSINESS_DAILY_LIMIT_KOBO`; raise it there when 9jaPay does). The daily run stops at the limit and the rest is swept the next day. A withdrawal that would need a sweep past it is refused up front (`422 DAILY_LIMIT_EXCEEDED`), telling the rep what can still go today.
  - **Each space account** has its own ₦10M for withdrawals; they don't count against the business account. Duevy's own ₦5M per space per day sits inside it.

## Answered by 9jaPay and the API docs (2026-11-07)

- **Transfer fees** are charged to the sender **on top of** the amount; the recipient gets the full amount. A withdrawal debits the space's ledger the gross, sends the net (gross − ₦10/₦15/₦20), and 9jaPay takes net + its fee from the space account, which comes to the gross. A sweep's fee comes out of the business account, covered by the 1.5%.
- **One-time account lifetime** is ours to set: `timeToLive` is in seconds (Duevy sends the checkout's expiry), and `IsSinglePayment` closes it on the first payment. A number is only handed to another checkout after it closes, so payments are matched by window and claimed by `transactionId`.
- **Sender name:** name enquiry is the source for every sending account, the business account and each space account ("DUEVY/<space>"), cached per process.
- **`transfer_response`:** `data.requestReference` is "the unique identifier of the transfer request generated by the client": the `paymentReference` Duevy sent. Its `data.status` is the final status.
- **Statuses:** request status `SUCCESS` / `PROCESSING` / `FAILED` (outer `status`), transaction status `Success` / `Processing` / `Failed` (`data.status`, TSQ only). A create-transfer response carries only `data.id`, so its outer status / `statusCode` (`00` done, `01` processing) is the answer there; TSQ's outer status is only the query's.
- **Transactions list** takes `start-date` / `end-date` (days). Duevy bounds each lookup to the checkout's Lagos days, a day either side, then applies the exact window.

## Open questions for 9jaPay

- How a withdrawal the recipient bank bounces comes back to the space account (sender and narration). Until confirmed, a reversal is recognised by the space account as sender or "revers" in the narration; if 9jaPay marks it differently, it would be credited as a direct deposit **on top of** the restore. Check this with the first real bounce.
- Who pays 9jaPay's inflow charge on a direct deposit (0.5% + ₦50 from ₦10k, if it applies to permanent accounts). Duevy collects no 1.5% on these, so if billed to the business, Duevy absorbs it.

1. **Live base URL** (later).
2. If opening a space account times out, a retry with the same reference is refused as a duplicate, and the account number from the first attempt is unknown. Left as is: Duevy opens it under the next reference (`SPACE<id>R1`, …, up to 5) and logs the possibly orphaned account. (`GET /v1/api/virtual-accounts` lists accounts with their `requestReference`, if a cleanup is ever needed.)
