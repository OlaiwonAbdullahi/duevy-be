# Bachs → Anchor: what changed for API consumers

The payment rail moved from Bachs Connect to **Anchor** (getanchor.co). Anchor is
a BaaS, not a payment gateway, and two consequences reach the API surface:

1. **There is no hosted checkout page.** The payer transfers to a single-use
   bank account we open per checkout. `checkoutUrl` is gone.
2. **A space cannot collect until its lead rep passes BVN verification.** Money
   settles into Duevy's account and is book-transferred on to a deposit account
   owned by that rep's Anchor customer record — so without verification there is
   nowhere for it to land.

Everything else — auth, the response envelope, idempotency keys, pagination,
error codes — is unchanged.

---

## 1. Paying a due — breaking

`POST /v1/dues/{dueId}/pay` (and `POST /v1/polls/{slug}/votes` on paid polls).

**Before**
```json
{ "success": true, "data": { "checkoutUrl": "https://sandbox-checkout.bachs.io/...", "reference": "DVY-4821-7735" } }
```

**Now**
```json
{
  "success": true,
  "data": {
    "reference": "DVY-4821-7735",
    "amount": 510000,
    "checkoutUrl": null,
    "bankTransfer": {
      "accountNumber": "0095000015",
      "bankName": "Providus Bank",
      "accountName": "DUEVY",
      "amountKobo": 510000,
      "expiresAt": "2026-09-05T11:13:01.878Z"
    }
  }
}
```

The old redirect flow no longer works. The pay screen must instead show the
account number (tap-to-copy), bank, account name, the exact amount, and a
countdown to `expiresAt`, then poll `GET /v1/payments/{reference}/status`.

> **THE ACCOUNT NAME IS DUEVY'S, AND THE AMOUNT IS ENFORCED**
>
> The checkout is a Pay With Transfer account. `customer.fullName` is omitted
> deliberately, so Anchor falls back to the merchant name and the payer sees
> **"DUEVY"** — not the rep's BVN name, which is what the earlier virtual-NUBAN
> design would have exposed.
>
> Anchor also holds the payer to the exact `amount`, so a wrong figure cannot be
> sent and there is no underpayment state for the UI to handle. Confirm the
> rendered name in production; `/pay/*` is not reachable in sandbox.

Rules the UI has to respect:

- **The amount shown is exact.** It is the due plus the 2% service charge, and
  Anchor enforces it — a payer cannot send anything else.
- **One account per checkout attempt** — not per student and not per due. A
  student who lets the countdown expire and retries gets a *new* number. Never
  cache an account number against a student or a due; key it on `reference` and
  re-read it from the status endpoint.
- **The account is single-use and expires** (30 minutes by default), enforced by
  Anchor rather than by us. A transfer after the countdown cannot land, so the
  timer hitting zero is final; the student starts a new checkout.
- **Nothing is marked paid on the client.** There is no "I have paid" button
  that completes a payment; the poll reads our record, which only the Anchor
  webhook writes.

New failure modes on this endpoint:

| Code | Status | Meaning |
|---|---|---|
| `SPACE_NOT_VERIFIED` | 409 | The rep hasn't finished verification, so there is nowhere to remit the money to. |

There is **no per-transfer ceiling** on a checkout: payments settle into Duevy's
own account, which Anchor confirmed is unlimited. A due can be any amount.

## 2. Multi-due checkout — new

`POST /v1/dues/pay` — **requires `Idempotency-Key`.** One transfer settles
several dues (PRD §5.2), which is the point of the product: *the student never
pays four times for four dues.*

```json
{ "method": "online", "dueIds": ["due_1a2b", "due_3c4d", "due_5e6f"] }
```

The response is identical to the single-due form — one `reference`, one
`bankTransfer`, one amount covering the whole basket.

`POST /v1/dues/{dueId}/pay` still works and is now just a basket of one, so
existing clients need no change.

Rejections, all before any account is opened:

| Code | Status | Meaning |
|---|---|---|
| `DUE_NOT_PAYABLE` | 409 | One of the dues is not open. The message names it. |
| `DUE_ALREADY_PAID` | 409 | One is already settled. The message names it. |
| `MIXED_SPACES` | 422 | The basket spans two spaces; one transfer credits one space. |
| `NOT_A_MEMBER` | 403 | Not a member, and at least one due disallows guests. |

Up to 20 dues per checkout. A referral discount applies to **one** due — the
first in the basket — not spread across it, so the per-due amounts stay
reconcilable.

The receipt at `GET /v1/dues/{dueId}/receipt` now covers the whole payment and
itemises every due it settled, so any due in the basket returns the same
receipt.

## 3. Polling status — additive

`GET /v1/payments/{reference}/status` now also returns `checkoutUrl: null` and,
while still `pending`, the same `bankTransfer` object — so a reload or a
different device can re-render the transfer screen from the reference alone.

## 4. Rep verification — replaces the onboarding endpoints

**Removed** (all six Bachs onboarding proxies):

```
GET  /v1/spaces/{spaceId}/payout/onboarding/checklist
POST /v1/spaces/{spaceId}/payout/onboarding/documents
POST /v1/spaces/{spaceId}/payout/onboarding/submit
GET  /v1/spaces/{spaceId}/payout/onboarding/identity/methods
POST /v1/spaces/{spaceId}/payout/onboarding/identity/nin
GET  /v1/spaces/{spaceId}/payout/onboarding/identity/status
GET  /v1/spaces/{spaceId}/payout/onboarding-status
```

**Added** — Anchor needs no documents and no uploads, just BVN + date of birth +
gender + an address:

`POST /v1/spaces/{spaceId}/payout/kyc` (lead rep only) → `202`

```json
{
  "bvn": "22222222226",
  "dateOfBirth": "1994-06-25",
  "gender": "Male",
  "phone": "07012345678",
  "address": {
    "addressLine1": "36 Araromi Street",
    "addressLine2": "Onike",
    "city": "Ogbomoso",
    "state": "OYO",
    "postalCode": "NA"
  }
}
```

`state` is Anchor's enum casing — uppercase, underscores for spaces
(`OYO`, `AKWA_IBOM`, `CROSS_RIVER`, `FCT`).

Verification is **asynchronous**. A 202 means only that Anchor accepted the
check; the rep sees "Verifying…" until the webhook resolves it.

`GET /v1/spaces/{spaceId}/payout/kyc-status` → the banner state:

```json
{
  "kycStatus": "verified",
  "rejectionReason": null,
  "retryLockedUntil": null,
  "submittedAt": "2026-09-05T10:41:00.000Z",
  "accountProvisioned": true,
  "accountNumber": "9000000000",
  "bankName": "Providus Bank",
  "canCollect": true
}
```

`canCollect` is the single flag to gate the "publish due" and "pay" affordances
on. `kycStatus` is one of `unverified | pending | verified | rejected`.

Failure handling worth building for:

- The dominant rejection is a **BVN name/phone mismatch**. Say that in plain
  words and tell the rep to use the phone number registered on their BVN.
- Three consecutive failures lock retries for 24 hours →
  `429 KYC_RETRY_LOCKED`, with `retryLockedUntil` in the status response.
- **The BVN is never stored.** A retry means the rep re-enters it.

## 4b. Raising the KYC tier — new

`POST /v1/spaces/{spaceId}/payout/kyc/upgrade` (lead rep only) → `202`

```json
{ "idType": "NATIONAL_ID", "idNumber": "12345678901", "expiryDate": "2030-06-25" }
```

`idType` is one of `DRIVERS_LICENSE`, `VOTERS_CARD`, `PASSPORT`, `NATIONAL_ID`,
`NIN_SLIP`. `expiryDate` is optional — a NIN slip does not expire.

This raises a verified rep from `tier_2` (BVN, automatic, capped at ₦300,000) to
**`tier_3`, which is unlimited**. Unlike the initial check it is a **manual
review at Anchor and can take days**, so build for a long wait, not a spinner.

Removing the ceiling is the entire value proposition — a space collecting from
300 students at ₦5,000 hits ₦300,000 around student 60, so this is what lets a
large cohort collect without the rep withdrawing every day.

**The rep keeps collecting throughout.** A pending upgrade never suspends the
account, and a rejected upgrade leaves the existing verification untouched —
only the pending tier clears.

| Code | Status | Meaning |
|---|---|---|
| `NOT_VERIFIED` | 409 | Finish BVN verification first. |
| `ALREADY_AT_TIER` | 409 | Already `tier_3`. |
| `UPGRADE_PENDING` | 409 | One is already under review. |

`GET /v1/spaces/{spaceId}/payout/kyc-status` gains three fields:

```json
{ "kycTier": "tier_2", "pendingTier": "tier_3", "canUpgrade": false }
```

`canUpgrade` is the single flag to gate the "Raise my limit" affordance on.

`GET /v1/spaces/{spaceId}/payout/summary` gains `kycTier`, and its ceiling
fields become tier-dependent:

```json
{ "kycTier": "tier_3", "ceilingKobo": null, "ceilingUsedPct": null, "ceilingLevel": "uncapped" }
```

**`ceilingLevel` can now be `uncapped`, and `ceilingKobo` can be `null`.**
`tier_3` is unlimited — there is genuinely no ceiling — so the UI must **hide**
the meter in that case, not render `null` as zero. "No limit" is the reward the
rep paid ₦200 for; showing them an empty progress bar reads as a bug.

## 5. Bank list — simplified

`GET /v1/banks` no longer requires `spaceId` (Anchor's list is
organisation-wide). The parameter is still accepted and ignored, so existing
callers keep working.

## 6. Payouts — new fee breakdown

Withdrawals now carry explicit fees (PRD §7.3). The requested `amount` is the
**gross** debit against the available balance; the fees come out of it.

`GET /v1/spaces/{spaceId}/payout/quote?amount=2500000` → show this before the
rep confirms:

```json
{
  "amount": 2500000,
  "duevyFeeKobo": 10000,
  "stampDutyKobo": 5000,
  "netSentKobo": 2485000,
  "belowMinimum": false,
  "minPayout": 100000
}
```

`duevyFeeKobo` is the flat ₦100; `stampDutyKobo` is the statutory ₦50 CBN charge
on transfers above ₦10,000, shown as a separate line because it is a government
charge, not ours. `netSentKobo` is what lands in the rep's bank.

`GET /v1/spaces/{spaceId}/payout/summary` gains the TIER_2 balance ceiling:

```json
{
  "available": 21000000,
  "pending": 500000,
  "lifetime": 4000000,
  "ceilingKobo": 30000000,
  "ceilingUsedPct": 70,
  "ceilingLevel": "warn",
  "minPayout": 100000
}
```

`ceilingLevel` is `ok` / `warn` (≥70%) / `critical` (≥90%). At `warn`, nudge:
"Withdraw now — your space is close to its limit."

This ceiling applies to the **rep's own TIER_2 deposit account**, which holds
remitted funds — not to collection, which is unlimited. Whether an inbound book
transfer actually counts against it is unconfirmed with Anchor, so treat the
warning as advisory until that is settled.

New failure modes: `422 BELOW_MIN_PAYOUT` (minimum ₦1,000, or an amount too
small to cover the fees).

Payout objects now include `duevyFeeKobo`, `anchorFeeKobo`, `stampDutyKobo` and
`netSentKobo`. Show `netSentKobo` as "amount received", not `amount`.

## 7. Fee model — the numbers changed

| | Before | Now |
|---|---|---|
| Collection | 3% on top (1.5% + 1.5%) | **2% on top**, inclusive of Anchor's cut |
| Withdrawal | free | **₦100 flat**, plus ₦50 stamp duty above ₦10,000 |

The face amount still reaches the space untouched — "your ₦5,000 due stays
₦5,000" holds. A ₦5,000 due now costs the student ₦5,100 rather than ₦5,150.

## 8. Webhook endpoint

`POST /v1/webhooks/bachs` → `POST /v1/webhooks/anchor`. Register it in the
Anchor dashboard with `deliveryMode: AtLeastOnce`. Not a client-facing change,
but the old path is gone.

## 9. Admin health view — new

`GET /v1/admin/health` (needs `userManagement`) — PRD §10's money-plumbing view.

```json
{
  "failedWebhooks": 0,
  "unremittedPayments": 0,
  "stuckPayouts": 0,
  "unresolvedCheckouts": 0,
  "healthy": true,
  "recentWebhookFailures": []
}
```

Each count is money stuck somewhere: webhooks that threw, payments collected but
not yet book-transferred to their department, payouts in flight over an hour, and
checkouts still pending well past expiry (which now means a lost webhook, since
Anchor enforces the expiry). `healthy` is all four at zero.
