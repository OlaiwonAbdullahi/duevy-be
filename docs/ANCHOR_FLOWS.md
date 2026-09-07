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

**Two product surfaces, one key.** `/api/v1/*` is the BaaS product and works in
sandbox. `/pay/*` is the Payments product — same `x-anchor-key`, but gated on a
payment program and **production only**, with its own webhook registration and
its own event (`payin.received`). Collections live there, so none of flow 3 can
be exercised before Duevy Labs' KYB clears.

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

## 3. Student pays their dues

| # | Trigger | Anchor call | Duevy code |
|:--:|---|---|---|
| 1 | `POST /v1/dues/pay` with `dueIds[]` | `POST /pay/pay-with-transfer` | `createPayWithTransfer()` |
| 2 | Student transfers from their bank app | — | — |
| 3 | webhook `payin.received` | `GET /pay/payin/{id}` to recover our reference | `fulfilByReference()` + `markPaymentSettled()` |

Service: `src/services/payment.service.ts`.

**One transfer settles several dues** (PRD §5.2). The basket is charged per due
and summed, so **one** Anchor account is opened for the total, and fulfilment
writes **one `DuePayment` row per due**, all sharing the checkout's reference.
`POST /v1/dues/:dueId/pay` still works as a basket of one.

That is the whole of the many-dues-one-payment join — there is no separate
`payment_lines` table, because the per-due rows already carry it and every
downstream query (roster, ledger, remittance) keeps working unchanged.

**The money lands in Duevy's settlement account, not the department's.** Anchor
confirmed sub-accounts are internal-use only, and the Pay With Transfer request
has no `relationships` block at all — there is no settlement destination to
name. Flow 4 moves each payment on.

`customer.fullName` is deliberately omitted so Anchor falls back to the merchant
name: the payer sees **"DUEVY"**, not the rep's BVN name.

What this flow gives us that a virtual NUBAN could not:

- **The amount is enforced.** `amount` is required and Anchor holds the payer to
  it, so under/overpayment cannot occur. The check in `fulfilByReference()`
  survives only as an assertion — if it fires, Anchor's guarantee broke.
- **The expiry is real.** `expiryTime` is a request field in seconds, so the
  30-minute countdown is Anchor's, not cosmetic, and a late transfer cannot land.

Still true: there is no hosted checkout. The response is an account number, and
the pay screen renders tap-to-copy transfer details.

`payin.received` carries only `relationships.payIn.data.id`, so the handler
fetches the PayIn to recover our reference before fulfilling.

---

## 4. Remittance to the department

Runs on the reconciliation tick, once a payment is settled.

| Anchor call | Duevy code |
|---|---|
| `POST /api/v1/transfers` with `type: BookTransfer` | `createBookTransfer()` |

`remitToSpaces()` in `src/services/payout.service.ts`, moving money from
`ANCHOR_SETTLEMENT_ACCOUNT_ID` to the space's own deposit account. Book
transfers are internal and free, so this costs nothing per payment.

**One book transfer per due, not per checkout.** A basket of four dues collects
in a single transfer and remits as four, each keyed on its own `DuePayment` row.
That is deliberate: the department's balance, the ledger and the collections
roster are all per due, so remitting per due keeps them reconcilable without a
splitting step. Free transfers are what make it affordable.

**Only `netToSpace` moves** — the face value of the due. Duevy's margin simply
stays behind in the settlement account, which is why there is no second sweep
and no way to take Anchor's cut twice. Anchor charges its 0.5% collection fee
against the settlement account, so Duevy absorbs it and the rep receives the
full face amount: *your ₦5,000 due stays ₦5,000* (PRD §7.1).

`remittedAt` — not `settledAt` — is what makes money withdrawable. Confirmation
arrives as `book.transfer.successful` / `.failed`.

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
| `GET /pay/pay-with-transfer/{id}` | `getPayWithTransfer()` |

`src/jobs/reconciliation.ts`, every 5 minutes. Anchor has no checkout session to
poll, but a Pay With Transfer gains a `payIn` relationship once funded — so
reading the checkout back says whether the money arrived and only the
notification was lost. One call per stale payment; each checkout is its own
object, so there is nothing to batch. Stale after 15 minutes, abandoned after
48 hours.

The same tick runs the remittance and re-checks stuck payouts.

---

## 7. Webhook ingestion

`POST /v1/webhooks/anchor` — `src/routes/webhooks.ts`.

Registered with `POST /api/v1/webhooks`. **The token Anchor accepts is capped at
10 characters**, so `ANCHOR_WEBHOOK_SECRET` has to be short — a longer value can
never be registered and would fail every check.

⚠ `payin.received` is **not** in the BaaS event enum. It belongs to the Payments
product and needs its own registration; whether it can be pointed at this same
endpoint and secret is unconfirmed.

Signature verification uses `x-anchor-signature`, computed as
`base64(hex(HMAC_SHA1(rawBody, token)))` — hex first, *then* base64. A plain
base64-of-digest implementation fails, and there is a test asserting exactly
that. Raw bytes come from the `express.json({ verify })` hook in `src/app.ts`.

Every event is written to `webhook_events` keyed on Anchor's event id before
processing; a repeated id is acknowledged and dropped. The handler always returns
200 — reconciliation is the backstop.

| Group | Events |
|---|---|
| KYC | `customer.identification.` — `approved`, `rejected`, `error`, `manualReview`, `awaitingDocument`, `reenter_information`, `pending` |
| Provisioning | `account.opened`, `accountNumber.created` |
| Collection | **`payin.received`** — fulfils and settles in one step |
| Direct inflows | `nip.inbound.received`, `nip.inbound.completed` — logged, not checkouts |
| Payout | `nip.transfer.successful`, `.failed`, `.reversed` |
| Remittance | `book.transfer.successful`, `.failed` |

---

## 8. Watching it work

`GET /v1/admin/health` (PRD §10) counts the four states that mean money is stuck:

| Field | Means |
|---|---|
| `failedWebhooks` | A handler threw; the event is in `webhook_events` with its error. |
| `unremittedPayments` | Collected but still in Duevy's account 30+ minutes on — flow 4 is failing. |
| `stuckPayouts` | `processing` for over an hour — flow 5 never resolved. |
| `unresolvedCheckouts` | Pending past expiry. Anchor enforces the expiry, so this is a **lost webhook**, not a mispaid transfer. |

`healthy` is all four at zero. The last of these is the one worth watching after
go-live: it is the only signal that `payin.received` deliveries are being missed.

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
| **POST** | **`/pay/pay-with-transfer`** | `createPayWithTransfer` | 3 |
| GET | `/pay/pay-with-transfer/{id}` | `getPayWithTransfer` | 6 |
| GET | `/pay/payin/{id}` | `getPayIn` | 3 |
| GET | `/api/v1/banks` | `getBanks` | 2 |
| GET | `/api/v1/payments/verify-account/{bankCode}/{accountNumber}` | `verifyAccount` | 2 |
| POST | `/api/v1/counterparties` | `createCounterParty` | 2 |
| POST | `/api/v1/transfers` — `NIPTransfer` | `createNipTransfer` | 5 |
| POST | `/api/v1/transfers` — `BookTransfer` | `createBookTransfer` | 4 |
| GET | `/api/v1/transfers/{id}` | `getTransfer` | 5 |
| GET | `/api/v1/transfers/verify/{id}` | `verifyTransfer` | 5 |
| GET | `/api/v1/transactions` | `listAccountTransactions` | — |

The three `/pay/*` rows are production-only. Everything else works in sandbox,
so flows 1, 2 and 5 can be verified before KYB; flows 3, 4 and 6 cannot.
Anchor's docs or OpenAPI document, so both the verb and the version are inferred.
It matters because Anchor owns the account lifetime — an abandoned checkout stays
open past our countdown. Confirm the real endpoint with Anchor before wiring it up.
