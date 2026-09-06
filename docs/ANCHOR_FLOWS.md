# Anchor flows — endpoint by endpoint

Every Anchor call Duevy makes, grouped by the flow it belongs to. Derived from
`src/lib/anchor.ts`; if the two disagree, the code is right and this is stale.

- **Base URL** — `ANCHOR_BASE_URL`, either `https://api.sandbox.getanchor.co` or
  `https://api.getanchor.co`.
- **Auth** — `x-anchor-key: <ANCHOR_SECRET_KEY>` on every request.
- **Amounts** — integer kobo, everywhere, in both directions.
- **References** — must match `^[a-z\d\-_\s]+$`. Our `DVY-1234-5678` is
  lowercased by `toAnchorRef()` on the way out and restored by `fromAnchorRef()`
  on the way back.

One endpoint is on **v2**: virtual NUBAN creation. Everything else is v1.

---

## 1. Rep onboarding and provisioning

Runs once per rep. Everything after step 2 is driven by webhooks, so a rep who
closes the tab still ends up provisioned.

| # | Trigger | Anchor call | Duevy code |
|:--:|---|---|---|
| 1 | Admin approves the rep | `POST /api/v1/customers` | `createIndividualCustomer()` |
| 2 | Rep submits BVN + DOB + gender | `POST /api/v1/customers/{customerId}/verification/individual` | `submitTier2Verification()` |
| 3 | webhook `customer.identification.approved` | — | handler |
| 4 | Handler creates the account | `POST /api/v1/accounts` | `createDepositAccount()` |
| 5 | webhook `account.opened` / `accountNumber.created` | — | handler |
| 6 | Handler reads the assigned NUBAN | `GET /api/v1/accounts/{accountId}` | `getAccount()` |

Service: `src/services/anchorCustomer.service.ts`.

- The verification `level` is **`TIER_2`**, with the BVN in a `level2` object.
  `TIER_1` is rejected — see the callout in `anchor.ts`.
- The BVN is sent to Anchor and never persisted (PRD §8).
- Step 4 fails with `412` if KYC has not completed, which is why it is
  webhook-driven rather than called inline.
- Account numbers are assigned asynchronously, hence step 6.

Rejection paths: `customer.identification.rejected` sets `kycStatus: rejected`
with a reason; `.error` is transient and retried; `.manualReview`,
`.awaitingDocument`, `.reenter_information` and `.pending` all hold at `pending`.

---

## 2. Setting the payout destination

| # | Trigger | Anchor call | Duevy code |
|:--:|---|---|---|
| 1 | Rep opens the payout form | `GET /api/v1/banks` | `getBanks()` |
| 2 | Rep enters bank + account number | `GET /api/v1/payments/verify-account/{bankCode}/{accountNumber}` | `verifyAccount()` |
| 3 | Rep confirms | `POST /api/v1/counterparties` | `createCounterParty()` |

Routes: `src/routes/banks.ts`, `src/routes/payouts.ts`.

The account name is always resolved from the bank, never accepted from the
client. `createCounterParty` sends `verifyName: true`, so Anchor overwrites
whatever name we pass with the authoritative one. Changing a saved account
starts a 24-hour cooldown.

---

## 3. Student pays a due

| # | Trigger | Anchor call | Duevy code |
|:--:|---|---|---|
| 1 | `POST /v1/dues/:dueId/pay` | `POST /api/v2/virtual-nubans` | `createVirtualNuban()` |
| 2 | Student transfers from their bank app | — | — |
| 3 | webhook `payment.received` / `nip.inbound.received` | — | `fulfilByReference()` |
| 4 | webhook `payment.settled` / `nip.inbound.completed` | — | `markPaymentSettled()` |

Service: `src/services/payment.service.ts`.

The request needs **both** a `customer` and a `settlementAccount` relationship.
`permanent: false` makes the account dynamic. `provider`
(`ANCHOR_VA_PROVIDER`) picks the issuing bank the student sees.

Three things this flow cannot do, all of which the code compensates for:

- **No hosted checkout.** The response is an account number, not a URL. The pay
  screen renders tap-to-copy transfer details instead of redirecting.
- **No fixed amount.** A virtual NUBAN has no `amount` field, so the student can
  send the wrong figure. `fulfilByReference()` reconciles what arrived against
  our own recorded total (PRD §9.1).
- **No settable expiry.** `expiryDate` is response-only — Anchor owns the
  account's lifetime. Our 30-minute countdown is `PendingPayment.expiresAt` plus
  a UI timer, nothing more, so a late transfer can still land and is handled as
  an unmatched inflow.

Step 3 credits the space and moves the money into `pending`; step 4 is what makes
it withdrawable.

---

## 4. Service-charge sweep

Runs on the reconciliation tick, once a payment has settled.

| Anchor call | Duevy code |
|---|---|
| `POST /api/v1/transfers` with `type: BookTransfer` | `createBookTransfer()` |

`sweepServiceCharges()` in `src/services/payout.service.ts`, moving money from
the space's deposit account to `ANCHOR_REVENUE_ACCOUNT_ID`.

**It sweeps `duevyFee` only, never `processingFee`.** Anchor books its own
collection fee against the account as a separate `CustomerFee` row, so sweeping
the full service charge would take Anchor's cut a second time out of the rep's
money. Confirmation arrives as `book.transfer.successful` / `.failed`.

---

## 5. Payout

| # | Trigger | Anchor call | Duevy code |
|:--:|---|---|---|
| 1 | Rep requests a withdrawal | `GET /api/v1/accounts/balance/{accountId}` | `getAccountBalance()` |
| 2 | Balance check passes | `POST /api/v1/transfers` with `type: NIPTransfer` | `createNipTransfer()` |
| 3 | webhook `nip.transfer.successful` / `.failed` / `.reversed` | — | `settlePayout()` |

Service: `src/services/payout.service.ts`.

Step 1 is a live read against Anchor, not our ledger. The ledger says what the
rep *may* withdraw; this says whether the money is actually there. A shortfall
defers the payout rather than letting the transfer fail at Anchor.

The transfer draws from the space's deposit account to the saved counterparty and
carries `x-anchor-idempotent-key` derived from our payout reference. The amount
sent is `netSentKobo` — the request minus the ₦100 Duevy fee and, above ₦10,000,
₦50 stamp duty. Anchor deducts its own NIP fee and the duty as `CustomerFee` rows.

Transfers stuck in flight are polled with
`GET /api/v1/transfers/verify/{transferId}` (`verifyTransfer()`) after 15 minutes.

---

## 6. Reconciliation fallback

| Anchor call | Duevy code |
|---|---|
| `GET /api/v1/transactions?accountId=…` | `listAccountTransactions()` |

`src/jobs/reconciliation.ts`, every 5 minutes. Anchor has no checkout session to
poll, so a payment whose webhook never arrived is found by scanning the
settlement account's own transaction history for a credit carrying our reference.
One listing per account, not per payment. Stale after 15 minutes, abandoned after
48 hours.

The same tick also runs the service-charge sweep and re-checks stuck payouts.

---

## 7. Webhook ingestion

`POST /v1/webhooks/anchor` — `src/routes/webhooks.ts`.

Registered with `POST /api/v1/webhooks`. **The token Anchor accepts is capped at
10 characters**, so `ANCHOR_WEBHOOK_SECRET` has to be short — a longer value can
never be registered and would fail every check.

Signature verification uses `x-anchor-signature`, computed as
`base64(hex(HMAC_SHA1(rawBody, token)))` — hex first, *then* base64. A plain
base64-of-digest implementation fails, and there is a test asserting exactly
that. Raw bytes come from the `express.json({ verify })` hook in `src/app.ts`.

Every event is written to `webhook_events` keyed on Anchor's event id before
processing; a repeated id is acknowledged and dropped. The handler always returns
200 — reconciliation is the backstop.

Eighteen events are handled:

| Group | Events |
|---|---|
| KYC | `customer.identification.` — `approved`, `rejected`, `error`, `manualReview`, `awaitingDocument`, `reenter_information`, `pending` |
| Provisioning | `account.opened`, `accountNumber.created` |
| Collection | `payment.received`, `payment.settled`, `nip.inbound.received`, `nip.inbound.completed` |
| Payout | `nip.transfer.successful`, `.failed`, `.reversed` |
| Sweep | `book.transfer.successful`, `.failed` |

---

## Full endpoint index

| Method | Path | Function | Flow |
|---|---|---|:--:|
| POST | `/api/v1/customers` | `createIndividualCustomer` | 1 |
| GET | `/api/v1/customers/{id}` | `getCustomer` | 1 |
| POST | `/api/v1/customers/{id}/verification/individual` | `submitTier2Verification` | 1 |
| POST | `/api/v1/accounts` | `createDepositAccount` | 1 |
| GET | `/api/v1/accounts/{id}` | `getAccount` | 1, 5 |
| GET | `/api/v1/accounts/balance/{id}` | `getAccountBalance` | 5 |
| **POST** | **`/api/v2/virtual-nubans`** | `createVirtualNuban` | 3 |
| DELETE | `/api/v2/virtual-nubans/{id}` ⚠ | `closeVirtualNuban` | — |
| GET | `/api/v1/banks` | `getBanks` | 2 |
| GET | `/api/v1/payments/verify-account/{bankCode}/{accountNumber}` | `verifyAccount` | 2 |
| POST | `/api/v1/counterparties` | `createCounterParty` | 2 |
| POST | `/api/v1/transfers` — `NIPTransfer` | `createNipTransfer` | 5 |
| POST | `/api/v1/transfers` — `BookTransfer` | `createBookTransfer` | 4 |
| GET | `/api/v1/transfers/{id}` | `getTransfer` | 5 |
| GET | `/api/v1/transfers/verify/{id}` | `verifyTransfer` | 5 |
| GET | `/api/v1/transactions` | `listAccountTransactions` | 6 |

⚠ **Unverified and currently uncalled.** No close/deactivate endpoint appears in
Anchor's docs or OpenAPI document, so both the verb and the version are inferred.
It matters because Anchor owns the account lifetime — an abandoned checkout stays
open past our countdown. Confirm the real endpoint with Anchor before wiring it up.
