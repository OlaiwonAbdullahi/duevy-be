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
  "acceptedTerms": true, "role": "student" | "rep",
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

- Body: `{ "title", "note"?, "amount": 500000, "dueDate": "YYYY-MM-DD", "type": "departmental_due", "publish"?: false }`.
- `201`: `RepDue`.

`RepDue = { id, spaceId, title, note, amount, dueDate, type, category, status: "draft"|"active"|"closed", paidCount, memberCount, publishedAt, closedAt, createdAt }`

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

`processingFee` and `payableAmount` are what the due would cost **on its own**. A checkout charges the ₦20 once for the whole basket, so several dues together cost less than the sum of these figures.

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
  "amount": 665000,
  "breakdown": { "face": 650000, "fee": 15000, "total": 665000 },
  "items": [{ "dueId": "…", "title": "…", "amount": 500000, "fee": 11538 }],
  "bankTransfer": { "accountNumber": "9902847361", "bankName": "…", "accountName": "…", "amountKobo": 665000, "expiresAt": "…" },
  "checkoutUrl": null,
  "expiresAt": "…", "paidAt": null, "receivedKobo": null, "overpaidKobo": 0, "reused": false
}
```

The fee is 2% of the face value (rounded half-up to the kobo) plus ₦20. The student pays the fee on top, and the space receives the full face value.

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

KYC has two parts, and a space collects only when **both** pass:

- **Identity, verified by Bachs:** NIN + date of birth. A BVN is not required; Bachs may ask for one (or an ID document) later, and `requirementsDue` says so.
- **Student status, verified by a Duevy admin:** the rep's student ID card.

### `POST /payout/kyc` (`multipart/form-data`)

| Part | Required | Notes |
|---|---|---|
| `nin` | yes | 11 digits. Sent to Bachs; never stored or logged. |
| `dob` | yes | `YYYY-MM-DD`. Sent to Bachs; never stored or logged. |
| `gender` | yes | `male` or `female`. Validated; Bachs has no field for it. |
| `studentIdCard` | yes | File: JPEG, PNG, WebP or PDF, max 5 MB, checked by its bytes. Stored privately in ImageKit for admin review. |
| `governmentId` | no | File, same rules. Forwarded to Bachs, only useful when it asks for an ID document. |
| `bvn` | no | 11 digits. Only if Bachs asks for it. |
| `firstName`, `lastName`, `phone` | no | `phone` in E.164, any country (e.g. `+2348012345678`, `+447911123456`). Names default to the account name. |

`202`:

```json
{ "kycStatus": "pending", "payoutsActive": false, "canCollect": false, "canWithdraw": false, "providerReference": "per_…",
  "requirementsDue": [], "governmentIdSubmittedAt": null,
  "studentId": { "status": "pending", "uploadedAt": "…", "reviewedAt": null, "reviewNote": null },
  "rejectionReason": null, "retryLockedUntil": null, "submittedAt": "…", "resolvedAt": null }
```

The Bachs verdict arrives by webhook. Validation errors never echo the NIN, BVN or date of birth.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | Bad field, missing `studentIdCard`, or a file that isn't really a JPEG/PNG/WebP/PDF. |
| `413 FILE_TOO_LARGE` | A file over 5 MB. |

| Error | When |
|---|---|
| `403 REP_NOT_APPROVED` | The caller is not an approved rep. |
| `409 ALREADY_VERIFIED`, `409 KYC_PENDING` | Already verified, or a verification is already under review. |
| `422 KYC_REJECTED` | Bachs refused the details. |
| `429 KYC_RETRY_LOCKED` | Three failed attempts; retries are locked for 24 hours. |

### `POST /payout/kyc/student-id` (`multipart/form-data`)

Replaces the student ID card after an admin rejected it (or if none was sent). Part: `studentIdCard`. Returns `202` with the KYC state. `409 STUDENT_ID_PENDING` / `STUDENT_ID_APPROVED` if there is nothing to replace.

### `POST /payout/kyc/government-id` (`multipart/form-data`)

Forwards a government ID document to Bachs, for when `requirementsDue` asks for one. Part: `governmentId`. Returns `202`. `409 KYC_NOT_STARTED` before the first submission.

### `POST /payout/kyc/payout-destination` (also `/me/kyc/payout-destination`)

The rep's own bank account. Collected during onboarding right after the NIN + student ID submission, and again whenever Bachs lists `payout_destination` in `requirementsDue`. Bachs won't finish onboarding (and payouts stay off) until it has one. Once accepted it's saved (masked) and returned as `payoutDestination` on the KYC state: `{ bankCode, bankName, accountNumber (masked), accountName, submittedAt }`, or `null` until sent. Body: `{ "bankCode": "058", "accountNumber": "0123456789" }`. The account is name-checked and the bank's name is sent to Bachs. `200` with the refreshed KYC state. Errors: `409 KYC_NOT_STARTED`, `422 ACCOUNT_UNVERIFIABLE`, `422 PAYOUT_DESTINATION_REJECTED` (Bachs refused it).

`POST /me/kyc/payout-destination/lookup` (also `/payout/kyc/payout-destination/lookup`) with the same body runs the name check without sending anything: `200` `{ bankCode, bankName, accountNumber (masked), accountName }`.

This is separate from beneficiaries: it only tells Bachs where the rep's account would pay out by default. Withdrawals still go to the beneficiary or account chosen each time.

### `GET /payout/kyc-status`

`200`: the space lead's KYC state (shape above) plus `mine`, the caller's own state.

### `GET /payout/summary` (rep dashboard)

`200`:

```json
{ "available": 900000, "balance": 900000, "collected": 900000, "withdrawn": 0, "withdrawalFees": 0, "inFlight": 0,
  "kyc": { … }, "beneficiaryCount": 1, "minPayout": 100000,
  "fees": { "below": { "thresholdKobo": 5000000, "feeKobo": 10000 }, "atOrAbove": { "thresholdKobo": 5000000, "feeKobo": 20000 } } }
```

The balance always comes from the ledger.

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
| `POST /payout/beneficiaries` | Lead rep only. Body: `{ bankCode, accountNumber, label? }` (`label` up to 60 characters, e.g. `"Dr. Adeyemi (HOD)"`). Runs name enquiry and registers the account with Bachs. `201` with the new `Beneficiary`, or `200` with the existing one if that account was already added. Every rep of the space is emailed. |
| `DELETE /payout/beneficiaries/:beneficiaryId` | Lead rep only. `200` `{ removed: true }`. Withdrawals already made to it are unaffected. |

`Beneficiary = { id, label, bankCode, bankName, accountNumber (masked), accountName, createdAt }`

`POST /payout/beneficiaries` errors: `409 KYC_NOT_VERIFIED`, `409 TOO_MANY_BENEFICIARIES` (25 per space), `422 ACCOUNT_UNVERIFIABLE`.

### `GET /payout/quote?amount=500000`

`200`: `{ amount, fee, net, minPayout, belowMinimum }`.

The fee is ₦100 under ₦50,000 and ₦200 from ₦50,000. It is deducted from the withdrawal.

### 🔑 `POST /payout/request` (lead rep only)

- Body: `{ "amount": 500000, "beneficiaryId": "…", "note"?: "…" }`. `amount` is the gross in kobo.
- Or send to a one-off account without saving it: `{ "amount": 500000, "bankCode": "058", "accountNumber": "0123456789" }`. It is name-checked and registered with Bachs the same way, but not added to the beneficiaries. Send exactly one of `beneficiaryId`, or `bankCode` + `accountNumber` (else `400 VALIDATION_ERROR`).
- `201`: `Payout`.

`Payout = { id, amount, fee, net, reference, status, account, accountName, beneficiaryId, note, requestedById, requestedAt, processingAt, settledAt, failedAt, reversedAt, failureReason }`

Withdrawal status moves `pending → processing → success | failed | reversed`. On `failed` or `reversed`, the full amount goes back to the balance.

| Error | When |
|---|---|
| `403 KYC_NOT_VERIFIED` | The rep has not passed KYC. |
| `404 BENEFICIARY_NOT_FOUND` | No beneficiary with that id in this space. |
| `422 ACCOUNT_UNVERIFIABLE` | The one-off account couldn't be verified with the bank. |
| `409 WITHDRAWAL_IN_PROGRESS` | Another withdrawal for this space is still in flight. |
| `422 INSUFFICIENT_BALANCE` | The amount is more than the balance. |
| `422 BELOW_MIN_PAYOUT` | Under the ₦1,000 minimum. |
| `423 PAYOUTS_FROZEN` | An admin has frozen withdrawals for this space. |

`GET /payouts` lists withdrawals and `GET /payout/:payoutId` returns one.

### `GET /banks`

`200`: `[{ code, name }]`, the bank list from Bachs.

---

## Admin

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

---

## Webhook

### `POST /webhooks/bachs`

Public. It authenticates only by signature: `X-Bachs-Signature-V2: t=…,v1=…`, with `X-Bachs-Signature` plus `X-Bachs-Timestamp` as the legacy fallback.

| Response | When |
|---|---|
| `200` | The event was stored (deduplicated by event id), or it was authenticated but unreadable and was dead-lettered. |
| `401` | The signature is bad or stale. |
| `503` | The event could not be stored, so Bachs retries it. |

Events Duevy acts on:

| Event | Effect |
|---|---|
| `collection.succeeded` (`SUCCEEDED`, `ACCEPTED`, `OVERPAID`) | The checkout is paid. |
| `collection.underpaid` | The checkout is marked underpaid. |
| `collection.failed` / `checkout.expired` | The checkout expires. |
| `payout.paid` / `payout.failed` | The withdrawal succeeds, or fails or is reversed. |
| `account.updated` / `capability.updated` | Duevy re-reads the rep's KYC state. |

Anything else is acknowledged and ignored.

---

## Removed or changed in this release

- `POST /webhooks/anchor` is gone; use `/webhooks/bachs`.
- `POST /payout/kyc/upgrade` is removed, along with KYC tiers and the ₦300,000 balance ceiling.
- `POST /payout/kyc` is now `multipart/form-data` and takes a **NIN** (not a BVN) plus a `studentIdCard` file. A space can only collect once an admin approves the card.
- `POST /payout/:id/approve`, `POST /payout/:id/cancel`, `GET|POST /dues/:dueId/payout/*` are removed (approval quorum and co-rep payouts are out of scope).
- `POST /dues/pay` no longer accepts `discountCode` or `method: "card"`. Guest payers are refused.
- `POST /polls/:slug/votes` on a paid poll returns `501 PAID_VOTING_UNAVAILABLE`. Free polls still work.
- `/payments/:reference/status` statuses are now `pending | paid | expired | underpaid`. They used to be `completed | failed | pending`.
- Payout statuses are now `pending | processing | success | failed | reversed`. Payout responses gained `fee` and `net`; `duevyFee` and `netSent` stay as deprecated aliases.
- Dues have `type` (with `category` kept as an alias) and the new set of types. Old categories were mapped: `levy` → `departmental_due`, everything else → `other`.
