# Duevy Frontend API Guide

This guide provides a practical overview of how to consume the Duevy Backend API. For a complete reference of all endpoints and data structures, see [API_SPECIFICATION.md](./API_SPECIFICATION.md).

## 1. Core Concepts

### Base URL
`https://api.duevy.com/v1` (Production)  
`http://localhost:4000/v1` (Development)

### Response Envelope
Every response follows this structure:

**Success**
```json
{
  "success": true,
  "data": { ... },
  "meta": { "page": 1, "perPage": 10, "total": 45, "totalPages": 5 }
}
```

**Error**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": [{ "field": "email", "issue": "invalid format" }]
  }
}
```

Some mutating endpoints return **`204 No Content`** on success (no body) — this is called out per-endpoint below.

### Authentication
- **Access Token:** Send in the header: `Authorization: Bearer <token>`.
- **Refresh Token:** Handled automatically via HTTP-Only cookie, scoped to the `/v1/auth/refresh` path. Use `POST /v1/auth/refresh` to rotate.
- Everything under `/me`, `/spaces`, `/wallet`, `/dues`, `/transactions`, `/payments`, `/notifications`, `/polls/{slug}/votes`, `/referrals`, `/disputes`, `/banks`, and `/admin` requires a valid access token. `GET /v1/polls/{slug}` accepts an optional token (affects vote-remaining counts).

### Headers
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>`: **Required** for payment/wallet/payout state-changing requests — specifically `POST /dues/{dueId}/pay`, `POST /wallet/top-up`, `POST /spaces/{spaceId}/payout/request`, and `POST /polls/{slug}/votes` on **paid** polls.

---

## 2. Authentication Flow

### Register (Student)
**POST** `/v1/auth/register`
**Payload:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "matricNo": "123456",
  "password": "securepassword123",
  "acceptedTerms": true,
  "role": "student",
  "referralCode": "OPTIONAL-REF-CODE"
}
```
Returns `{ user, accessToken }` (201) and sets the refresh-token cookie. Fires a verification email in the background.

### Register (Rep)
**POST** `/v1/auth/register`
**Payload:**
```json
{
  "name": "Jane Smith",
  "email": "jane@unilag.edu.ng",
  "matricNo": "190802044",
  "password": "securepassword123",
  "acceptedTerms": true,
  "role": "rep",
  "referralCode": "OPTIONAL-REF-CODE",
  "space": {
    "name": "Economics Student Association",
    "short": "ESA",
    "kind": "association",
    "school": "University of Lagos",
    "faculty": "Social Sciences",
    "theme": "ocean",
    "coRepInvites": ["cofounder@example.com"]
  }
}
```
*Note: The account is created as a `student` with `repApplicationStatus: "pending"`. Returns `403 REP_APPROVAL_PENDING` (with `{ user, accessToken }` still in `data`) until admin approval — the client can use the token to show a "pending review" screen. On approval, the space is created and the account is promoted to `rep`.*

### Login
**POST** `/v1/auth/login`
**Payload:** `{ "email": "john@example.com", "password": "..." }`
Returns `{ user, accessToken }`. `403 ACCOUNT_SUSPENDED` / `403 ACCOUNT_DEACTIVATED` if applicable; `403 REP_APPROVAL_PENDING` shape matches register.

### Google Sign-In
**POST** `/v1/auth/google`
**Payload:**
```json
{
  "idToken": "<Google ID token from the OAuth flow>",
  "matricNo": "190802044",
  "role": "student",
  "referralCode": "OPTIONAL-REF-CODE"
}
```
*`matricNo` is only required the first time an account is created this way. `role`/`space` follow the same shape as register when signing up as a rep. Returns `501 NOT_IMPLEMENTED` if Google sign-in isn't configured server-side, `401 INVALID_CREDENTIALS` if the ID token fails verification or the Google email isn't verified.*

### Refresh Access Token
**POST** `/v1/auth/refresh`
No payload — the refresh token is read from the HTTP-only cookie. Rotates the refresh token (old one is revoked) and returns `{ accessToken }`. `401 UNAUTHORIZED` if the cookie is missing, expired, revoked, or the account is suspended/deactivated.

### Logout
**POST** `/v1/auth/logout`
No payload. Revokes the current refresh token and clears the cookie. Always returns `204`.

### Verify Email
**POST** `/v1/auth/verify-email`
**Payload:** `{ "token": "<token from the verification email link>" }`
Returns `{ verified: true }`. `400 VALIDATION_ERROR` if the token is invalid, already used, or expired.

### Forgot Password
**POST** `/v1/auth/forgot-password`
**Payload:** `{ "email": "john@example.com" }`
Always returns `200` with a generic message, regardless of whether the account exists (prevents email enumeration).

### Reset Password
**POST** `/v1/auth/reset-password`
**Payload:** `{ "token": "<token from the reset email link>", "password": "newSecurePassword123" }`
Resets the password and revokes every active session for that user. `400 VALIDATION_ERROR` if the token is invalid/used/expired.

### Get Current User
**GET** `/v1/auth/me`
Returns the full authenticated `User` profile plus a flattened `spaces` array (each space tagged `membership: "member" | "rep"`). Equivalent identity check to decoding the access token, but hits the DB for fresh data.

---

## 3. Profile & Account (`/me`)
All routes below require authentication and operate on the caller's own account.

### Update Profile
**PATCH** `/v1/me`
**Payload (all optional):** `{ "name": "...", "email": "...", "phone": "+2348012345678", "avatarUrl": "..." }`
`matricNo`, `level`, `department`, `role`, and `walletBalance` are read-only here — sending them returns `422 FIELD_READ_ONLY`. Changing `email` flips `emailVerified` to `false` and re-sends the verification email. `409 EMAIL_IN_USE` if the new email is taken.

### Upload Avatar
**POST** `/v1/me/avatar`
**Multipart form-data**, field name `file`. Accepts JPEG/PNG/WebP, max 2 MB. Returns `{ avatarUrl }`.

### Change Password
**PUT** `/v1/me/password`
**Payload:** `{ "currentPassword": "...", "newPassword": "..." }`
Revokes every other active session (refresh token) except the caller's current one. `400 INVALID_CREDENTIALS` if `currentPassword` is wrong.

### Notification Preferences
**GET** `/v1/me/notification-preferences`
Returns `{ email: { dueReminders, paymentReceipts }, push: { dueReminders, payments, circleActivity } }`.

**PUT** `/v1/me/notification-preferences`
**Payload:** same shape as the GET response — all fields required (partial updates aren't supported; send the full object).

### Get Overview (Student Dashboard)
**GET** `/v1/me/overview`
Returns balance, outstanding count/amount, `paidThisSession`, top 4 open dues (overdue first, then soonest deadline), and 4 most recent transactions.

### List Active Sessions
**GET** `/v1/me/sessions`
Returns the caller's active (non-revoked, unexpired) refresh tokens as sessions: `[{ id, device, ip, lastSeenAt, current }]`.

### Revoke a Session
**DELETE** `/v1/me/sessions/{sessionId}`
Revokes one session (e.g. "log out this device"). Returns `204`. `404` if not found or already revoked.

### Delete Account
**DELETE** `/v1/me`
**Payload:** `{ "password": "...", "reason": "optional" }`
Deactivates the account (soft delete) and revokes all sessions. Blocked with `409 WALLET_NOT_EMPTY` if the wallet balance is above zero, or `409 ACTIVE_REP_OBLIGATIONS` if the caller is a lead rep of a space with active dues (transfer lead or close dues first).

---

## 4. Student Dashboard & Dues

### List My Dues
**GET** `/v1/dues`
**Query:** `spaceId`, `status` (`unpaid` | `paid` | `overdue`), `category` (`levy` | `dinner` | `handout` | `welfare` | `sport`), plus standard pagination (`page`, `perPage`).
Returns every active/closed due across the caller's spaces, each with viewer-relative `status`, `payableAmount` (face + 3% fee), and payment info if paid.

### Get a Due
**GET** `/v1/dues/{dueId}`
Same shape as a list row. `403 NOT_A_MEMBER` if the caller isn't a member and the due doesn't `allowGuests`.

### Pay a Due (Wallet)
**POST** `/v1/dues/{dueId}/pay`
**Payload:** `{ "method": "wallet" }`

### Pay a Due (Saved Card)
**POST** `/v1/dues/{dueId}/pay`
**Payload:** `{ "method": "card", "cardId": "..." }`
Charges a card saved via `POST /v1/wallet/cards`. Returns `402 CARD_DECLINED` if the charge fails.

### Pay a Due (Online - Monnify)
**POST** `/v1/dues/{dueId}/pay`
**Payload:** `{ "method": "online" }`
Returns `checkoutUrl` and `reference`. Use `GET /v1/payments/{reference}/status` to poll for completion.

All three return `409 DUE_ALREADY_PAID` on a duplicate attempt and `409 DUE_NOT_PAYABLE` if the due isn't active. **Requires `Idempotency-Key`.**

### Download Receipt
**GET** `/v1/dues/{dueId}/receipt` (also `/v1/transactions/{transactionId}/receipt`)
Returns a PDF (`Content-Type: application/pdf`) for a settled payment. `404` if unpaid.

---

## 5. Wallet & Cards

### Get Wallet Balance
**GET** `/v1/wallet`
Returns `{ balance, pendingBalance }` — `pendingBalance` is the sum of top-ups still `pending` (awaiting online payment confirmation).

### Top-Up (Saved Card)
**POST** `/v1/wallet/top-up`
**Payload:** `{ "amount": 100000, "method": "card", "cardId": "..." }`
Amount must be between ₦100 and ₦500,000 (in kobo). **Requires `Idempotency-Key`.**

### Top-Up (Online - Monnify)
**POST** `/v1/wallet/top-up`
**Payload:** `{ "amount": 100000, "method": "online" }`
Returns `{ checkoutUrl, reference }`. **Requires `Idempotency-Key`.**

### List Saved Cards
**GET** `/v1/wallet/cards`

### Save a Card
**POST** `/v1/wallet/cards`
**Payload:** `{ "providerToken": "...", "brand": "Visa" | "Mastercard" | "Verve", "last4": "4242", "expiry": "12/28", "isDefault": false }`
`providerToken` comes from the PSP's inline tokenization SDK — raw card numbers never touch this API. The first card saved is always made default regardless of `isDefault`. `409 CARD_EXISTS` if the token is already saved.

### Set Default Card
**PATCH** `/v1/wallet/cards/{cardId}`
**Payload:** `{ "isDefault": true }` (this is the only accepted value)

### Delete Card
**DELETE** `/v1/wallet/cards/{cardId}`
Returns `204`. If the deleted card was the default, the most recently added remaining card is promoted automatically.

### Wallet Activity
**GET** `/v1/wallet/activity`
Returns the 10 most recent wallet-touching transactions (top-ups, withdrawals, refunds, referral rewards, and wallet-method due/vote payments) as a compact `{ id, label, detail, amount, createdAt }[]` — lighter weight than the full ledger, meant for a wallet-page activity feed.

---

## 6. Spaces (Departments)

### List My Spaces
**GET** `/v1/spaces`
Returns every non-archived space the caller belongs to (as `member` or `rep`), with `memberCount` and `membership`.

### Lookup Code
**POST** `/v1/spaces/lookup`
**Payload:** `{ "code": "ENG101" }`
Returns space details plus its active dues, before joining. `404 JOIN_CODE_INVALID` if the code doesn't match an active space.

### Get a Space
**GET** `/v1/spaces/{spaceId}`
Members, guests, and admins only. `403` otherwise.

### Join Space
**POST** `/v1/spaces/{spaceId}/join`
**Payload:** `{ "code": "ENG101", "as": "member" }` (`as` defaults to `"member"`, may be `"guest"`)
Joining is immediate for anyone with a valid code — reps do not approve or gate admission. `409 ALREADY_MEMBER` if already joined.

### Leave a Space
**DELETE** `/v1/spaces/{spaceId}/membership`
Returns `204`. Blocked with `409 UNPAID_OBLIGATIONS` if the caller has unpaid active dues in that space.

### Update Space Profile (Lead Rep)
**PATCH** `/v1/spaces/{spaceId}`
**Payload (all optional, at least one required):** `{ "name": "...", "short": "...", "about": "...", "hue": "emerald" | "indigo" | "amber" | "rose" | "slate", "theme": "emerald" | "ocean" | "royal" | "crimson" | "tangerine" }`
Lead rep only.

---

## 7. Rep — Circle Management (`/v1/spaces/{spaceId}/...`)
Everything in this section requires the caller to be a rep of the space; routes marked **(Lead)** require the `lead` role specifically (co-reps are forbidden).

### Rep Dashboard
**GET** `/v1/spaces/{spaceId}/overview`
Returns the space, its `joinCode`, collection `stats` (collected, outstanding, unpaidCount, collectionRate), the active dues list with per-due `paidCount`/`memberCount`, and the 3 newest members.

### List Members
**GET** `/v1/spaces/{spaceId}/members`
**Query:** `q` (search by name/matric/email), plus pagination.

### Remove a Member **(Lead)**
**DELETE** `/v1/spaces/{spaceId}/members/{userId}`
Returns `204`.

### Regenerate Join Code
**POST** `/v1/spaces/{spaceId}/join-code/regenerate`
Returns `{ code }`.

### List Reps
**GET** `/v1/spaces/{spaceId}/reps`
Returns `[{ id, name, email, role: "lead" | "co" }]`.

### Invite a Co-Rep **(Lead)**
**POST** `/v1/spaces/{spaceId}/reps/invite`
**Payload:** `{ "email": "cofounder@example.com" }`
The invitee must already have a Duevy account (`422 USER_NOT_FOUND` otherwise). `409 ALREADY_REP` if already a rep of this space. Sends a notification + email to the invitee.

### Remove a Co-Rep **(Lead)**
**DELETE** `/v1/spaces/{spaceId}/reps/{userId}`
Returns `204`. `409 LAST_LEAD_REP` if trying to remove the sole lead (transfer lead first).

### Audit Log
**GET** `/v1/spaces/{spaceId}/audit-log`
Paginated, newest first: `[{ id, action, description, actor: { id, name }, createdAt }]`.

### Transfer Lead **(Lead)**
**POST** `/v1/spaces/{spaceId}/transfer-lead`
**Payload:** `{ "userId": "...", "password": "<caller's current password>" }`
The target must already be a co-rep of the space. Re-verifies the caller's password as a safety check.

### Archive Space **(Lead)**
**POST** `/v1/spaces/{spaceId}/archive`
**Payload:** `{ "password": "...", "reason": "optional" }`
Blocked with `409 PENDING_PAYOUT` if a payout is still processing, or `409 HELD_BALANCE` if there's an uncollected payout balance — pay it out first.

---

## 8. Rep — Dues Management (`/v1/spaces/{spaceId}/dues`)
All routes require the caller to be a rep of the space (lead or co).

### List Dues
**GET** `/v1/spaces/{spaceId}/dues`
**Query:** `status` (`draft` | `active` | `closed`), `category`.

### Create Due
**POST** `/v1/spaces/{spaceId}/dues`
**Payload:** `{ "title": "Dinner", "note": "optional", "amount": 500000, "dueDate": "2024-05-20", "category": "dinner", "allowGuests": false, "publish": true }`
`dueDate` must be today or later. If `publish` is `false` (default), the due is created as a `draft` and isn't visible to students yet.

### Edit a Due
**PATCH** `/v1/spaces/{spaceId}/dues/{dueId}`
**Payload (all optional, at least one required):** same fields as create (minus `publish`).
`409 DUE_CLOSED` if the due is closed. `amount` can't change once any payment exists (`409 DUE_HAS_PAYMENTS`).

### Publish a Due
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/publish`
Draft → active. `409 INVALID_TRANSITION` if not currently a draft.

### Close a Due
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/close`
Active → closed (stops accepting payments). `409 INVALID_TRANSITION` if not currently active.

### Delete a Due
**DELETE** `/v1/spaces/{spaceId}/dues/{dueId}`
Drafts only — `409 ONLY_DRAFTS_DELETABLE` otherwise. Returns `204`.

### Collections Roster
**GET** `/v1/spaces/{spaceId}/dues/{dueId}/collections`
**Query:** `status` (`all` | `paid` | `unpaid`, default `all`), `q` (search), plus pagination.
Returns `{ totals: { paid, unpaid, collected, fees, net, expected, rate }, students: [...] }` — per-student rows include `status`, `paidAt`, `reference`.

### Export Collections (CSV)
**GET** `/v1/spaces/{spaceId}/dues/{dueId}/collections/export`
**Query:** `status` (same as above). Returns `text/csv` as an attachment.

### Remind Unpaid Members
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/remind`
**Payload:** `{ "userIds": ["optional subset — omit to remind everyone unpaid"] }`
Sends a notification to unpaid members. Returns `{ reminded: <count> }`. Rate-limited to once per due per 24h (`429 REMINDER_COOLDOWN`).

---

## 9. Payouts (Rep Only, `/v1/spaces/{spaceId}/payout...`)
All routes require the caller to be a rep of the space.

### List Banks
**GET** `/v1/banks`
Returns `[{ "code": "058", "name": "Guaranty Trust Bank" }, ...]` — the full Monnify-supported
bank list, for populating the bank picker on the payout-account form. Cached server-side for 24h.

### Payout Summary
**GET** `/v1/spaces/{spaceId}/payout/summary`
Returns `{ available, pending, lifetime }` (all net of the 3% collection charge). `pending` is collections still inside the 24h clearing window; `available` is what can actually be withdrawn right now.

### Get Payout Account
**GET** `/v1/spaces/{spaceId}/payout/account`
Returns the saved account with the account number masked. `404 NO_PAYOUT_ACCOUNT` if none is set yet.

### Preview Payout Account
**POST** `/v1/spaces/{spaceId}/payout/account/lookup`
**Payload:** `{ "bankCode": "058", "accountNumber": "0123456789" }`
Resolves the account name via Monnify name-enquiry **without saving anything** — call this first
so the rep can see and confirm the name before committing. Returns
`{ "bankCode", "bankName", "accountNumber", "accountName" }`.
Returns `422 ACCOUNT_UNVERIFIABLE` if the account can't be resolved.

### Set Payout Account
**PUT** `/v1/spaces/{spaceId}/payout/account`
**Payload:** `{ "bankCode": "058", "accountNumber": "0123456789" }`
Same shape as the lookup above — re-resolves and then saves. `accountName` is never accepted as
input, only ever server-resolved. Changing an existing account triggers a 24h payout hold
(`cooldownUntil` in the response) and emails every rep of the space as a security notice.

### Request Payout
**POST** `/v1/spaces/{spaceId}/payout/request`
**Payload:** `{ "amount": 1000000, "note": "Venue payment" }`
Returns a `Payout` with `status: "processing"`. The transfer is initiated automatically and the
payout moves to `completed` or `failed` once the payment provider confirms — poll
`GET /v1/spaces/{spaceId}/payouts` or listen for the `payout_completed` notification.
`423 PAYOUTS_FROZEN` if an admin has frozen payouts for the space; `409 NO_PAYOUT_ACCOUNT` /
`409 ACCOUNT_COOLDOWN` if the account isn't set or is still on hold; `402 INSUFFICIENT_PAYOUT_BALANCE`
if it exceeds `available`. **Requires `Idempotency-Key`.**

### List Payouts
**GET** `/v1/spaces/{spaceId}/payouts`
Paginated, newest first. Each row: `{ id, amount, reference, status, account, note, requestedAt, settledAt, failureReason }`.

---

## 10. Polls & Voting

### Rep: List Polls
**GET** `/v1/spaces/{spaceId}/polls`
**Query:** `status` (`draft` | `active` | `closed`). Rep of the space required. Includes vote tallies and revenue.

### Rep: Create Poll
**POST** `/v1/spaces/{spaceId}/polls`
**Payload:**
```json
{
  "title": "Best Dressed",
  "description": "optional",
  "deadline": "2024-06-01",
  "membersOnly": true,
  "paid": false,
  "amountPerVote": 20000,
  "categories": [
    { "title": "Male", "nominees": [{ "name": "John" }, { "name": "James" }] }
  ],
  "publish": false
}
```
`amountPerVote` is required (and > 0) when `paid: true`. Each category needs at least 2 nominees. `publish: false` (default) creates a `draft`.

### Rep: Edit Poll
**PATCH** `/v1/spaces/{spaceId}/polls/{pollId}`
While `draft`, every field above (minus `categories`) is editable. Once `active`, structural fields (`membersOnly`, `paid`, `amountPerVote`) are locked (`409 POLL_STRUCTURE_LOCKED`) and `deadline` may only be extended, not shortened. `409 POLL_CLOSED` once closed.

### Rep: Publish / Close Poll
**POST** `/v1/spaces/{spaceId}/polls/{pollId}/publish` — draft → active.
**POST** `/v1/spaces/{spaceId}/polls/{pollId}/close` — active → closed (idempotent; calling again on an already-closed poll just returns it).

### Rep: Poll Results
**GET** `/v1/spaces/{spaceId}/polls/{pollId}/results`
Returns the poll plus `totalVotes`, `revenue`, and per-nominee vote counts.

### Get Poll (Public/Voter)
**GET** `/v1/polls/{slug}`
Auth optional. `404` while the poll is still a draft. A poll past its `deadline` auto-closes on read. Nominee vote counts (`showVotes`) are only included once the poll is `closed`. `403 MEMBERS_ONLY` if the poll is members-only and the (authenticated) caller isn't a space member. When authenticated, each category gets a `remaining` field (votes left; `null` if uncapped for non-members-only polls).

### Cast Vote (Free Poll)
**POST** `/v1/polls/{slug}/votes`
**Payload:** `{ "selections": [{ "categoryId": "...", "nomineeId": "...", "quantity": 1 }] }`
No `method` needed for free polls. Members-only polls cap each caller to one vote per category (`409 ALREADY_VOTED`).

### Cast Vote (Wallet)
**POST** `/v1/polls/{slug}/votes`
**Payload:**
```json
{
  "selections": [{ "categoryId": "...", "nomineeId": "...", "quantity": 1 }],
  "method": "wallet"
}
```

### Cast Vote (Saved Card)
Same endpoint, with `"method": "card", "cardId": "..."` for paid polls.

### Cast Vote (Online)
Same endpoint, with `"method": "online"`. Returns `{ checkoutUrl, reference }` instead of a receipt; poll `GET /v1/payments/{reference}/status`.

*Paid votes charge the same 3% fee structure as dues (1.5% Duevy + 1.5% Monnify) on top of `amountPerVote × quantity`, and require an `Idempotency-Key` header.*

---

## 11. Referrals (Rep Only)
Available to reps, admins, or anyone who leads/co-runs a space (`403` for students).

### Get My Referral Info
**GET** `/v1/referrals`
Returns `{ code, link, rewardPerReferral, summary: { invited, joined, earned }, referrals: [{ id, name, status, reward, date }] }`. A referral code is generated lazily on first call if the account doesn't have one.

### Send Invites
**POST** `/v1/referrals/invites`
**Payload:** `{ "emails": ["friend1@example.com", "friend2@example.com"] }` (1–20 emails)
Fires an invite email per address containing the caller's referral link/code. Returns `{ sent: <count> }`.

---

## 12. Disputes & Notifications

### File Dispute
**POST** `/v1/disputes`
**Payload:** `{ "type": "payment_not_reflecting" | "non_remittance" | "refund_request", "transactionReference": "optional", "description": "..." }`
`description` must be 10–2000 characters.

### List My Disputes
**GET** `/v1/disputes`
Returns the caller's own filed disputes, newest first, each with `ageDays`/`breached` computed against `slaDays`.

### List Notifications
**GET** `/v1/notifications`
**Query:** `since` (ISO timestamp — only notifications created after this, for lightweight polling), plus pagination.
Returns paginated alerts + `unreadCount` in `meta`.

### Mark Notification Read
**POST** `/v1/notifications/{notificationId}/read`
Returns `204`.

### Mark All Notifications Read
**POST** `/v1/notifications/read-all`
Returns `204`.

---

## 13. Transactions & Payments

### List Transactions (Ledger)
**GET** `/v1/transactions`
**Query:** `direction` (`all` | `in` | `out`, default `all`), `type` (`due` | `topup` | `referral` | `withdrawal` | `refund` | `vote`), `status` (`completed` | `pending` | `failed`), `from`, `to` (ISO dates), `q` (search title/reference), plus pagination.
This is the caller's full personal transaction history (superset of `GET /wallet/activity`).

### Get Transaction
**GET** `/v1/transactions/{transactionId}`

### Transaction Receipt
**GET** `/v1/transactions/{transactionId}/receipt`
Returns a PDF, same as `GET /dues/{dueId}/receipt`.

### Poll Online Payment Status
**GET** `/v1/payments/{reference}/status`
Poll this after any `checkoutUrl` flow (due payment, wallet top-up, or poll vote). Returns `{ status: "pending" | "completed" | "failed", transaction?: {...} }` — `transaction` is only present once `completed`.

---

## 14. Admin (`/v1/admin/...`)
Every route below requires an authenticated `admin` account. Routes annotated with a **permission** additionally require that permission on the admin's role (`userManagement`, `payouts`, `disputes`, or `overrides`) — configured via §14.9 Roles. `PUT /admin/roles/{role}` requires the `super_admin` sub-role specifically. Nearly every mutating admin action is recorded to the audit log (§14.9).

### 14.1 Overview
**GET** `/v1/admin/overview`
Dashboard aggregate: `{ totalUsers, activeReps, duesCollected, duesTarget, floatHeld, overdue: { amount, count }, attention: [...] }`. `attention` is a dynamic list of alert cards (pending rep approvals, overdue dues, spaces collecting below 30%, disputes past SLA), each with a `href` to jump to the relevant admin screen.

### 14.2 Users — *userManagement*
**GET** `/v1/admin/users` — **Query:** `role`, `kycStatus`, `suspended` (`true`/`false`), `q`, pagination.
**GET** `/v1/admin/users/{userId}` — single user detail.
**POST** `/v1/admin/users/{userId}/suspend` — **Payload:** `{ "reason": "..." }`. Revokes all sessions. Returns `204`.
**POST** `/v1/admin/users/{userId}/unsuspend` — Returns `204`.
**POST** `/v1/admin/users/{userId}/deactivate` — **Payload:** `{ "reason": "..." }`. Revokes all sessions. Returns `204`.
**POST** `/v1/admin/users/{userId}/kyc/review` — **Payload:** `{ "decision": "verified" | "rejected", "note": "optional" }`. Returns `{ kycStatus }`.

### 14.3 Reps — *userManagement* (unless noted)
**GET** `/v1/admin/reps` — **Query:** `q`, pagination. Lists reps and pending applicants with `heldAmount`, `uncollectedAmount`, `collectionRate` per rep.
**GET** `/v1/admin/reps/applications` — **Query:** `status` (`pending` default, `approved`, `rejected`), pagination. Full application detail queue.
**GET** `/v1/admin/reps/{repId}/application` — single application's full detail (`applicant`, `requestedSpace`, `coRepInvites`, `referralCode`, review state). `404` if the user never applied.
**POST** `/v1/admin/reps/{repId}/verify` — **Payload:** `{ "note": "optional" }`. Approves a pending application: creates the space, promotes the user to `rep`, links any referral, emails the applicant. `409 NOT_PENDING` if there's no pending application.
**POST** `/v1/admin/reps/{repId}/reject` — **Payload:** `{ "reason": "..." }`. Returns `204`.
**POST** `/v1/admin/reps/{repId}/suspend` — **Payload:** `{ "reason": "..." }`. Returns `204`.
**POST** `/v1/admin/reps/{repId}/reinstate` — Returns `204`.
**POST** `/v1/admin/reps/{repId}/freeze-payouts` — *payouts* permission. **Payload:** `{ "reason": "..." }`. Freezes payouts for every space this rep leads. Returns `204`.
**POST** `/v1/admin/reps/{repId}/unfreeze-payouts` — *payouts* permission. Returns `204`.

### 14.4 Spaces — *userManagement*
**GET** `/v1/admin/spaces` — **Query:** `type` (space kind), `school`, `q`, pagination. Each row includes `duesTarget`, `collectedAmount`, `assignedRepIds`, `payoutsFrozen`.
**POST** `/v1/admin/spaces` — **Payload:** `{ "name": "...", "short": "...", "kind": "department" | "association" | "faculty" | "club", "school": "...", "faculty": "optional" }`. Auto-generates a join code. Returns 201.
**PATCH** `/v1/admin/spaces/{spaceId}` — same fields, all optional (at least one required).
**POST** `/v1/admin/spaces/{spaceId}/assign-rep` — **Payload:** `{ "userId": "...", "role": "lead" | "co" }`. Promotes the user to `rep` if needed. Returns 201.
**POST** `/v1/admin/spaces/{spaceId}/archive` — **Payload:** `{ "reason": "..." }`. Returns `204`.

### 14.5 Transactions Oversight — *userManagement* (refunds need *overrides*)
**GET** `/v1/admin/transactions` — **Query:** `type` (`deposit` | `dues_payment` | `payout` | `refund`), `status`, `spaceId`, `userId`, `from`, `to`, `q`, pagination. Rows include `userName`, `userEmail`, `spaceName`, and a derived `status: "refunded"` when fully refunded.
**POST** `/v1/admin/transactions/{txnId}/refund` — *overrides* permission. **Payload:** `{ "amount": 500000, "reason": "..." }` (`amount` optional — omit to refund the remaining refundable balance in full). Credits the user's wallet. `409 NOT_REFUNDABLE` / `409 ALREADY_REFUNDED` as applicable.

### 14.6 Disputes — *disputes*
**GET** `/v1/admin/disputes` — **Query:** `status`, `type`, `q`, pagination.
**POST** `/v1/admin/disputes/{id}/claim` — assigns the dispute to the calling admin, sets `status: "under_review"`. `409 DISPUTE_RESOLVED` if already resolved.
**POST** `/v1/admin/disputes/{id}/resolve` — *overrides* permission. **Payload:** `{ "resolution": "upheld" | "rejected", "note": "...", "refundTxnId": "optional" }`. Notifies the student who opened it.

### 14.7 Polls Oversight
**GET** `/v1/admin/polls` — **Query:** `status`, `q`, pagination. No extra permission required beyond `admin`.
**POST** `/v1/admin/polls/{pollId}/close` — *overrides* permission. **Payload:** `{ "reason": "..." }`. Force-closes any poll regardless of owner. Returns `204`.

### 14.8 Referral Integrity — *userManagement* (resolving flags needs *overrides*)
**GET** `/v1/admin/referrals/summaries` — pagination. Per-referrer rollup: `{ userId, userName, email, invited, joined, earned, riskTier: "low" | "medium" | "high" }` (heuristic based on invite volume vs. join-through rate).
**GET** `/v1/admin/referrals/flags` — **Query:** `status` (`pending` | `paid` | `voided` | `clawed_back`), pagination.
**POST** `/v1/admin/referrals/flags/{flagId}/resolve` — *overrides* permission. **Payload:** `{ "action": "approve" | "void" | "claw_back", "note": "optional" }`.

### 14.9 Audit Logs & Roles
**GET** `/v1/admin/audit-logs` — no extra permission required. **Query:** `severity`, `actorId`, `from`, `to`, pagination.
**GET** `/v1/admin/roles` — no extra permission required. Returns per-sub-role user counts and current permission grants for `super_admin`, `compliance_officer`, `support_lead`.
**PUT** `/v1/admin/roles/{role}` — **`super_admin` only.** **Payload:** `{ "userManagement": true, "payouts": false, "disputes": true, "overrides": false }` (all 4 booleans required). Applies to every admin currently holding that sub-role.

### 14.10 Reports — *userManagement*
**POST** `/v1/admin/reports` — **Payload:** `{ "scope": "financial_summary" | "space_collection" | "rep_performance" | "full_ledger", "format": "csv" | "pdf", "from": "2024-01-01", "to": "2024-06-01", "spaceId": "optional — scopes space_collection to one space" }`. Returns `202` with the report metadata immediately (`status: "ready"`) — generation is on-demand at download time, not async.
**GET** `/v1/admin/reports` — pagination. List previously generated reports.
**GET** `/v1/admin/reports/{id}/download` — streams the CSV or PDF file. Links expire 7 days after generation (`409 REPORT_EXPIRED`).

---

## 15. Reference Data

### Categories
- **Space Kind:** `department`, `association`, `faculty`, `club`.
- **Due Category:** `levy`, `dinner`, `handout`, `welfare`, `sport`.
- **Transaction Type:** `due`, `topup`, `referral`, `withdrawal`, `refund`, `vote`.
- **Space Hue:** `emerald`, `indigo`, `amber`, `rose`, `slate`.
- **Space Theme:** `emerald`, `ocean`, `royal`, `crimson`, `tangerine`.

### Common Error Codes
- `VALIDATION_ERROR`: Request body failed schema check.
- `INVALID_CREDENTIALS`: Wrong password, or an invalid/expired token.
- `INSUFFICIENT_FUNDS`: Wallet balance too low.
- `CARD_DECLINED`: Saved-card charge was rejected by the payment provider.
- `REP_APPROVAL_PENDING`: Rep registered but not yet approved by admin.
- `ACCOUNT_SUSPENDED` / `ACCOUNT_DEACTIVATED`: Login blocked by account state.
- `DUE_ALREADY_PAID` / `DUE_NOT_PAYABLE` / `DUE_CLOSED` / `DUE_HAS_PAYMENTS`: Due lifecycle/payment conflicts.
- `JOIN_CODE_INVALID` / `ALREADY_MEMBER` / `UNPAID_OBLIGATIONS`: Space membership conflicts.
- `NOT_A_MEMBER` / `MEMBERS_ONLY`: Viewer lacks the required space membership.
- `ALREADY_REP` / `LAST_LEAD_REP` / `NOT_A_REP` / `ALREADY_LEAD`: Circle-management conflicts.
- `NO_PAYOUT_ACCOUNT` / `ACCOUNT_COOLDOWN` / `ACCOUNT_UNVERIFIABLE` / `PAYOUTS_FROZEN` / `INSUFFICIENT_PAYOUT_BALANCE`: Payout conflicts.
- `POLL_CLOSED` / `POLL_STRUCTURE_LOCKED` / `ALREADY_VOTED`: Poll lifecycle/voting conflicts.
- `NOT_REFUNDABLE` / `ALREADY_REFUNDED`: Admin refund conflicts.
- `WALLET_NOT_EMPTY` / `ACTIVE_REP_OBLIGATIONS`: Account-deletion blockers.
- `REMINDER_COOLDOWN`: Due reminders are rate-limited to once per 24h.
- `REPORT_EXPIRED`: Admin report download link is past its 7-day expiry.
- `FIELD_READ_ONLY`: Attempted to edit a server-controlled field via `PATCH /me`.
- `NOT_IMPLEMENTED`: Feature not configured server-side (e.g. Google sign-in).

---

## 16. TypeScript Interfaces

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  role: 'student' | 'rep' | 'admin';
  walletBalance: number; // Kobo
  spaces: Array<{ id: string; name: string; membership: 'member' | 'rep'; joinCode?: string }>; // joinCode present for rep spaces
}

interface StudentDue {
  id: string;
  title: string;
  payableAmount: number; // Face amount + 3% fee
  status: 'unpaid' | 'paid' | 'overdue';
  dueDate: string; // YYYY-MM-DD
}

interface RepDue {
  id: string;
  title: string;
  amount: number;
  status: 'draft' | 'active' | 'closed';
  paidCount: number;
  memberCount: number;
  dueDate: string;
}

interface Space {
  id: string;
  name: string;
  short: string;
  kind: 'department' | 'association' | 'faculty' | 'club';
  hue: string; // emerald, indigo, etc.
  school: string;
  theme: 'emerald' | 'ocean' | 'royal' | 'crimson' | 'tangerine';
  memberCount: number;
}

interface Poll {
  id: string;
  title: string;
  description: string;
  deadline: string;
  status: 'draft' | 'active' | 'closed';
  paid: boolean;
  amountPerVote: number;
  slug: string;
  categories: Array<{
    id: string;
    title: string;
    nominees: Array<{ id: string; name: string; votes?: number }>;
  }>;
}

interface Notification {
  id: string;
  kind: string;
  tone: 'brand' | 'amber' | 'rose';
  title: string;
  detail: string;
  href: string | null;
  read: boolean;
  createdAt: string;
}

interface Transaction {
  id: string;
  type: 'due' | 'topup' | 'referral' | 'withdrawal' | 'refund' | 'vote';
  amount: number; // Positive = IN, Negative = OUT
  status: 'completed' | 'pending' | 'failed';
  reference: string;
  createdAt: string;
}

interface Card {
  id: string;
  brand: string;
  last4: string;
  expiry: string;
  isDefault: boolean;
}

interface Payout {
  id: string;
  amount: number; // Kobo, net of fees
  reference: string;
  status: 'processing' | 'completed' | 'failed';
  account: string; // e.g. "Guaranty Trust Bank ****6789"
  note: string | null;
  requestedAt: string;
  settledAt: string | null;
  failureReason: string | null;
}

interface BankAccount {
  bankCode: string;
  bankName: string;
  accountNumber: string; // masked on GET, revealed on the PUT echo
  accountName: string; // always server-resolved
  cooldownUntil: string | null;
}

interface Dispute {
  id: string;
  type: 'payment_not_reflecting' | 'non_remittance' | 'refund_request';
  openedBy: string;
  status: 'open' | 'under_review' | 'resolved';
  slaDays: number;
  ageDays: number;
  breached: boolean;
  description: string;
  resolution: string | null;
  createdAt: string;
}

interface AuditLogEntry {
  id: string;
  action: string;
  description: string;
  actor: { id: string; name: string };
  createdAt: string;
}

interface Session {
  id: string;
  device: string | null;
  ip: string | null;
  lastSeenAt: string;
  current: boolean;
}
```

---

## 17. Useful Tips
- **Kobo:** All `amount` fields are in Kobo. (₦1 = 100 Kobo).
- **Themes:** Use the `hue` field from a Space to apply primary colors to the UI.
- **Fees:** The API automatically adds a 3% processing fee (1.5% Duevy + 1.5% Monnify) to the `payableAmount` of any due, and to paid poll votes. Reps always receive the full face amount they set — the fee is added on top for the payer, not deducted from the collector.
- **204 responses:** Many mutating endpoints (suspend, archive, remove-member, mark-read, delete-card, etc.) return `204 No Content` on success — don't expect a `data` body.
- **Idempotency:** Always send a fresh `Idempotency-Key` (UUID) per user action, not per retry — retries of the same logical request should reuse the same key so the server can dedupe.
- **Pagination:** List endpoints accept `page` and `perPage` query params and return `meta.total` / `meta.totalPages`; endpoints without explicit pagination notes above still accept these params.
