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

`processingFee` and `payableAmount` are what the due would cost **on its own**: the 1.5% processing fee, rounded up to the kobo. A basket's fee is 1.5% of its total, so it can differ from the sum of these by a kobo or two.

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
  "bankTransfer": { "accountNumber": "9000001277", "bankName": "9jaPay", "accountName": "…", "amountKobo": 659750, "expiresAt": "…" },
  "checkoutUrl": null,
  "expiresAt": "…", "paidAt": null, "receivedKobo": null, "overpaidKobo": 0, "reused": false
}
```

Show the student the one-time account in `bankTransfer`. It accepts exactly `amountKobo` (any other amount is refused at the bank) and closes at `expiresAt`. `checkoutUrl` is always `null` now; hosted checkout pages went with Bachs.

The fee is a 1.5% processing fee on the face value, rounded up to the kobo, shown separately and paid on top. It covers 9jaPay's charges. The space receives the full face value.

Rules:

- Every due must be `active`Rules:

- Every due must be `active` and belong to the same space (otherwise `422 MIXED_SPACES`).
- The caller must have joined the space (otherwise `403 NOT_A_MEMBER`).
- No due may already be paid (otherwise `409 DUE_ALREADY_PAID`).
- The space's lead rep must have passed KYC: identity verified and student ID approved (otherwise `409 SPACE_NOT_VERIFIED`).
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

The money is the **space's**, never the rep's. Each space has its own 9jaPay account (`account` on `GET /payout/summary`); reps manage it. KYC records who is accountable for the space, so a new rep verifies before they can act.

Which checks a rep must pass is set by an admin (`PUT /admin/settings/kyc`), and a space collects only when **every required check** passes. Read the current set from `requirements` in any KYC state (e.g. `GET /me/kyc-status`) and build the form from it.

- **Student ID** (always required): the rep's student ID card, approved by a Duevy admin.
- **Face capture / liveness** (`requirements.liveness`, **on** by default): a photo or short video of the rep's face, taken in the app, approved by a Duevy admin who sees it next to the student ID card. No third party is involved.
- **NIN** (`requirements.nin`, **off** by default): NIN + date of birth, checked against NIMC (through Didit) as you submit. While off it is optional and ignored: nothing is sent to Didit or stored.

### `POST /payout/kyc` (`multipart/form-data`) (also `/me/kyc`)

| Part | Required | Notes |
|---|---|---|
| `studentIdCard` | yes | File: JPEG, PNG, WebP or PDF, max 5 MB, checked by its bytes. Stored privately in ImageKit for admin review. |
| `liveness` | while `requirements.liveness` | File: the face capture. A JPEG/PNG/WebP photo, or an MP4/MOV/WebM video (what a browser's `MediaRecorder` produces), max 15 MB, checked by its bytes. Stored privately for admin review. Not needed if one is already pending or approved. |
| `nin` | while `requirements.nin` | 11 digits. Checked, never stored or logged. Ignored while NIN is off. |
| `dob` | while `requirements.nin` | `YYYY-MM-DD`. Checked, never stored or logged. Ignored while NIN is off. |

Fields older clients still send (`gender`, `bvn`, `firstName`, `lastName`, `phone`, a `governmentId` file) are ignored. The NIN is checked under the name on the rep's account.

`202`, with the result already known:

```json
{ "kycStatus": "unverified", "canCollect": false, "canWithdraw": false,
  "requirements": { "nin": false, "studentId": true, "liveness": true },
  "nin": { "outcome": null, "reviewStatus": null, "reviewNote": null },
  "studentId": { "status": "pending", "uploadedAt": "…", "reviewedAt": null, "reviewNote": null },
  "liveness": { "status": "pending", "uploadedAt": "…", "reviewedAt": null, "reviewNote": null },
  "rejectionReason": null, "retryLockedUntil": null, "submittedAt": "…", "resolvedAt": "…",
  "payoutsActive": false, "requirementsDue": [] }
```

`kycStatus` is the NIN check's own status; whether the rep is verified is `canCollect`.

| NIN check (only while required) | Result |
|---|---|
| Match | `kycStatus: "verified"`. Collection opens once the student ID is approved. |
| Partial match (name or date of birth only partly matched) | `kycStatus: "pending"`, `nin.reviewStatus: "pending"`. An admin decides; the rep is notified. |
| No match | `422 KYC_REJECTED`; counts as a failed attempt. |
| NIMC unreachable, or Didit refuses our account | `503 KYC_PROVIDER_UNAVAILABLE`; not counted. Try again later. |
| Didit refuses the request as sent (usually the name) | `422 KYC_INPUT_UNREADABLE`; not counted. |

`payoutsActive` and `requirementsDue` are deprecated: always `canWithdraw` and `[]`. Validation errors never echo the NIN or date of birth.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | Bad field; missing `studentIdCard`; missing `liveness` or `nin`/`dob` while required; a file that isn't really the allowed type. |
| `413 FILE_TOO_LARGE` | A student ID over 5 MB, or a face capture over 15 MB. |
| `403 REP_NOT_APPROVED` | The caller is not a rep or rep applicant. |
| `409 ALREADY_VERIFIED`, `409 KYC_PENDING` | Already verified, or a partial match is awaiting review. |
| `422 KYC_REJECTED` | The NIN and date of birth didn't match the register. |
| `429 KYC_RETRY_LOCKED` | Three failed attempts; retries are locked for 24 hours. |
| `503 KYC_PROVIDER_UNAVAILABLE` | The identity check couldn't be reached. |

### `POST /payout/kyc/student-id` (`multipart/form-data`)

Replaces the student ID card after an admin rejected it (or if none was sent). Part: `studentIdCard`. Returns `202` with the KYC state. `409 STUDENT_ID_PENDING` / `STUDENT_ID_APPROVED` if there is nothing to replace.

### `POST /payout/kyc/liveness` (`multipart/form-data`) (also `/me/kyc/liveness`)

A new face capture: the first one, a retake after an admin rejected it, or a real capture for a rep verified before liveness existed. Part: `liveness` (as above). Returns `202` with the KYC state. `409 LIVENESS_PENDING` while one awaits review; `409 LIVENESS_APPROVED` if an approved capture is already on file.

### `GET /payout/kyc-status`

`200`: the space lead's KYC state (shape above) plus `mine`, the caller's own state.

### `GET` / `PUT /me/withdrawal-pin` (rep applicant)

A rep applicant chooses the department's withdrawal code during onboarding, before the space exists. `GET` returns `{ withdrawalPinSet }`. `PUT { pin: "2580", password }` saves it (re-saving while pending replaces it) and returns `{ withdrawalPinSet: true }`. The code becomes the space's code when an admin approves the application. After that it's managed with `PUT /payout/pin`.

- `403 INVALID_PASSWORD`, `409 PASSWORD_REQUIRED` (no password on the account), `422 WEAK_PIN` (1111/1234-style), `400 VALIDATION_ERROR`.
- `404` on `GET` / `409 NOT_PENDING` on `PUT`: no pending rep application.

### `GET /payout/summary` (rep dashboard)

`200`:

```json
{ "available": 900000, "balance": 900000, "collected": 900000, "withdrawn": 0, "withdrawalFees": 0, "inFlight": 0,
  "kyc": { … }, "beneficiaryCount": 1, "minPayout": 100000, "maxPayout": 50000000,
  "account": { "accountNumber": "9000002133", "accountName": "DUEVY/Computer Science Department", "bankName": "9jaPay" },
  "funds": { "inSpaceAccountKobo": 400000, "awaitingSweepKobo": 500000, "dailyLimitKobo": 500000000, "dailyRemainingKobo": 500000000 },
  "fees": { "bands": [
    { "fromKobo": 0, "toKobo": 500000, "feeKobo": 1000 },
    { "fromKobo": 500000, "toKobo": 10000000, "feeKobo": 1500 },
    { "fromKobo": 10000000, "toKobo": null, "feeKobo": 2000 } ] } }
```

The balance always comes from the ledger.

- `account` is the space's own 9jaPay account, or `null` while it's being opened (withdrawals wait for it).
- `funds` splits the balance by where it sits: already in the space's account, or still in Duevy's account awaiting the daily sweep. Withdrawals sweep what they need first, so the whole balance can be withdrawn.
- Withdrawals: ₦1,000 to ₦500,000 each (`minPayout`, `maxPayout`), and at most ₦5,000,000 per space per Lagos day (`dailyLimitKobo`). `dailyRemainingKobo` is what the space can still withdraw today.
- `fees.bands` is 9jaPay's transfer charge by withdrawal amount (`toKobo` exclusive, `null` = no upper bound).

### Other dashboard reads

| Endpoint | Returns |
|---|---|
| `GET /ledger` | `[{ id, type, direction, amount, signedAmount, reference, description, dueId, payoutId, createdAt }]`, newest first. Types: `due_payment`, `manual_credit`, `direct_deposit` (money sent straight to the space's account number; `description` names the sender), `payout`, `payout_fee`, `payout_reversal`, `refund`. |
| `GET /payout/breakdown?from=&to=` | Collections per due: `{ totals: { collected, fees, net, paidCount }, byDue: [{ dueId, title, type, paidCount, collected, fees, net }] }` |
| `GET /overview` | The space dashboard (existing endpoint). |

### Beneficiaries

A withdrawal goes to a beneficiary: any bank account the space has added, such as the department's own, a lecturer's, a vendor's or a rep's. The account holder doesn't have to be the rep, and there is no hold after adding one. The account name always comes from the bank's name enquiry.

| Endpoint | Behaviour |
|---|---|
| `POST /payout/beneficiaries/lookup` | Name enquiry without saving. Body: `{ "bankCode": "058", "accountNumber": "0123456789" }`. Returns `200` `{ bankCode, bankName, accountNumber (masked), accountName }`. |
| `GET /payout/beneficiaries` | Any rep. `[Beneficiary]`, newest first. |
| `POST /payout/beneficiaries` | Lead rep only. Body: `{ bankCode, accountNumber, label? }` (`label` up to 60 characters, e.g. `"Dr. Adeyemi (HOD)"`). Runs name enquiry and saves it on the space; a rep handover leaves it in place. `201` with the new `Beneficiary`, or `200` with the existing one if that account was already added. Every rep of the space is emailed. |
| `DELETE /payout/beneficiaries/:beneficiaryId` | Lead rep only. `200` `{ removed: true }`. Withdrawals already made to it are unaffected. |

`Beneficiary = { id, label, bankCode, bankName, accountNumber (masked), accountName, createdAt }`

`POST /payout/beneficiaries` errors: `409 KYC_NOT_VERIFIED`, `409 TOO_MANY_BENEFICIARIES` (25 per space), `422 ACCOUNT_UNVERIFIABLE`.

### `GET /payout/quote?amount=500000`

`200`: `{ amount, fee, net, minPayout, maxPayout, belowMinimum, aboveMaximum, dailyRemaining }`.

The fee is 9jaPay's transfer charge, passed on: ₦10 under ₦5,000, ₦15 under ₦100,000, ₦20 from ₦100,000. It is deducted from the withdrawal.

### 🔑 `POST /payout/request` (lead rep, or a co-rep for an assigned due)

- Body: `{ "amount": 500000, "beneficiaryId": "…", "pin": "4821", "dueId"?: "…", "note"?: "…" }`. `amount` is the gross in kobo.
- `dueId` draws on one due's collections. The lead may omit it to draw on the whole space. A co-rep must send it, and the due must be assigned to them (`POST /dues/:dueId/reassign`). The amount can't exceed what is left of that due (see `GET /payout/dues`). The money always leaves the space's own account.
- `pin` is needed only in `pin` mode (see [Withdrawal security](#withdrawal-security)). It is the space's 4-digit security code, which the lead rep sets themselves (`PUT /payout/pin`). Five wrong codes lock it for 30 minutes. `GET /payout/summary` reports `withdrawalAuthMode`, `withdrawalPinSet`, `withdrawalPinLockedUntil` and `withdrawalPinHoldUntil`.
- Or send to a one-off account without saving it: `{ "amount": 500000, "bankCode": "058", "accountNumber": "0123456789" }`. It is name-checked the same way, but not added to the beneficiaries. Send exactly one of `beneficiaryId`, or `bankCode` + `accountNumber` (else `400 VALIDATION_ERROR`).
- `201`: `Payout`. If part of the amount is still awaiting the daily sweep, it is swept first and the withdrawal stays `pending` until that lands (usually moments). In `multisig` mode it is `awaiting_approval` and carries `approval` (below), including `otpSentToRequester: true` when the requester is a signatory and has been emailed their code.

`Payout = { id, amount, fee, net, reference, status, account, accountName, summary, beneficiaryId, dueId, note, requestedById, requestedAt, approvalExpiresAt, processingAt, settledAt, failedAt, reversedAt, cancelledAt, failureReason }`

`summary` is the line to show the rep, true to the status: `"You sent NGN3000 to Abdullahi Olaiwon"` once it has arrived, `"Sending NGN3000 to …"` while on its way, `"NGN3000 to …, awaiting approval"`, or `"Couldn't send NGN3000 to …"`. The recipient's bank statement reads `"Duevy/CSC sent you NGN3000"` (the space's code and the amount that lands).

Withdrawal status moves `[awaiting_approval →] pending → processing → success | failed | reversed`. `awaiting_approval → cancelled` when a signatory rejects it, its requester withdraws it, it isn't approved within 24 hours, or the lead rep changes. On `failed`, `reversed` or `cancelled`, the full amount goes back to the balance (and to its due).

| Error | When |
|---|---|
| `403 KYC_NOT_VERIFIED` | The requesting rep's identity isn't verified. |
| `409 SPACE_ACCOUNT_NOT_READY` | The space's 9jaPay account is still being opened. |
| `422 ABOVE_MAX_PAYOUT` | Over ₦500,000; split it into several withdrawals. |
| `422 DAILY_LIMIT_EXCEEDED` | The space would pass ₦5,000,000 withdrawn today (or its account's ₦10M of sweeps + withdrawals); `details[0].issue` gives what's left today. |
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

`200`: `[{ code, name }]`, the bank list from 9jaPay.

---

## Feedback

### `POST /feedback`

Any signed-in user. Body: `{ "category": "bug" | "idea" | "other", "message": "10–2000 chars", "page"?: "/dashboard/dues" }`. The `User-Agent` header is stored with it. Limited to 5 per 10 minutes per user (`429 RATE_LIMITED`).

`201`: `{ id, category, message, page, userAgent, status: "new", adminNote, resolvedAt, createdAt, user: { id, name, email, role } }`.

---

## Sandbox only

### `POST /dev/simulate-deposit`

Pretends someone transferred money into an account, for testing the pay flow from the frontend. **Sandbox only:** on 9jaPay it exists only on the sandbox base URL with `NINEJAPAY_SANDBOX_AUTH_KEY` set (with the fake provider, outside production). Anywhere else it `404`s. No auth.

Body: `{ "accountNumber": "9000143502", "amount": 507500 }`. `amount` is kobo. A checkout's one-time account takes **only its exact total** (`amount` from the checkout response).

Then it confirms the checkout holding that account straight away (no webhook needed on localhost). It takes a few seconds.

`200`: `{ accountNumber, amount, checkout: { reference, status } | null }`. `status` is normally `"paid"`. If it's still `"pending"`, the pay page's next status poll picks it up. `checkout` is `null` for an account no open checkout holds (e.g. a space account).

Errors: `400 VALIDATION_ERROR` (account number not 10 digits, amount not a positive integer); `422 AMOUNT_MISMATCH` (not the checkout's total, nothing deposited); `422 DEPOSIT_REFUSED` (9jaPay refused it: unknown, closed or already-paid account).

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

Also: `POST /admin/users/:userId/kyc/review` only accepts `decision: "rejected"`: an admin can revoke a rep's verification but never grant it, except by approving a partial NIN match below. `PATCH /me` refuses an email change (`422 EMAIL_CHANGE_NOT_ALLOWED`). `POST /spaces/:spaceId/reps/invite` and the dues `allowGuests` field are removed. Co-reps are now added with `POST /spaces/:spaceId/reps`.

`role = admin` is required. Each route also checks the permission named in its row; a super admin has every permission.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/reps/applications?status=pending` | userManagement | Reps waiting for approval. Each row: `{ userId, applicant, status, requestedSpace, submittedAt, … }`. |
| `POST /admin/reps/:repId/verify` | userManagement | Approves the rep: sets `isRep` and creates the space from the application. Body: `{ note? }`. |
| `POST /admin/reps/:repId/approve-as-co-rep` | userManagement | Approves a pending applicant as a **co-rep of an existing space** instead of creating a new one (their department is already on Duevy). Same KYC checks as `/verify`. Body: `{ spaceId, note? }`. Notifies the applicant (in-app and email) and the space's lead. Returns the rep plus `space: { id, name, role: 'co' }`. 409 `NOT_PENDING` / `KYC_INCOMPLETE` / `USER_INACTIVE`; 404 if the space is missing or archived. `GET /admin/reps/:repId/application` now includes `matchingSpaces` (up to 5 unarchived spaces at the same school whose name contains the requested name) to pick from. |
| `POST /admin/reps/:repId/reject` | userManagement | Body: `{ reason }`. |
| `GET /admin/reps` | userManagement | Reps with their collections. |
| `GET /admin/kyc/student-ids?status=pending` | userManagement | Student ID cards to review: `[{ userId, name, email, matricNo, institution, kycStatus, studentId: { status, mimeType, uploadedAt, reviewedAt, reviewNote, viewUrl, viewUrlExpiresInSeconds } }]`. `viewUrl` is a signed ImageKit link that expires after 10 minutes. |
| `POST /admin/users/:userId/student-id/review` | userManagement | Body: `{ "decision": "approved" | "rejected", "note"? }`; a note is required to reject. The rep is notified. |
| `GET /admin/kyc/liveness?status=pending` | userManagement | Face captures to review, with the student ID card to compare: `[{ userId, name, email, matricNo, institution, liveness: { status, kind: "photo" \| "video", mimeType, uploadedAt, reviewedAt, reviewNote, viewUrl, viewUrlExpiresInSeconds }, studentId: { status, mimeType, viewUrl, viewUrlExpiresInSeconds } }]`. Links are signed and expire after 10 minutes; play `kind: "video"` in a `<video>` element. A rep verified before liveness existed shows `status: "approved"` with no `viewUrl` and a note saying so. |
| `POST /admin/users/:userId/liveness/review` | userManagement | Body: `{ "decision": "approved" | "rejected", "note"? }`; a note is required to reject. The rep is notified. Audit-logged as `user.liveness_review`. |
| `GET /admin/settings/kyc` | userManagement | `{ ninRequired, livenessRequired, studentIdRequired: true, leadRepsNotMeetingPolicy }`. |
| `PUT /admin/settings/kyc` | **overrides** | Body: `{ ninRequired?, livenessRequired? }`. Applies to every rep at once (within ~10 s on every server): turning a check on stops collection for spaces whose lead rep hasn't passed it; the response's `leadRepsNotMeetingPolicy` says how many. Audit-logged as `settings.kyc_policy`. |
| `GET /admin/kyc/nin-reviews?status=pending` | userManagement | NIN checks that only partly matched: `[{ userId, name, email, matricNo, institution, kycStatus, submittedAt, nameMatchScore, reviewStatus, reviewedAt, reviewNote, providerReference, studentIdStatus }]`. The NIN itself is never stored, so never shown; look the check up in the Didit console by `providerReference`. |
| `POST /admin/users/:userId/nin/review` | userManagement | Body: `{ "decision": "approved" | "rejected", "note"? }`; a note is required to reject. Approve verifies the rep; reject counts as a failed attempt. Audit-logged as `user.nin_review`. |
| `GET /admin/spaces?q=&school=&type=` | userManagement | `[{ id, name, short, kind, school, memberCount, duesTarget, collectedAmount, assignedRepIds, isArchived, payoutsFrozen }]` |
| `GET /admin/transactions?type=&status=&spaceId=&userId=&from=&to=` | userManagement | Every transaction. |
| `GET /admin/checkouts?status=&needsReview=true&overpaid=true&spaceId=` | userManagement | The review queue: underpaid, overpaid, late and duplicate payments. |
| `POST /admin/checkouts/:reference/resolve` | overrides | Clears a review flag. Body: `{ note }`. |
| `GET /admin/payouts?status=&spaceId=` | payouts | Every withdrawal. |
| `GET /admin/health` | userManagement | `{ deadWebhooks, retryingWebhooks, stuckPayouts, checkoutsNeedingReview, unresolvedCheckouts, unsettledWithdrawalFees, pendingStudentIds, healthy, recentWebhookFailures }` |
| `POST /admin/reps/:repId/freeze-payouts` · `/unfreeze-payouts` | payouts | Freezes or unfreezes the rep's withdrawals. |
| `GET /admin/feedback?status=&category=&q=` | userManagement | Feedback inbox, newest first; `status` is `new` or `resolved`, `category` is `bug`, `idea` or `other`. Rows as in `POST /feedback`. `meta.unresolved` is the count of `new` feedback (for a badge). |
| `POST /admin/feedback/:id/resolve` · `/reopen` | userManagement | Marks it resolved (body: `{ note? }`, kept as `adminNote`) or back to `new`. Both are audit-logged. |

---

## Webhook

### `POST /webhooks/9japay`

Public. Register it in the 9jaPay dashboard (Settings → Developer), for test and live. It authenticates only by signature: `Signature: base64(HMAC-SHA256(secret key, raw body))`.

| Response | When |
|---|---|
| `200` | The event was stored (deduplicated by event id), or it was authenticated but unreadable and was dead-lettered. |
| `401` | The signature is missing or wrong. |
| `503` | The event could not be stored, so 9jaPay resends it (up to 10 times). |

9jaPay events carry no timestamp, so none is acted on as-is: each prompts Duevy to ask 9jaPay what happened.

| Event | Effect |
|---|---|
| `new_transaction`, Credit, on a checkout's one-time account | Duevy reads the account's transactions; the checkout becomes paid (or underpaid). Money after expiry is honoured and flagged. |
| `new_transaction`, Credit, on a space's account | A sweep landed: Duevy confirms its sweeps in flight. |
| `transfer_response` | Duevy queries the transfer's status; the sweep or withdrawal succeeds or fails. |

Anything else is acknowledged and ignored. `POST /webhooks/bachs` still answers `200` and drops the event, until Bachs is switched off.

---

## Removed or changed in this release

**Bachs → 9jaPay, KYC → NIN + date of birth (this release):**

- Payments run on 9jaPay. Checkouts always return a one-time `bankTransfer` account; `checkoutUrl` is always `null` and `GET|PUT /admin/settings/payments` (hosted vs custom checkout) are removed.
- Checkout fee: **1.5%** of the face value, rounded up (was 2% + ₦20). Withdrawal fee: 9jaPay's transfer charge, ₦10 / ₦15 / ₦20 (was ₦100 / ₦200). `GET /payout/summary` `fees` is now `{ bands: [...] }` (was `{ below, atOrAbove }`).
- Each space has its own 9jaPay account: `account` and `funds` on `GET /payout/summary`. New withdrawal limits: ₦500,000 per withdrawal (`422 ABOVE_MAX_PAYOUT`) and ₦5,000,000 per space per day (`422 DAILY_LIMIT_EXCEEDED`); also `409 SPACE_ACCOUNT_NOT_READY`. `403 LEAD_KYC_NOT_VERIFIED` is gone: the money is the space's, and the requesting rep's own verified identity is what counts.
- `POST /payout/kyc` takes only `nin`, `dob` and `studentIdCard`, and answers with the result: `verified`, `pending` (partial match, admin review), `422 KYC_REJECTED` or `503 KYC_PROVIDER_UNAVAILABLE`. Other fields are ignored.
- KYC state: new `nin: { outcome, reviewStatus, reviewNote }`. Removed: `providerReference`, `governmentIdSubmittedAt`, `payoutDestination`. `payoutsActive` and `requirementsDue` stay as deprecated fixed values.
- Removed: `POST /payout/kyc/government-id`, `POST /payout/kyc/payout-destination[/lookup]` and their `/me/kyc/*` twins (404).
- New admin queue: `GET /admin/kyc/nin-reviews`, `POST /admin/users/:userId/nin/review`.
- Webhooks: `POST /webhooks/9japay`. `/webhooks/bachs` acknowledges and drops.
- Reps verified under Bachs stay verified. Reps mid-verification start again.

**Earlier:**

- `POST /webhooks/anchor` is gone; use `/webhooks/bachs`.
- `POST /payout/kyc/upgrade` is removed, along with KYC tiers and the ₦300,000 balance ceiling.
- `POST /payout/kyc` is now `multipart/form-data` and takes a **NIN** (not a BVN) plus a `studentIdCard` file. A space can only collect once an admin approves the card.
- `POST /payout/:id/approve`, `POST /payout/:id/cancel`, `GET|POST /dues/:dueId/payout/*` are removed (approval quorum and co-rep payouts are out of scope).
- `POST /dues/pay` no longer accepts `discountCode` or `method: "card"`. Guest payers are refused.
- `POST /polls/:slug/votes` on a paid poll returns `501 PAID_VOTING_UNAVAILABLE`. Free polls still work.
- `/payments/:reference/status` statuses are now `pending | paid | expired | underpaid`. They used to be `completed | failed | pending`.
- Payout statuses are now `pending | processing | success | failed | reversed`. Payout responses gained `fee` and `net`; `duevyFee` and `netSent` stay as deprecated aliases.
- Dues have `type` (with `category` kept as an alias) and the new set of types. Old categories were mapped: `levy` → `departmental_due`, everything else → `other`.
