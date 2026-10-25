# Duevy API (MVP)

Base URL: `/v1`. Request and response bodies are JSON.

**Envelope.** Success responses have the shape `{ "success": true, "data": …, "meta"?: { page, perPage, total, totalPages } }`. Error responses have the shape `{ "success": false, "error": { "code", "message", "details"?: [{ field, issue }] } }`.

**Money.** All amounts are integer **kobo** (₦1 = 100 kobo). The server computes every fee; any amount a client sends to a checkout is rejected.

**Auth.** Send `Authorization: Bearer <accessToken>`. The refresh token is an httpOnly cookie on `/v1/auth/refresh`.

**Idempotency.** Payment endpoints that change state need an `Idempotency-Key: <uuid v4>` header. They are marked 🔑 below.

| Situation | Result |
|---|---|
| A 2xx response | Stored for 24 hours. Repeat requests get it back with `Idempotent-Replayed: true`. |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED` |
| Same key while the first request is still running | `409 IDEMPOTENCY_IN_PROGRESS` |
| Non-2xx response | Not stored, so the key can be retried. |

**Rate limits.**

| Limit | Applies to |
|---|---|
| 100 / 15 min per IP | All endpoints |
| 20 / 15 min per IP | Auth: register, login, google, forgot-password, reset-password |
| 10 / min per user | Checkout |
| 10 / min per user | KYC, name enquiry, payout-account changes, withdrawals |
| 10 / min per user | Join-code lookup |

**Pagination.** List endpoints accept `?page=&perPage=&q=`.

---

## Auth

### `POST /auth/register`

```json
{ "name": "Aisha Bello", "matricNo": "210805019", "email": "aisha@example.com", "password": "min 8 chars",
  "acceptedTerms": true, "role": "student" | "rep", "partnerCode"?: "NACOS",  // rep only, see Partners
  "space": { "name": "…", "short": "CSC", "kind": "department|association|faculty|club", "school": "…", "faculty": "…" }  // required when role = rep
}
```

- `201`: `{ user, accessToken }` for a student.
- `403 REP_APPROVAL_PENDING`: returned for a rep, together with `data: { user, accessToken }`. The rep can sign in, but rep actions wait for admin approval.
- Every account is a student. Rep is a permission added on top (`isRep`) when an admin approves the application.

### `POST /auth/login`

- Body: `{ "email", "password" }`.
- `200`: `{ user, accessToken }`.

### `GET /auth/me`

`200`: `{ id, name, email, role, isRep, adminSubRole, institution, kycStatus, repApplicationStatus, matricNo, level, spaces: [{ id, name, short, kind, hue, membership: "member"|"rep" }] }`

Refresh, logout, Google sign-in, email verification and password reset are unchanged.

---

## Spaces

### `POST /spaces` (approved rep only)

```json
{ "name": "CSC Association", "short": "CSA", "kind": "association", "school": "…", "institution": "LAUTECH",
  "faculty": "…", "about": "…" }
```

- `201`: `Space & { joinCode }`.
- The rep becomes the space's lead and its first member.
- `403` if the caller is not an approved rep.

`Space = { id, name, short, kind, hue, about, faculty, school, institution, memberCount, theme, createdAt }`

### `POST /spaces/lookup`

- Body: `{ "code": "CSC-LAU1" }`.
- `200`: `Space & { code, dues: [{ id, title, amount, dueDate, type, status }] }`.
- `404 JOIN_CODE_INVALID`.

### `POST /spaces/:spaceId/join`

- Body: `{ "code": "CSC-LAU1" }`.
- `201`: `{ spaceId, status: "active", membership, joinedAt }`.
- Errors: `422 JOIN_CODE_INVALID`, `409 ALREADY_MEMBER`.

### `GET /spaces`

`200`: `Space[]`, the spaces the caller belongs to.

---

## Dues (rep)

All endpoints are under `/spaces/:spaceId` and the caller must be a rep of the space.

- `type` is one of `handout | departmental_due | exam_levy | lab_manual | association_due | departmental_wear | trip_fee | clearance | other`. `category` is still accepted as an alias.
- Creating and editing dues works before KYC.
- Publishing a due, or creating it with `publish: true`, needs the space's lead rep to have passed KYC. Otherwise: `409 KYC_REQUIRED`.

### `POST /dues`

- Body: `{ "title", "note"?, "amount": 500000, "dueDate": "YYYY-MM-DD", "type": "departmental_due", "publish"?: false, "assignedRepId"?: "…" }`.
- `assignedRepId` gives the due to a co-rep, who can then withdraw its collections. Only the lead can set it, and only to a co-rep of the space (`403` for a co-rep, `400 VALIDATION_ERROR` for anyone else). Left out, the due is assigned to whoever creates it. The co-rep is notified.
- `201`: `RepDue`.

`RepDue = { id, spaceId, title, note, amount, dueDate, type, category, status: "draft"|"active"|"closed", paidCount, memberCount, assignedRepId, publishedAt, closedAt, createdAt }`

### Other due endpoints

| Endpoint | Behaviour |
|---|---|
| `GET /dues?status=&type=` | Lists the space's dues. |
| `PATCH /dues/:dueId` | Edits a due. The amount is locked once any payment exists. |
| `POST /dues/:dueId/publish` | Publishes a draft. |
| `POST /dues/:dueId/close` | Closes a due. |
| `DELETE /dues/:dueId` | Deletes a due; drafts only. |

### `GET /dues/:dueId/collections?status=all|paid|unpaid`

`200`: `{ totals: { paid, unpaid, collected, fees, net, expected, rate }, students: [{ id, name, matricNo, level, email, status: "paid"|"unpaid", paidAt, reference }] }`

This shows who has paid and who has not. `GET /dues/:dueId/collections/export` returns the same list as CSV.

---

## Checkout (student)

### `GET /dues?spaceId=&status=unpaid|paid|overdue&type=`

`200`: `[{ id, spaceId, title, note, amount, processingFee, payableAmount, dueDate, type, status, paidAt, reference }]`

`processingFee` and `payableAmount` are what the due would cost **on its own**. A checkout charges the fee once, on the whole basket.

### 🔑 `POST /dues/pay`

One bank transfer pays every due in the basket.

```json
{ "dueIds": ["due_…", "due_…"] }
```

`201` for a new checkout, or `200` with `reused: true` when an open checkout already exists for the same basket:

```json
{
  "reference": "DVY-7KQ2-MN4X",
  "status": "pending",
  "amount": 659750,
  "breakdown": { "face": 650000, "fee": 9750, "total": 659750 },
  "items": [{ "dueId": "…", "title": "…", "amount": 500000, "fee": 7500 }],
  "bankTransfer": { "accountNumber": "7001646987", "bankName": "Bank78", "accountName": "Duevy Ada Obi", "amountKobo": 659750, "expiresAt": "…" },
  "checkoutUrl": null,
  "expiresAt": "…", "paidAt": null, "receivedKobo": null, "overpaidKobo": 0, "reused": false
}
```

The student pays by one bank transfer into `bankTransfer.accountNumber` (a Bank78 dynamic virtual account opened for this checkout). Bank78 accepts **exactly** `amountKobo`; any other amount is refused at the bank, and the account closes at `expiresAt`. `checkoutUrl` is always `null` (kept for older clients).

The fee is 1.5% of the face value (rounded half-up to the kobo) plus Bank78's collection fee, which is 0 until Bank78 publishes one. The student pays the fee on top, and the space receives the full face value.

Rules:

- Every due must be `active` and belong to the same space (otherwise `422 MIXED_SPACES`).
- The caller must have joined the space (otherwise `403 NOT_A_MEMBER`).
- No due may already be paid (otherwise `409 DUE_ALREADY_PAID`).
- The space's lead rep must have passed KYC (otherwise `409 SPACE_NOT_VERIFIED`).
- A basket that overlaps an open checkout is refused with `409 CHECKOUT_OVERLAP`.
- Body fields other than `dueIds` (and the legacy `method: "online"`) are rejected with `400`. That includes any amount.

`POST /dues/:dueId/pay` (🔑, empty body) does the same for a single due.

### `GET /payments/:reference` (also `/payments/:reference/status`)

`200`: the same checkout object, plus `receiptNumber` and, once paid, `transaction`.

| `status` | Meaning |
|---|---|
| `pending` | Waiting for the transfer. |
| `paid` | Paid. |
| `expired` | The bank account closed with nothing paid. |
| `underpaid` | Less than the total arrived. No due is marked paid; support follows up. |

Only the webhook (and the reconciliation job behind it) changes the status. Polling this endpoint never does.

### Receipts and history

| Endpoint | Returns |
|---|---|
| `GET /receipts` | `[{ number, reference, issuedAt, paidAt, space: { id, name }, payer, method, items: [{ dueId, title, amount }], face, fee, total, received }]` |
| `GET /receipts/:number` | One receipt. Add `?format=pdf` for the PDF. |
| `GET /dues/:dueId/receipt` | The PDF receipt of the payment that settled this due. |
| `GET /transactions?direction=&type=&status=` | Payment history: `[{ id, type, title, detail, amount, method, status, reference, createdAt }]`. `GET /transactions/:id` and `/transactions/:id/receipt` return one entry and its receipt. |

---

## KYC and withdrawals (rep)

All endpoints are under `/spaces/:spaceId` and the caller must be a rep of the space.

KYC has three parts, and a space collects only when **all** pass:

- **Phone, verified by Didit** with a one-time code.
- **Identity, verified by Didit:** NIN and BVN, each with the name and date of birth, against the registries, decided on submission. Approval opens the rep's **wallet** (a Bank78 sub-account, which requires the BVN) that collections are routed into and withdrawals come out of.
- **Student status, verified by a Duevy admin:** the rep's student ID card.

Every route below also exists under `/me/kyc…` (for rep applicants before their space exists).

### `POST /payout/kyc/phone/send`

Body: `{ "phone": "08012345678" }` (local, `234…` or `+234…`). Didit texts a code, valid 5 minutes. `202` `{ phone: "+2348012345678" }`.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | Not a Nigerian mobile number. |
| `422 PHONE_REJECTED` | Didit refused the number. |
| `429 PHONE_BLOCKED` | Too many attempts for this number. |
| `503 KYC_UNAVAILABLE` | Didit is unavailable; try again. |

### `POST /payout/kyc/phone/verify`

Body: `{ "phone": "08012345678", "code": "123456" }`. `200` with the KYC state; `phone.verifiedAt` is set.

| Error | When |
|---|---|
| `422 INVALID_CODE` | Wrong code (the message says how many attempts are left). |
| `422 PHONE_DECLINED` | A virtual, disposable or already-used number, or too many wrong codes. Use another number. |
| `422 CODE_EXPIRED` | Request a new code. |

### `POST /payout/kyc` (`multipart/form-data`)

Needs a verified phone first.

| Part | Required | Notes |
|---|---|---|
| `nin` | yes | 11 digits. Sent to Didit (and to Bank78 when the wallet opens); never stored or logged. |
| `bvn` | yes | 11 digits. Checked by Didit; Bank78 requires it to open the wallet. Never stored or logged. |
| `dob` | yes | `YYYY-MM-DD`. Sent to Didit; never stored or logged. |
| `gender` | yes | `male` or `female`. Kept for admins. |
| `studentIdCard` | yes | File: JPEG, PNG, WebP or PDF, max 5 MB, checked by its bytes. Stored privately in ImageKit for admin review. |
| `firstName`, `lastName` | no | As on the NIN record. Default to the account name. |

`202`:

```json
{ "kycStatus": "verified", "payoutsActive": false, "canCollect": false, "canWithdraw": false, "providerReference": "didit request id",
  "phone": { "number": "+2348012345678", "verifiedAt": "…" },
  "wallet": { "accountNumber": "0000086185" },
  "studentId": { "status": "pending", "uploadedAt": "…", "reviewedAt": null, "reviewNote": null },
  "rejectionReason": null, "retryLockedUntil": null, "submittedAt": "…", "resolvedAt": "…" }
```

`kycStatus` is decided on the spot: `verified` (both numbers passed), `rejected` (with `rejectionReason`), or `pending` when a registry didn't answer — submit again in a few minutes (a `pending` result doesn't count as an attempt). The BVN is only checked once the NIN passes. If `wallet` is `null` after `verified`, Bank78 couldn't open it: submit again (the BVN isn't kept, so only the rep can retry); the student ID already on file is kept. Validation errors never echo the NIN, BVN or date of birth.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | Bad field, missing `studentIdCard`, or a file that isn't really a JPEG/PNG/WebP/PDF. |
| `413 FILE_TOO_LARGE` | A file over 5 MB. |
| `403 REP_NOT_APPROVED` | The caller is not an approved rep. |
| `409 PHONE_NOT_VERIFIED` | Verify the phone first. |
| `409 ALREADY_VERIFIED` | Already verified, with a wallet. |
| `422 KYC_REJECTED` | Didit refused the details as sent. |
| `429 KYC_RETRY_LOCKED` | Three failed attempts; retries are locked for 24 hours. |
| `503 KYC_UNAVAILABLE` | Didit is unavailable; not counted as an attempt. |

### `POST /payout/kyc/student-id` (`multipart/form-data`)

Replaces the student ID card after an admin rejected it (or if none was sent). Part: `studentIdCard`. Returns `202` with the KYC state. `409 STUDENT_ID_PENDING` / `STUDENT_ID_APPROVED` if there is nothing to replace.

### `GET /payout/kyc-status`

`200`: the space lead's KYC state (shape above) plus `mine`, the caller's own state.

### `GET /payout/summary` (rep dashboard)

`200`:

```json
{ "available": 900000, "balance": 900000, "collected": 900000, "withdrawn": 0, "withdrawalFees": 0, "inFlight": 0,
  "kyc": { … }, "beneficiaryCount": 1, "minPayout": 100000,
  "fees": { "duevyFeeKobo": 0, "bankFeeKobo": 5000 } }
```

The balance always comes from the ledger. `fees.duevyFeeKobo` is Duevy's withdrawal fee (none for now); `fees.bankFeeKobo` is the transfer fee Bank78 charged on the last withdrawal (`null` before the first), an estimate of the next one.

`GET /wallet/me` returns the caller's own wallet and its live Bank78 balance: `{ accountNumber, bankName, active, availableKobo }`; `404` before KYC opens it.

### Other dashboard reads

| Endpoint | Returns |
|---|---|
| `GET /ledger` | `[{ id, type, direction, amount, signedAmount, reference, description, dueId, payoutId, createdAt }]`, newest first. Types: `due_payment`, `manual_credit`, `payout`, `payout_fee`, `payout_reversal`, `refund`. |
| `GET /payout/breakdown?from=&to=` | Collections per due: `{ totals: { collected, fees, net, paidCount }, byDue: [{ dueId, title, type, paidCount, collected, fees, net }] }` |
| `GET /overview` | The space dashboard (existing endpoint). |

### Beneficiaries

A withdrawal goes to a beneficiary: any bank account the space has added, such as the rep's own, a lecturer's or a vendor's. The account holder doesn't have to be the rep, and there is no hold after adding one. The account name always comes from the bank's name enquiry.

| Endpoint | Behaviour |
|---|---|
| `POST /payout/beneficiaries/lookup` | Name enquiry without saving. Body: `{ "bankCode": "058", "accountNumber": "0123456789" }`. Returns `200` `{ bankCode, bankName, accountNumber (masked), accountName }`. |
| `GET /payout/beneficiaries` | Any rep. `[Beneficiary]`, newest first. |
| `POST /payout/beneficiaries` | Lead rep only. Body: `{ bankCode, accountNumber, label? }` (`label` up to 60 characters, e.g. `"Dr. Adeyemi (HOD)"`). Runs name enquiry and registers the account for withdrawals. `201` with the new `Beneficiary`, or `200` with the existing one if that account was already added. Every rep of the space is emailed. |
| `DELETE /payout/beneficiaries/:beneficiaryId` | Lead rep only. `200` `{ removed: true }`. Withdrawals already made to it are unaffected. |

`Beneficiary = { id, label, bankCode, bankName, accountNumber (masked), accountName, createdAt }`

`POST /payout/beneficiaries` errors: `409 KYC_NOT_VERIFIED`, `409 TOO_MANY_BENEFICIARIES` (25 per space), `422 ACCOUNT_UNVERIFIABLE`.

### `GET /payout/quote?amount=500000`

`200`: `{ amount, fee, net, feeBeforeDiscount, discount, discountPercent, minPayout, belowMinimum }`. `fee` is net of any partner discount (see Partners).

Duevy charges no withdrawal fee for now, so `fee` is `0` and `net` is the full amount. Bank78 charges its own transfer fee from the wallet; it is debited from the space's balance when the withdrawal succeeds, and the last one charged is held back from what can be withdrawn.

### 🔑 `POST /payout/request` (lead rep, or a co-rep for an assigned due)

- Body: `{ "amount": 500000, "beneficiaryId": "…", "pin": "4821", "dueId"?: "…", "note"?: "…" }`. `amount` is the gross in kobo.
- `dueId` draws on one due's collections. The lead may omit it to draw on the whole space. A co-rep must send it, and the due must be assigned to them (`POST /dues/:dueId/reassign`). The amount can't exceed what is left of that due (see `GET /payout/dues`). The money always leaves the lead rep's wallet, where collections are routed.
- `pin` is needed only in `pin` mode (see [Withdrawal security](#withdrawal-security)). It is the space's 4-digit security code, which the lead rep sets themselves (`PUT /payout/pin`). Five wrong codes lock it for 30 minutes. `GET /payout/summary` reports `withdrawalAuthMode`, `withdrawalPinSet`, `withdrawalPinLockedUntil` and `withdrawalPinHoldUntil`.
- Or send to a one-off account without saving it: `{ "amount": 500000, "bankCode": "058", "accountNumber": "0123456789" }`. It is name-checked and registered the same way, but not added to the beneficiaries. Send exactly one of `beneficiaryId`, or `bankCode` + `accountNumber` (else `400 VALIDATION_ERROR`).
- `201`: `Payout`. In `multisig` mode it is `awaiting_approval` and carries `approval` (below), including `otpSentToRequester: true` when the requester is a signatory and has been emailed their code.

`Payout = { id, amount, fee, net, reference, status, account, accountName, beneficiaryId, dueId, note, requestedById, requestedAt, approvalExpiresAt, processingAt, settledAt, failedAt, reversedAt, cancelledAt, failureReason }`

Withdrawal status moves `[awaiting_approval →] pending → processing → success | failed | reversed`. `awaiting_approval → cancelled` when a signatory rejects it, its requester withdraws it, it isn't approved within 24 hours, or the lead rep changes. On `failed`, `reversed` or `cancelled`, the full amount goes back to the balance (and to its due).

| Error | When |
|---|---|
| `403 KYC_NOT_VERIFIED` | The rep has not passed KYC. |
| `403 LEAD_KYC_NOT_VERIFIED` | A co-rep's request, but the lead rep's account can't make withdrawals yet. |
| `403 DUE_REQUIRED` | A co-rep didn't send `dueId`. |
| `403 DUE_NOT_ASSIGNED` | That due isn't assigned to the co-rep. |
| `409 SIGNATORIES_INCOMPLETE` | `multisig` mode, but the space has fewer than 3 signatories. |
| `404 BENEFICIARY_NOT_FOUND` | No beneficiary with that id in this space. |
| `422 ACCOUNT_UNVERIFIABLE` | The one-off account couldn't be verified with the bank. |
| `409 WITHDRAWAL_IN_PROGRESS` | Another withdrawal for this space is still in flight. |
| `422 INSUFFICIENT_BALANCE` | The amount is more than the balance. |
| `422 BELOW_MIN_PAYOUT` | Under the ₦1,000 minimum. |
| `423 PAYOUTS_FROZEN` | An admin has frozen withdrawals for this space. |
| `403 WITHDRAWAL_PIN_NOT_SET` | The lead rep hasn't set a withdrawal security code yet. |
| `403 INVALID_WITHDRAWAL_PIN` | Wrong code; `details[0].issue` says how many attempts are left. |
| `423 WITHDRAWAL_PIN_LOCKED` | Five wrong codes; locked for 30 minutes (a reset unlocks it). |
| `423 WITHDRAWAL_PIN_HOLD` | Withdrawal security changed in the last 24 hours: a code reset, a signatory change while approvals are on, or approvals switched off. |

### `GET /payout/dues`

The dues the caller can withdraw from: every due for the lead, the assigned ones for a co-rep. `200`: `[{ id, title, type, status, assignedRepId, available }]`, where `available` is what is left of the due, in kobo: its collections less the withdrawals made against it, less its share of withdrawals from the whole balance. Whole-balance withdrawals use up the dues the lead holds first, then co-reps' dues, oldest first, so the dues never add up to more than the balance.

### Withdrawal security

Each space picks how withdrawals are authorised (`withdrawalAuthMode` on `GET /payout/summary`):

- `pin` (default): the 4-digit security code below.
- `multisig`: the space has 3 signatories, the lead rep plus two co-reps the lead nominates. A withdrawal waits as `awaiting_approval`, with its funds reserved, until 2 signatories approve it. Each signatory approves with a one-time 6-digit code that Duevy emails them, along with the withdrawal's amount, destination, due and requester. The requester counts as one signature if they are a signatory. A co-rep who isn't a signatory needs two.

`GET /payout/summary` also returns `signatories: [{ id, name, email, role }]`, `signatoriesComplete` and `awaitingApprovalPayoutId`.

| Endpoint | Behaviour |
|---|---|
| `PUT /payout/signatories` | Lead only. `{ "userIds": [coRepId, coRepId], "password": "…" }` (0–2 co-reps). While approvals are on, you must keep two, and any change holds withdrawals for 24 hours and alerts every rep. `200`: `{ signatories, signatoriesComplete, withdrawalPinHoldUntil }`. |
| `PUT /payout/security` | Lead only. `{ "mode": "pin" \| "multisig", "password": "…" }`. Turning `multisig` on needs 3 signatories (`409 SIGNATORIES_INCOMPLETE`). Switching back to `pin` holds withdrawals for 24 hours. Every rep is notified either way. `200`: `{ withdrawalAuthMode, changed, withdrawalPinHoldUntil }`. |
| `POST /payout/:payoutId/otp` | A signatory asks for their code (valid 10 minutes, one request a minute: `429 OTP_RECENTLY_SENT`). `200`: `{ sent: true, expiresAt }`. |
| `POST /payout/:payoutId/approve` | `{ "otp": "123456" }`. `200`: `Payout` with `approval`. The second approval sends the withdrawal to the bank (`status` becomes `processing`). Errors: `403 INVALID_OTP` (attempts left in `details`), `423 OTP_LOCKED` (5 wrong codes; request a new one), `400 OTP_EXPIRED`, `409 ALREADY_SIGNED`, `403 NOT_A_SIGNATORY`, `409 NOT_AWAITING_APPROVAL`, `409 APPROVAL_EXPIRED`. |
| `POST /payout/:payoutId/reject` | `{ "reason"?: "…" }`. A signatory rejects it, or its requester withdraws it. No code needed. `200`: the cancelled `Payout`. |

`approval = { required: 2, approvedCount, signatoryIds, approvals: [{ userId, name, decision: "approved" | "rejected", decidedAt }] }`. `GET /payout/:payoutId` includes it for withdrawals that went through approval (else `null`).

Password errors on these endpoints are `403 INVALID_PASSWORD` and `409 PASSWORD_REQUIRED`.

### `PUT /payout/pin` (lead rep only)

Set or change the space's withdrawal security code.

- Body: `{ "pin": "4826", "password": "…", "currentPin"?: "1357" }`. The account password is always required. `currentPin` is required once a code exists.
- Repeated digits and straight runs (`1111`, `1234`, `4321`) are refused with `422 WEAK_PIN`.
- `200`: `{ withdrawalPinSet: true, change: "set" | "changed", withdrawalPinHoldUntil }`.
- Errors: `403 INVALID_PASSWORD`, `409 PASSWORD_REQUIRED` (a Google-only account must create a password first), `403 INVALID_WITHDRAWAL_PIN` (wrong `currentPin`, counted toward the lockout).

### `POST /payout/pin/reset` (lead rep only)

For a forgotten code: `{ "pin", "password" }` sets a new code without the current one. Withdrawals are then held for 24 hours (`withdrawalPinHoldUntil`), every rep is notified and the lead rep is emailed. `200`: `{ withdrawalPinSet: true, change: "reset", withdrawalPinHoldUntil }`.

Every set, change and reset is written to the space audit log. The code is cleared whenever the lead rep changes (admin assignment or `POST /transfer-lead`), so a new lead sets their own. On `POST /transfer-lead` the old lead takes the new lead's signatory seat, so a `multisig` space keeps its 3 signatories.

### Team

| Endpoint | Behaviour |
|---|---|
| `GET /reps` | Any rep. `[{ id, name, email, role: "lead" \| "co", isSignatory, kycVerified, assignedDues, addedAt }]`. |
| `POST /reps` | Lead only. `{ "userId": "…" }`: a member of the space becomes a co-rep. `201` with the rep. Errors: `404` (not a member), `409 ALREADY_REP`, `409 USER_INACTIVE`. |
| `DELETE /reps/:userId` | Lead only. Removes a rep. Their due assignments are cleared. |
| `POST /dues/:dueId/reassign` | Lead only. `{ "userId": coRepId }`: assigns the due to a co-rep, who can then withdraw its collections. |

`GET /payouts` lists withdrawals and `GET /payout/:payoutId` returns one.

### `GET /banks`

`200`: `[{ code, name }]`, the bank list from Bank78.

---

## Feedback

### `POST /feedback`

Any signed-in user. Body: `{ "category": "bug" | "idea" | "other", "message": "10–2000 chars", "page"?: "/dashboard/dues" }`. The `User-Agent` header is stored with it. Limited to 5 per 10 minutes per user (`429 RATE_LIMITED`).

`201`: `{ id, category, message, page, userAgent, status: "new", adminNote, resolvedAt, createdAt, user: { id, name, email, role } }`.

---

## Partners

Partners (SUG, NACOS, …) each have a code. A rep who signs up with a code, or whose lead rep applies one later, gets a percentage off the space's withdrawal fees. Behind `FEATURE_PARTNERS`; every route below `404`s when it is off.

`PartnerPreview = { code, name, short, logoUrl, withdrawalFeeDiscountPercent, durationDays }`. `durationDays` is `null` for a discount with no end date.

`SpacePartner = { id, partner: PartnerPreview, source: "signup" | "settings" | "admin", discountPercent, endsAt, active, createdAt }`. `discountPercent` and `endsAt` are fixed when the code is redeemed, so later edits to the partner don't change them. `active` turns `false` once `endsAt` passes.

Code errors are all `422` with `details: [{ field: "partnerCode" }]`:

| Error | When |
|---|---|
| `INVALID_PARTNER_CODE` | Unknown or deactivated code. |
| `PARTNER_CODE_EXPIRED` | Past the partner's `expiresAt`. |
| `PARTNER_CODE_EXHAUSTED` | `maxRedemptions` reached. |

### `GET /partners/lookup?code=NACOS` (public)

`200`: `PartnerPreview`, for the signup form's preview. Rate-limited to 10 a minute.

### `GET /spaces/:spaceId/partner` (any rep of the space)

`200`: `SpacePartner | null`. A revoked redemption returns `null`.

### `POST /spaces/:spaceId/partner` (lead rep only)

Body: `{ "code": "NACOS" }`. `201`: `SpacePartner`. A space has at most one partner: `409 PARTNER_ALREADY_APPLIED`, including after an admin revokes it. Written to the space audit log as `partner_applied`.

### At signup

`POST /auth/register` and `POST /auth/google` accept `partnerCode` (up to 20 characters) when `role = "rep"`. A bad code fails the signup with one of the errors above. A good one is redeemed for the rep's space when an admin approves the application (`source: "signup"`); if it has expired or run out by then, approval still goes through without it and the reason is in the `rep.verify` audit entry.

### Effect on withdrawals

- `GET /payout/quote` adds `feeBeforeDiscount`, `discount` and `discountPercent` (`0` with no partner). `fee` and `net` are already discounted.
- `GET /payout/summary` adds `partner: SpacePartner | null` (only while active), and its `fees` tiers are already discounted.
- `Payout` adds `feeDiscount` (kobo).
- While Duevy takes no withdrawal fee, a discount has nothing to take off: `fee` is `0` either way. Bank78's own transfer fee is never discounted.

---

## Public metrics

### `GET /public/metrics` (public)

Aggregate-only traction figures for duevy.app/metrics. No auth. Cached for 10 minutes (stale figures are served if a refresh fails); `Cache-Control: public, max-age=300`. Never includes anything that identifies a user, space or due.

`200`: `{ students, reps, spaces, campuses, volume, payments, payouts, monthly: [{ month: "YYYY-MM", volume, payments }], updatedAt }`.

- `students`: non-admin, non-guest, non-deactivated accounts (reps included).
- `reps`: approved reps who aren't suspended or deactivated.
- `spaces` / `campuses`: unarchived spaces and their distinct institutions.
- `volume` / `payments`: lifetime paid checkouts — what students paid (kobo, fees included) and how many.
- `payouts`: successful withdrawals.
- `monthly`: Lagos calendar months, oldest first, at most 12, starting at the first month with a payment.

`503 METRICS_UNAVAILABLE` if the figures can't be computed and nothing is cached.

---

## Admin

### `DELETE /admin/spaces/:spaceId/withdrawal-pin` (`payouts` permission)

Clears the space's withdrawal code, for example when a rep's account may be compromised. Admins never set or see codes. Withdrawals stop until the lead rep sets a new code, and every rep is notified. `200`: `{ withdrawalPinSet: false }`. `GET /admin/spaces` rows carry `withdrawalPinSet`, `withdrawalPinSetAt`, `withdrawalPinLocked` and `withdrawalPinHoldUntil`.

Also: `POST /admin/users/:userId/kyc/review` only accepts `decision: "rejected"`. Identity verification is Didit's decision, so an admin can revoke it but never grant it. `PATCH /me` refuses an email change (`422 EMAIL_CHANGE_NOT_ALLOWED`). `POST /spaces/:spaceId/reps/invite` and the dues `allowGuests` field are removed. Co-reps are now added with `POST /spaces/:spaceId/reps`.

`role = admin` is required. Each route also checks the permission named in its row; a super admin has every permission.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/reps/applications?status=pending` | userManagement | Reps waiting for approval. Each row: `{ userId, applicant, status, requestedSpace, submittedAt, … }`. |
| `POST /admin/reps/:repId/verify` | userManagement | Approves the rep: sets `isRep` and creates the space from the application. Body: `{ note? }`. |
| `POST /admin/reps/:repId/reject` | userManagement | Body: `{ reason }`. |
| `GET /admin/reps` | userManagement | Reps with their collections. |
| `GET /admin/kyc/student-ids?status=pending` | userManagement | Student ID cards to review: `[{ userId, name, email, matricNo, institution, kycStatus, studentId: { status, mimeType, uploadedAt, reviewedAt, reviewNote, viewUrl, viewUrlExpiresInSeconds } }]`. `viewUrl` is a signed ImageKit link that expires after 10 minutes. |
| `POST /admin/users/:userId/student-id/review` | userManagement | Body: `{ "decision": "approved" | "rejected", "note"? }`; a note is required to reject. The rep is notified. |
| `GET /admin/spaces?q=&school=&type=` | userManagement | `[{ id, name, short, kind, school, memberCount, duesTarget, collectedAmount, assignedRepIds, isArchived, payoutsFrozen }]` |
| `GET /admin/transactions?type=&status=&spaceId=&userId=&from=&to=` | userManagement | Every transaction. |
| `GET /admin/checkouts?status=&needsReview=true&overpaid=true&spaceId=` | userManagement | The review queue: underpaid, overpaid, late and duplicate payments. |
| `POST /admin/checkouts/:reference/resolve` | overrides | Clears a review flag. Body: `{ note }`. |
| `GET /admin/payouts?status=&spaceId=` | payouts | Every withdrawal. |
| `GET /admin/health` | userManagement | `{ deadWebhooks, retryingWebhooks, stuckPayouts, checkoutsNeedingReview, unresolvedCheckouts, unsettledWithdrawalFees, pendingStudentIds, healthy, recentWebhookFailures }` |
| `POST /admin/reps/:repId/freeze-payouts` · `/unfreeze-payouts` | payouts | Freezes or unfreezes the rep's withdrawals. |
| `GET /admin/feedback?status=&category=&q=` | userManagement | Feedback inbox, newest first; `status` is `new` or `resolved`, `category` is `bug`, `idea` or `other`. Rows as in `POST /feedback`. `meta.unresolved` is the count of `new` feedback (for a badge). |
| `POST /admin/feedback/:id/resolve` · `/reopen` | userManagement | Marks it resolved (body: `{ note? }`, kept as `adminNote`) or back to `new`. Both are audit-logged. |
| `GET /admin/partners?q=&status=all\|active\|inactive` | payouts | `[{ id, name, short, code, logoUrl, withdrawalFeeDiscountPercent, durationDays, maxRedemptions, expiresAt, isActive, redemptionCount, createdAt, updatedAt }]`. `redemptionCount` leaves out revoked ones. |
| `POST /admin/partners` | payouts | Body: `{ name, short, code, withdrawalFeeDiscountPercent (1–100), logoUrl?, durationDays?, maxRedemptions?, expiresAt?, isActive? }`. `code` is 3–20 letters, numbers or dashes, stored uppercase. `409 PARTNER_CODE_TAKEN`. Audit-logged as `partner.create`. |
| `PATCH /admin/partners/:partnerId` | payouts | Any of the fields above. Doesn't change spaces that already redeemed the code. Audit-logged as `partner.update`. |
| `POST /admin/partners/logo` | payouts | `multipart/form-data` with a `file` part (JPEG, PNG or WebP, up to 2 MB). `200`: `{ logoUrl }`. |
| `GET /admin/partners/:partnerId/redemptions` | payouts | `[{ id, space: { id, name, short }, redeemedBy: { id, name, email }, source, discountPercent, endsAt, revokedAt, createdAt }]` |
| `POST /admin/partner-redemptions/:redemptionId/revoke` | payouts | Ends the space's discount now. Idempotent. Audit-logged as `partner.redemption_revoke`. |

---

## Webhook

### `POST /webhooks/bank78`

Public. It authenticates only by signature: `X-Bank78-Webhook-Signature` is HMAC-SHA256 (hex) of `"<X-Bank78-Webhook-Timestamp>.<raw body>"` with the merchant profile's Webhook Secret, version `v1`. The merchant profile must send API version 2 payloads (`{ eventType, data }`).

| Response | When |
|---|---|
| `200` | The event was stored (deduplicated by its stable reference), or it was authenticated but unreadable and was dead-lettered. |
| `401` | The signature is missing, bad or stale. |
| `503` | The event could not be stored, so Bank78 retries it. |

Events Duevy acts on:

| Event | Effect |
|---|---|
| `virtual-nuban-transaction-credit` | The checkout (`accountReference`) is paid, then its face amount is routed to the rep's wallet. Deduplicated by `sessionId`. |
| `transfer.success` | The withdrawal (`reference`) succeeds; Bank78's `fee` is debited from the balance. |

Anything else is acknowledged and ignored.

---

## Removed or changed in this release

- `POST /webhooks/bachs` and `/webhooks/anchor` are gone; use `/webhooks/bank78`.
- KYC is phone OTP + NIN with Didit: `POST /payout/kyc/phone/send` and `/phone/verify` are new and must come first. `bvn` is now required by `POST /payout/kyc`, and `phone` and `governmentId` are no longer accepted; `/kyc/government-id` and `/kyc/payout-destination(/lookup)` are removed. The KYC state lost `requirementsDue`, `governmentIdSubmittedAt` and `payoutDestination`, and gained `phone` and `wallet`.
- The checkout fee is 1.5% (was 2% + ₦20). Withdrawals carry no Duevy fee; `GET /payout/summary` `fees` is now `{ duevyFeeKobo, bankFeeKobo }`.
- `GET|PUT /admin/settings/payments` (hosted vs custom checkout) is removed: every checkout is a bank transfer.
- `POST /payout/kyc/upgrade` is removed, along with KYC tiers and the ₦300,000 balance ceiling.
- `POST /payout/kyc` is now `multipart/form-data` and takes a **NIN** (not a BVN) plus a `studentIdCard` file. A space can only collect once an admin approves the card.
- `POST /payout/:id/approve`, `POST /payout/:id/cancel`, `GET|POST /dues/:dueId/payout/*` are removed (approval quorum and co-rep payouts are out of scope).
- `POST /dues/pay` no longer accepts `discountCode` or `method: "card"`. Guest payers are refused.
- `POST /polls/:slug/votes` on a paid poll returns `501 PAID_VOTING_UNAVAILABLE`. Free polls still work.
- `/payments/:reference/status` statuses are now `pending | paid | expired | underpaid`. They used to be `completed | failed | pending`.
- Payout statuses are now `pending | processing | success | failed | reversed`. Payout responses gained `fee` and `net`; `duevyFee` and `netSent` stay as deprecated aliases.
- Dues have `type` (with `category` kept as an alias) and the new set of types. Old categories were mapped: `levy` → `departmental_due`, everything else → `other`.
