# Duevy Frontend API Guide

This guide provides a practical overview of how to consume the Duevy Backend API. For a complete reference of all endpoints and data structures, see [API_SPECIFICATION.md](./API_SPECIFICATION.md).

Every endpoint below is documented with its **payload fields**, a **full example response**, and the **expected flow** (when to call it and what happens server-side / what to do next).

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
  "data": { },
  "meta": { "page": 1, "perPage": 10, "total": 45, "totalPages": 5 }
}
```
`meta` is only present on paginated list endpoints.

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
`details` is only present on `VALIDATION_ERROR` / `FIELD_READ_ONLY` responses.

Some mutating endpoints return **`204 No Content`** on success (no body) — this is called out per-endpoint below.

### Authentication
- **Access Token:** Send in the header: `Authorization: Bearer <token>`.
- **Refresh Token:** Handled automatically via HTTP-Only cookie, scoped to the `/v1/auth/refresh` path. Use `POST /v1/auth/refresh` to rotate.
- Everything under `/me`, `/spaces`, `/wallet`, `/dues`, `/transactions`, `/payments`, `/notifications`, `/polls/{slug}/votes`, `/referrals`, `/disputes`, `/banks`, and `/admin` requires a valid access token. `GET /v1/polls/{slug}` accepts an optional token (affects vote-remaining counts).

### Headers
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>`: **Required** for payment/wallet/payout state-changing requests — specifically `POST /dues/{dueId}/pay`, `POST /wallet/top-up`, `POST /wallet/cards`, `POST /spaces/{spaceId}/payout/request`, and `POST /polls/{slug}/votes` on **paid** polls. Generate a fresh UUID per logical user action; reuse the same key only when retrying that exact same action (the server dedupes the response for 24h).

---

## 2. Authentication Flow

### Register (Student)
**POST** `/v1/auth/register`

**Flow:** Called from the sign-up form when the user picks "Student". Creates the account immediately, logs them in, and fires a verification email in the background — the account is usable right away (email verification is not a login gate).

**Payload**
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | ✅ | 2–100 chars |
| `email` | string | ✅ | lowercased server-side |
| `matricNo` | string | ✅ | |
| `password` | string | ✅ | min 8 chars |
| `acceptedTerms` | boolean | ✅ | must be `true` |
| `role` | `"student"` | ❌ | default |
| `referralCode` | string | ❌ | |

```json
{
  "name": "Aisha Bello",
  "email": "aisha@example.com",
  "matricNo": "190802044",
  "password": "securepassword123",
  "acceptedTerms": true,
  "role": "student",
  "referralCode": "TUNDE4F2"
}
```

**Response `201`**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_9f2k3a1x",
      "name": "Aisha Bello",
      "email": "aisha@example.com",
      "matricNo": "190802044",
      "role": "student",
      "repApplicationStatus": "none",
      "emailVerified": false,
      "walletBalance": 0,
      "isSuspended": false,
      "isDeactivated": false,
      "createdAt": "2026-07-15T09:00:00.000Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
Also sets the `refreshToken` HTTP-only cookie. `409 VALIDATION_ERROR` (`field: "email"`) if the email is already registered.

### Register (Rep)
**POST** `/v1/auth/register`

**Flow:** Same endpoint, `role: "rep"` plus a `space` block describing the department/association they want to run. The account is created as a `student` with `repApplicationStatus: "pending"` — it is **not** promoted and **no space exists yet**. The response comes back as a `403` with the user/token still in `data`, so the client can log the user in and show a "pending review" screen instead of treating it as a hard failure. An admin must call `POST /admin/reps/{repId}/verify` before the space is created and the account becomes a `rep` (see §14.3).

**Payload**
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name`, `email`, `matricNo`, `password`, `acceptedTerms` | — | ✅ | same as student |
| `role` | `"rep"` | ✅ | |
| `referralCode` | string | ❌ | |
| `space.name` | string | ✅ | |
| `space.short` | string | ✅ | 2–6 chars, monogram |
| `space.kind` | `"department"` \| `"association"` \| `"faculty"` \| `"club"` | ✅ | |
| `space.school` | string | ✅ | |
| `space.faculty` | string | ❌ | |
| `space.theme` | `"emerald"` \| `"ocean"` \| `"royal"` \| `"crimson"` \| `"tangerine"` | ❌ | default `"emerald"` |
| `space.coRepInvites` | string[] | ❌ | co-rep emails to invite once approved |

```json
{
  "name": "Tunde Okafor",
  "email": "tunde@unilag.edu.ng",
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

**Response `403 REP_APPROVAL_PENDING`**
```json
{
  "success": false,
  "error": { "code": "REP_APPROVAL_PENDING", "message": "Rep application is under review" },
  "data": {
    "user": {
      "id": "usr_7q1m9z2p",
      "name": "Tunde Okafor",
      "email": "tunde@unilag.edu.ng",
      "role": "student",
      "repApplicationStatus": "pending",
      "walletBalance": 0
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Login
**POST** `/v1/auth/login`

**Flow:** Standard email/password login. `spaceIds` embedded in the token snapshot the caller's memberships/rep spaces *at login time* — if a rep's space is provisioned after their last login, call `POST /auth/refresh` (or log in again) to pick it up.

**Payload**
```json
{ "email": "aisha@example.com", "password": "securepassword123" }
```

**Response `200`**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_9f2k3a1x",
      "name": "Aisha Bello",
      "email": "aisha@example.com",
      "role": "student",
      "repApplicationStatus": "none",
      "walletBalance": 1250000,
      "isSuspended": false,
      "isDeactivated": false
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
`401 UNAUTHENTICATED` on a wrong email/password. `403 ACCOUNT_SUSPENDED` / `403 ACCOUNT_DEACTIVATED` if applicable. `403 REP_APPROVAL_PENDING` shape matches register.

### Google Sign-In
**POST** `/v1/auth/google`

**Flow:** Client completes the Google OAuth flow itself and posts the resulting ID token here. First-time sign-in creates the account (student, or rep-pending if `role: "rep"` + `space` are sent); subsequent sign-ins just log the existing account in. `matricNo` is only required the first time.

**Payload**
```json
{
  "idToken": "<Google ID token from the OAuth flow>",
  "matricNo": "190802044",
  "role": "student",
  "referralCode": "OPTIONAL-REF-CODE"
}
```
**Response `200`** — same shape as Login. `501 NOT_IMPLEMENTED` if Google sign-in isn't configured server-side, `401 INVALID_CREDENTIALS` if the ID token fails verification or the Google email isn't verified, `422 VALIDATION_ERROR` (`field: "matricNo"`) if it's the first sign-in and `matricNo` is missing.

### Refresh Access Token
**POST** `/v1/auth/refresh`

**Flow:** Call this whenever a request comes back `401 TOKEN_EXPIRED`, or proactively on app foreground. No payload — the refresh token is read from the HTTP-only cookie. Rotates the refresh token (old one is revoked) and returns a new access token.

**Response `200`**
```json
{ "success": true, "data": { "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." } }
```
`401 UNAUTHENTICATED` if the cookie is missing, expired, revoked, or the account is suspended/deactivated — treat this as a hard logout.

### Logout
**POST** `/v1/auth/logout`

**Flow:** Call on explicit sign-out. No payload. Revokes the current refresh token and clears the cookie. Always returns `204` even if there was no active session.

### Verify Email
**POST** `/v1/auth/verify-email`

**Flow:** The verification email links to a frontend route with `?token=...`; that page reads the token and posts it here.

**Payload**
```json
{ "token": "a1b2c3d4e5f6..." }
```
**Response `200`**
```json
{ "success": true, "data": { "verified": true } }
```
`400 VALIDATION_ERROR` if the token is invalid, already used, or expired.

### Forgot Password
**POST** `/v1/auth/forgot-password`

**Flow:** From the "forgot password" form. Always returns `200` with a generic message regardless of whether the account exists, to prevent email enumeration — don't branch UI on the response, just show "check your email."

**Payload**
```json
{ "email": "aisha@example.com" }
```
**Response `200`**
```json
{ "success": true, "data": { "message": "If an account exists, a reset link has been sent." } }
```

### Reset Password
**POST** `/v1/auth/reset-password`

**Flow:** The reset email links to a frontend route with `?token=...`; that page collects a new password and posts both here. Revokes every active session for the account, so redirect to login afterward.

**Payload**
```json
{ "token": "a1b2c3d4e5f6...", "password": "newSecurePassword123" }
```
**Response `200`**
```json
{ "success": true, "data": { "success": true } }
```
`400 VALIDATION_ERROR` if the token is invalid/used/expired.

### Get Current User
**GET** `/v1/auth/me`

**Flow:** Call on app boot (after reading a stored access token) to hydrate the session with fresh DB state — role changes (e.g. rep approval), wallet balance, and space membership are not guaranteed to be current in a long-lived token. `joinCode` is included per space only for spaces where the caller is a `rep`.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "usr_7q1m9z2p",
    "name": "Tunde Okafor",
    "email": "tunde@unilag.edu.ng",
    "emailVerified": true,
    "phone": "+2348012345678",
    "avatarUrl": null,
    "role": "rep",
    "repApplicationStatus": "approved",
    "matricNo": "190802044",
    "level": "300",
    "walletBalance": 0,
    "referralCode": "TUNDE4F2",
    "createdAt": "2026-06-01T08:00:00.000Z",
    "spaces": [
      {
        "id": "spc_9f3k2j1",
        "name": "Economics Student Association",
        "short": "ESA",
        "kind": "association",
        "hue": "emerald",
        "joinCode": "ESA-7F2K",
        "membership": "rep"
      }
    ]
  }
}
```

---

## 3. Profile & Account (`/me`)
All routes below require authentication and operate on the caller's own account.

### Update Profile
**PATCH** `/v1/me`

**Flow:** Called from the profile-edit screen. Send only the fields that changed. Changing `email` re-triggers verification — treat the account as unverified again in the UI until the new address is confirmed.

**Payload (all optional, at least one accepted)**
```json
{ "name": "Aisha B. Bello", "email": "aisha.new@example.com", "phone": "+2348012345678", "avatarUrl": "https://api.duevy.com/uploads/avatars/abc123.jpg" }
```
`matricNo`, `level`, `department`, `role`, and `walletBalance` are read-only here — sending them returns `422 FIELD_READ_ONLY`.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "usr_9f2k3a1x",
    "name": "Aisha B. Bello",
    "email": "aisha.new@example.com",
    "emailVerified": false,
    "phone": "+2348012345678",
    "avatarUrl": "https://api.duevy.com/uploads/avatars/abc123.jpg",
    "role": "student",
    "walletBalance": 1250000,
    "updatedAt": "2026-07-15T09:10:00.000Z"
  }
}
```
`409 EMAIL_IN_USE` if the new email is taken. `422 FIELD_READ_ONLY` with `details: [{ "field": "role", "issue": "read-only" }]` for locked fields.

### Upload Avatar
**POST** `/v1/me/avatar`

**Flow:** Called from an image picker. Immediately persists the file server-side and updates `avatarUrl` on the user record — no separate `PATCH /me` call needed afterward.

**Payload:** `multipart/form-data`, field name `file`. Accepts JPEG/PNG/WebP, max 2 MB.

**Response `200`**
```json
{ "success": true, "data": { "avatarUrl": "https://api.duevy.com/uploads/avatars/abc123.jpg" } }
```
`400 VALIDATION_ERROR` if the file is missing, wrong type, or over 2 MB.

### Change Password
**PUT** `/v1/me/password`

**Flow:** From the security/settings screen. Revokes every other active session (refresh token) except the caller's current one — useful copy: "you'll stay logged in here; other devices will be signed out."

**Payload**
```json
{ "currentPassword": "oldPassword123", "newPassword": "newSecurePassword456" }
```
**Response `200`**
```json
{ "success": true, "data": { "success": true } }
```
`400 INVALID_CREDENTIALS` (`field: "currentPassword"`) if the current password is wrong.

### Notification Preferences
**GET** `/v1/me/notification-preferences`

**Flow:** Load once when the notification-settings screen mounts.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "email": { "dueReminders": true, "paymentReceipts": true },
    "push": { "dueReminders": true, "payments": true, "circleActivity": true }
  }
}
```

**PUT** `/v1/me/notification-preferences`

**Flow:** Send the **full object** on any toggle change — partial updates aren't supported, so merge client-side first.

**Payload:** same shape as the GET response, all fields required.
```json
{
  "email": { "dueReminders": true, "paymentReceipts": false },
  "push": { "dueReminders": true, "payments": true, "circleActivity": false }
}
```
**Response `200`** — echoes the saved object.

### Get Overview (Student Dashboard)
**GET** `/v1/me/overview`

**Flow:** The landing screen for a logged-in student. Single call to populate the whole dashboard — balance, what's owed, and recent activity.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "walletBalance": 1250000,
    "outstanding": { "amount": 515000, "count": 1 },
    "paidThisSession": 0,
    "openDues": [
      {
        "id": "due_1a2b3c",
        "title": "Dept levy",
        "amount": 500000,
        "dueDate": "2026-08-01",
        "category": "levy",
        "status": "active",
        "overdue": false,
        "space": { "id": "spc_9f3k2j1", "name": "Engineering 101", "short": "ENG101", "hue": "emerald" }
      }
    ],
    "recentTransactions": [
      {
        "id": "txn_44df",
        "type": "topup",
        "title": "Wallet top-up",
        "detail": "Monnify",
        "amount": 500000,
        "method": "Monnify",
        "status": "completed",
        "reference": "DVY-2201-8834",
        "createdAt": "2026-07-10T08:30:00.000Z"
      }
    ]
  }
}
```

### List Active Sessions
**GET** `/v1/me/sessions`

**Flow:** For a "manage devices" screen. `current` flags the session tied to the cookie on the request that's calling this.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "sess_1", "device": "Chrome on Windows", "ip": "102.89.23.10", "lastSeenAt": "2026-07-15T09:00:00.000Z", "current": true },
    { "id": "sess_2", "device": "Duevy iOS App", "ip": "102.89.44.2", "lastSeenAt": "2026-07-10T18:22:00.000Z", "current": false }
  ]
}
```

### Revoke a Session
**DELETE** `/v1/me/sessions/{sessionId}`

**Flow:** "Log out this device" action next to a session row. Returns `204`. `404` if not found or already revoked.

### Delete Account
**DELETE** `/v1/me`

**Flow:** Danger-zone action, always behind a re-auth (password) prompt and a confirmation dialog. Soft-deletes (deactivates) the account and revokes all sessions — redirect straight to the logged-out state on success.

**Payload**
```json
{ "password": "currentPassword123", "reason": "No longer a student here" }
```
**Response `204`** — no body.
`400 INVALID_CREDENTIALS` if the password is wrong. `409 WALLET_NOT_EMPTY` if the wallet balance is above zero (withdraw/spend it first). `409 ACTIVE_REP_OBLIGATIONS` if the caller is a lead rep of a space with active dues (transfer lead or close dues first).

---

## 4. Student Dashboard & Dues

### List My Dues
**GET** `/v1/dues`

**Flow:** The "My Dues" tab. Supports filtering by space/status/category for sub-tabs (e.g. "Unpaid", "Overdue").

**Query:** `spaceId`, `status` (`unpaid` | `paid` | `overdue`), `category` (`levy` | `dinner` | `handout` | `welfare` | `sport`), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "due_1a2b3c",
      "spaceId": "spc_9f3k2j1",
      "title": "Dept levy",
      "note": "Covers semester activities",
      "amount": 500000,
      "processingFee": 15000,
      "payableAmount": 515000,
      "dueDate": "2026-08-01",
      "category": "levy",
      "status": "unpaid",
      "paidAt": null,
      "reference": null
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```
`amount` is the face value the rep set; `payableAmount` (face + 3% fee) is what the student actually pays.

### Get a Due
**GET** `/v1/dues/{dueId}`

**Flow:** Due-detail screen, e.g. after tapping a row from the list above. Same row shape as the list.

**Response `200`** — single object, same shape as a list row above.
`403 NOT_A_MEMBER` if the caller isn't a member and the due doesn't `allowGuests`. `404` if the due doesn't exist.

### Pay a Due
**POST** `/v1/dues/{dueId}/pay` — **Requires `Idempotency-Key`.**

**Flow:** Triggered from the "Pay" button on a due. The `method` the user picks in a payment-method sheet decides which of the three payloads to send. `wallet`/`card` settle synchronously in the response; `online` hands back a redirect URL — send the user there, then poll `GET /payments/{reference}/status` on return.

**Wallet**
```json
{ "method": "wallet" }
```
**Response `200`**
```json
{
  "success": true,
  "data": {
    "transaction": {
      "id": "txn_44df",
      "type": "due",
      "title": "Dept levy",
      "detail": "Engineering 101",
      "amount": -515000,
      "method": "Wallet",
      "status": "completed",
      "reference": "DVY-4821-7735",
      "createdAt": "2026-07-15T09:20:00.000Z"
    },
    "receiptUrl": "https://api.duevy.com/v1/dues/due_1a2b3c/receipt"
  }
}
```
`402 INSUFFICIENT_FUNDS` if the wallet balance is too low.

**Saved Card**
```json
{ "method": "card", "cardId": "card_9x2k1" }
```
**Response `200`** — same shape as wallet, `method: "Visa •••• 4242"`. Charges a card saved via `POST /v1/wallet/cards`. `404` if the card doesn't belong to the caller. `402 CARD_DECLINED` if the charge fails.

**Online (Monnify)**
```json
{ "method": "online" }
```
**Response `200`**
```json
{ "success": true, "data": { "checkoutUrl": "https://sandbox.monnify.com/checkout/...", "reference": "DVY-4821-7735" } }
```
Redirect the browser to `checkoutUrl`; the payer completes checkout there. Poll `GET /v1/payments/{reference}/status` afterward.

All three return `409 DUE_ALREADY_PAID` on a duplicate attempt and `409 DUE_NOT_PAYABLE` if the due isn't active.

### Download Receipt
**GET** `/v1/dues/{dueId}/receipt` (also `/v1/transactions/{transactionId}/receipt`)

**Flow:** "Download receipt" link on a paid due or transaction row. Returns a PDF (`Content-Type: application/pdf`) — open it directly or trigger a browser download. `404` if unpaid.

---

## 5. Wallet & Cards

### Get Wallet Balance
**GET** `/v1/wallet`

**Flow:** Wallet-tab header. `pendingBalance` reflects top-ups still awaiting online confirmation — show it as "on the way" separately from the spendable `balance`.

**Response `200`**
```json
{ "success": true, "data": { "balance": 1250000, "pendingBalance": 0 } }
```

### Top-Up
**POST** `/v1/wallet/top-up` — **Requires `Idempotency-Key`.**

**Flow:** From the "Add money" flow. Amount must be between ₦100 and ₦500,000 (kobo). `card` settles synchronously; `online` redirects.

**Saved Card**
```json
{ "amount": 500000, "method": "card", "cardId": "card_9x2k1" }
```
**Response `200`**
```json
{
  "success": true,
  "data": {
    "transaction": {
      "id": "txn_77qq",
      "type": "topup",
      "title": "Wallet top-up",
      "detail": "Visa •••• 4242",
      "amount": 500000,
      "method": "Visa •••• 4242",
      "status": "completed",
      "reference": "DVY-2201-8834",
      "createdAt": "2026-07-15T10:00:00.000Z"
    }
  }
}
```
`404` if the card isn't found. `402 CARD_DECLINED` if the charge fails.

**Online (Monnify)**
```json
{ "amount": 500000, "method": "online" }
```
**Response `200`**
```json
{ "success": true, "data": { "checkoutUrl": "https://sandbox.monnify.com/checkout/...", "reference": "DVY-2201-8834" } }
```
Redirect, then poll `GET /v1/payments/{reference}/status`.

### List Saved Cards
**GET** `/v1/wallet/cards`

**Flow:** Payment-method picker and the wallet "Cards" tab. Call before showing the pay/top-up sheet so the user can pick a saved card.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "card_9x2k1", "brand": "Visa", "last4": "4242", "expiry": "12/28", "isDefault": true },
    { "id": "card_4m8p2", "brand": "Mastercard", "last4": "5588", "expiry": "03/27", "isDefault": false }
  ]
}
```

### Save a Card
**POST** `/v1/wallet/cards` — **Requires `Idempotency-Key`.**

**Flow:** Redirect flow, same pattern as an online payment. Click "Add card" → call this → redirect the user to `checkoutUrl` → Monnify runs a ₦50 verification charge and tokenizes the card there → poll `GET /v1/payments/{reference}/status` on return → once `status: "completed"`, re-fetch `GET /v1/wallet/cards` to show the new card. The first card ever saved is always made default regardless of `isDefault`.

**Payload**
```json
{ "isDefault": false }
```
(optional, defaults `false`)

**Response `200`**
```json
{ "success": true, "data": { "checkoutUrl": "https://sandbox.monnify.com/checkout/...", "reference": "DVY-5512-0091" } }
```

### Set Default Card
**PATCH** `/v1/wallet/cards/{cardId}`

**Flow:** "Make default" action on a card row.

**Payload**
```json
{ "isDefault": true }
```
(this is the only accepted value)

**Response `200`**
```json
{ "success": true, "data": { "id": "card_4m8p2", "brand": "Mastercard", "last4": "5588", "expiry": "03/27", "isDefault": true } }
```
`404` if the card isn't found.

### Delete Card
**DELETE** `/v1/wallet/cards/{cardId}`

**Flow:** "Remove" action on a card row, usually behind a confirm dialog. If the deleted card was the default, the most recently added remaining card is promoted automatically — refresh the card list after this call to reflect that.

**Response `204`** — no body. `404` if not found.

### Wallet Activity
**GET** `/v1/wallet/activity`

**Flow:** Lightweight feed for the wallet home screen (top-ups, withdrawals, refunds, referral rewards, wallet-method payments) — cheaper than the full ledger (§13) for a quick "recent activity" list.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "txn_77qq", "label": "Wallet top-up", "detail": "Visa •••• 4242", "amount": 500000, "createdAt": "2026-07-15T10:00:00.000Z" },
    { "id": "txn_44df", "label": "Dept levy", "detail": "Engineering 101", "amount": -515000, "createdAt": "2026-07-10T08:30:00.000Z" }
  ]
}
```
Amounts are signed: positive = money in, negative = money out.

---

## 6. Spaces (Departments)

### List My Spaces
**GET** `/v1/spaces`

**Flow:** "My Circles" screen — every space the caller belongs to, as member or rep.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "spc_9f3k2j1",
      "name": "Engineering 101",
      "short": "ENG101",
      "kind": "department",
      "hue": "emerald",
      "about": null,
      "faculty": "Engineering",
      "school": "University of Lagos",
      "memberCount": 84,
      "theme": "emerald",
      "createdAt": "2026-01-15T10:00:00.000Z",
      "membership": "member"
    }
  ]
}
```

### Lookup Code (Department Lookup)
**POST** `/v1/spaces/lookup`

**Flow:** The "Join a circle" flow — the student types/pastes a join code, this resolves it to a preview (name, member count, active dues) **before** committing to join, so they can confirm it's the right department first.

**Payload**
```json
{ "code": "ENG101" }
```
**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "spc_9f3k2j1",
    "name": "Engineering 101",
    "short": "ENG101",
    "kind": "department",
    "hue": "emerald",
    "about": "Mechanical Engineering, 200 level",
    "faculty": "Engineering",
    "school": "University of Lagos",
    "memberCount": 84,
    "theme": "emerald",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "code": "ENG101",
    "dues": [
      { "id": "due_1a2b3c", "title": "Dept levy", "amount": 500000, "dueDate": "2026-08-01", "category": "levy", "status": "active" }
    ]
  }
}
```
`404 JOIN_CODE_INVALID` if the code doesn't match an active space. Rate-limited to 10 lookups/min per user.

### Get a Space
**GET** `/v1/spaces/{spaceId}`

**Flow:** Space-detail screen for someone already in the space (members, guests, admins). Not for previewing before joining — use Lookup Code for that.

**Response `200`** — same shape as a list row above, plus `membership`.
`403` if the caller has no membership and isn't an admin.

### Join Space
**POST** `/v1/spaces/{spaceId}/join`

**Flow:** Confirm step after a successful Lookup Code call — pass the same `code` plus the `spaceId` from that lookup response. Joining is immediate for anyone with a valid code; reps never approve or gate admission.

**Payload**
```json
{ "code": "ENG101", "as": "member" }
```
(`as` defaults to `"member"`, may be `"guest"`)

**Response `201`**
```json
{ "success": true, "data": { "spaceId": "spc_9f3k2j1", "status": "active", "membership": "member", "joinedAt": "2026-07-15T09:30:00.000Z" } }
```
`422 JOIN_CODE_INVALID` if the code doesn't match this specific space. `409 ALREADY_MEMBER` if already joined.

### Leave a Space
**DELETE** `/v1/spaces/{spaceId}/membership`

**Flow:** "Leave circle" action, behind a confirm dialog.

**Response `204`** — no body. `404` if not a member. `409 UNPAID_OBLIGATIONS` if the caller has unpaid active dues in that space — settle those first.

### Update Space Profile (Lead Rep)
**PATCH** `/v1/spaces/{spaceId}`

**Flow:** Rep's "Edit circle" settings screen. Lead rep only.

**Payload (all optional, at least one required)**
```json
{ "name": "Engineering 101", "short": "ENG101", "about": "Mechanical Engineering, 200 level", "hue": "emerald", "theme": "ocean" }
```
`hue` ∈ `emerald` | `indigo` | `amber` | `rose` | `slate`. `theme` ∈ `emerald` | `ocean` | `royal` | `crimson` | `tangerine`.

**Response `200`** — updated space object, same shape as Get a Space. `403` if not the lead rep.

---

## 7. Rep — Circle Management (`/v1/spaces/{spaceId}/...`)
Everything in this section requires the caller to be a rep of the space; routes marked **(Lead)** require the `lead` role specifically (co-reps are forbidden — `403`).

### Rep Dashboard
**GET** `/v1/spaces/{spaceId}/overview`

**Flow:** Landing screen when a rep opens their circle. One call for everything: join code, collection stats, active dues progress, and the newest joiners.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "space": {
      "id": "spc_9f3k2j1",
      "name": "Engineering 101",
      "short": "ENG101",
      "kind": "department",
      "hue": "emerald",
      "about": null,
      "faculty": "Engineering",
      "school": "University of Lagos",
      "memberCount": 84,
      "theme": "emerald",
      "createdAt": "2026-01-15T10:00:00.000Z"
    },
    "joinCode": "ENG101-7F2K",
    "stats": { "collected": 25750000, "outstanding": 17250000, "unpaidCount": 34, "collectionRate": 0.6 },
    "activeDues": [
      { "id": "due_1a2b3c", "title": "Dept levy", "amount": 500000, "dueDate": "2026-08-01", "category": "levy", "status": "active", "paidCount": 50, "memberCount": 84 }
    ],
    "newMembers": [
      { "id": "usr_9f2k3a1x", "name": "Aisha Bello", "matricNo": "190802044", "level": "200", "email": "aisha@example.com", "joinedAt": "2026-07-14T12:00:00.000Z" }
    ]
  }
}
```

### List Members
**GET** `/v1/spaces/{spaceId}/members`

**Flow:** Circle roster screen, searchable/paginated.

**Query:** `q` (search by name/matric/email), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "usr_9f2k3a1x", "name": "Aisha Bello", "matricNo": "190802044", "level": "200", "email": "aisha@example.com", "joinedAt": "2026-07-14T12:00:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 84, "totalPages": 5 }
}
```

### Remove a Member **(Lead)**
**DELETE** `/v1/spaces/{spaceId}/members/{userId}`

**Flow:** "Remove" action on a roster row, behind a confirm dialog.

**Response `204`** — no body. `404` if the user isn't a member.

### Regenerate Join Code
**POST** `/v1/spaces/{spaceId}/join-code/regenerate`

**Flow:** "Regenerate code" button on the dashboard's join-code card — invalidates the old code immediately (anyone with the old code can no longer join).

**Response `200`**
```json
{ "success": true, "data": { "code": "ENG101-9K3Q" } }
```

### List Reps
**GET** `/v1/spaces/{spaceId}/reps`

**Flow:** "Manage co-reps" screen.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "usr_7q1m9z2p", "name": "Tunde Okafor", "email": "tunde@unilag.edu.ng", "role": "lead" },
    { "id": "usr_3k8p1x9m", "name": "Ngozi Eze", "email": "ngozi@unilag.edu.ng", "role": "co" }
  ]
}
```

### Invite a Co-Rep **(Lead)**
**POST** `/v1/spaces/{spaceId}/reps/invite`

**Flow:** "Add co-rep" form. The invitee must already have a Duevy account — there's no invite-by-email-to-a-non-user flow; tell the user to ask their co-rep to sign up first.

**Payload**
```json
{ "email": "cofounder@example.com" }
```
**Response `201`**
```json
{ "success": true, "data": { "id": "usr_2p9k1m3x", "name": "Chidi Nwosu", "email": "cofounder@example.com", "role": "co" } }
```
`422 USER_NOT_FOUND` (`field: "email"`) if no account exists for that address. `409 ALREADY_REP` if already a rep of this space. Sends a notification + email to the invitee.

### Remove a Co-Rep **(Lead)**
**DELETE** `/v1/spaces/{spaceId}/reps/{userId}`

**Flow:** "Remove co-rep" action.

**Response `204`** — no body. `409 LAST_LEAD_REP` if trying to remove the sole lead (transfer lead first).

### Audit Log
**GET** `/v1/spaces/{spaceId}/audit-log`

**Flow:** Circle "Activity" tab — a chronological trail of rep actions for transparency.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "log_1", "action": "due_published", "description": "Published due \"Dept levy\"", "actor": { "id": "usr_7q1m9z2p", "name": "Tunde Okafor" }, "createdAt": "2026-07-01T09:00:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

### Transfer Lead **(Lead)**
**POST** `/v1/spaces/{spaceId}/transfer-lead`

**Flow:** "Transfer leadership" — a security-sensitive action, so it re-verifies the caller's password. The target must already be a co-rep of the space (invite them first if not).

**Payload**
```json
{ "userId": "usr_3k8p1x9m", "password": "currentPassword123" }
```
**Response `200`**
```json
{ "success": true, "data": { "spaceId": "spc_9f3k2j1", "newLeadId": "usr_3k8p1x9m" } }
```
`400 INVALID_CREDENTIALS` if the password is wrong. `409` if the target isn't already a co-rep.

### Archive Space **(Lead)**
**POST** `/v1/spaces/{spaceId}/archive`

**Flow:** Circle "Danger zone" — permanently retires the space (hides it from student search/join). Payouts must be fully cleared first.

**Payload**
```json
{ "password": "currentPassword123", "reason": "Semester ended" }
```
**Response `204`** — no body. `409 PENDING_PAYOUT` if a payout is still processing, or `409 HELD_BALANCE` if there's an uncollected payout balance — pay it out first.

---

## 8. Rep — Dues Management (`/v1/spaces/{spaceId}/dues`)
All routes require the caller to be a rep of the space (lead or co).

### List Dues
**GET** `/v1/spaces/{spaceId}/dues`

**Flow:** "Dues" tab in the circle dashboard, with `draft`/`active`/`closed` sub-tabs.

**Query:** `status` (`draft` | `active` | `closed`), `category`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "due_1a2b3c",
      "spaceId": "spc_9f3k2j1",
      "title": "Dept levy",
      "note": "Covers semester activities",
      "amount": 500000,
      "dueDate": "2026-08-01",
      "category": "levy",
      "status": "active",
      "allowGuests": false,
      "paidCount": 50,
      "memberCount": 84,
      "publishedAt": "2026-07-01T09:00:00.000Z",
      "closedAt": null,
      "createdAt": "2026-06-28T09:00:00.000Z"
    }
  ]
}
```

### Create Due
**POST** `/v1/spaces/{spaceId}/dues`

**Flow:** "New due" form. Leave `publish: false` (the default) to save as a draft the rep can review before it's visible to students; set `publish: true` to go live immediately.

**Payload**
```json
{
  "title": "Dinner",
  "note": "optional",
  "amount": 500000,
  "dueDate": "2026-08-20",
  "category": "dinner",
  "allowGuests": false,
  "publish": true
}
```
`dueDate` must be today or later (`YYYY-MM-DD`).

**Response `201`** — created due, same shape as a list row above (`status: "active"` if published, else `"draft"`).

### Edit a Due
**PATCH** `/v1/spaces/{spaceId}/dues/{dueId}`

**Flow:** "Edit due" form, for drafts or still-active dues.

**Payload (all optional, at least one required)** — same fields as create, minus `publish`.
```json
{ "title": "Dinner (updated)", "amount": 550000 }
```
**Response `200`** — updated due. `409 DUE_CLOSED` if the due is closed. `amount` can't change once any payment exists (`409 DUE_HAS_PAYMENTS`).

### Publish a Due
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/publish`

**Flow:** "Publish" button on a draft due — makes it visible/payable to students.

**Response `200`** — updated due, `status: "active"`. `409 INVALID_TRANSITION` if not currently a draft.

### Close a Due
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/close`

**Flow:** "Close" button — stops accepting new payments, e.g. once the deadline has passed.

**Response `200`** — updated due, `status: "closed"`. `409 INVALID_TRANSITION` if not currently active.

### Delete a Due
**DELETE** `/v1/spaces/{spaceId}/dues/{dueId}`

**Flow:** "Delete" action, drafts only (published dues can be closed, not deleted, to preserve payment history).

**Response `204`** — no body. `409 ONLY_DRAFTS_DELETABLE` otherwise.

### Collections Roster
**GET** `/v1/spaces/{spaceId}/dues/{dueId}/collections`

**Flow:** Per-due "Collections" screen — who's paid, who hasn't, and the money totals.

**Query:** `status` (`all` | `paid` | `unpaid`, default `all`), `q` (search), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "totals": { "paid": 50, "unpaid": 34, "collected": 25750000, "fees": 750000, "net": 25000000, "expected": 43260000, "rate": 0.5952 },
    "students": [
      { "id": "usr_9f2k3a1x", "name": "Aisha Bello", "matricNo": "190802044", "level": "200", "email": "aisha@example.com", "status": "paid", "paidAt": "2026-07-10T08:30:00.000Z", "reference": "DVY-4821-7735" },
      { "id": "usr_3k8p1x9m", "name": "Ngozi Eze", "matricNo": "190802045", "level": "200", "email": "ngozi@example.com", "status": "unpaid", "paidAt": null, "reference": null }
    ]
  },
  "meta": { "page": 1, "perPage": 20, "total": 84, "totalPages": 5 }
}
```

### Export Collections (CSV)
**GET** `/v1/spaces/{spaceId}/dues/{dueId}/collections/export`

**Flow:** "Export CSV" button on the collections screen.

**Query:** `status` (same as above). **Response:** `text/csv` as an attachment (`Content-Disposition: attachment`).

### Remind Unpaid Members
**POST** `/v1/spaces/{spaceId}/dues/{dueId}/remind`

**Flow:** "Send reminder" button — nudges everyone unpaid (or a chosen subset, e.g. selected rows in the roster). Rate-limited to once per due per 24h.

**Payload**
```json
{ "userIds": ["usr_3k8p1x9m"] }
```
(optional — omit `userIds` entirely to remind everyone unpaid)

**Response `200`**
```json
{ "success": true, "data": { "reminded": 34 } }
```
`429 REMINDER_COOLDOWN` if this due was already reminded within the last 24 hours.

---

## 9. Payouts (Rep Only, `/v1/spaces/{spaceId}/payout...`)
All routes require the caller to be a rep of the space.

### List Banks
**GET** `/v1/banks`

**Flow:** Populate the bank picker before setting/previewing a payout account.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "code": "058", "name": "Guaranty Trust Bank" },
    { "code": "011", "name": "First Bank of Nigeria" }
  ]
}
```
Cached server-side for 24h. `502 PROVIDER_ERROR` if Monnify's bank list can't be fetched.

### Payout Summary
**GET** `/v1/spaces/{spaceId}/payout/summary`

**Flow:** Payouts tab header. All figures net of the 3% collection charge. `pending` is collections still inside the 24h clearing window; `available` is what can actually be withdrawn right now.

**Response `200`**
```json
{ "success": true, "data": { "available": 18500000, "pending": 6500000, "lifetime": 42000000 } }
```

### Get Payout Account
**GET** `/v1/spaces/{spaceId}/payout/account`

**Flow:** Load before showing "Change payout account", to display the currently saved one (masked).

**Response `200`**
```json
{ "success": true, "data": { "bankCode": "058", "bankName": "Guaranty Trust Bank", "accountNumber": "01234•••••", "accountName": "ENGINEERING 101 DEPT ASSOCIATION", "cooldownUntil": null } }
```
`404 NO_PAYOUT_ACCOUNT` if none is set yet.

### Preview Payout Account
**POST** `/v1/spaces/{spaceId}/payout/account/lookup`

**Flow:** Call this **first** as the rep types in a bank + account number, so they can see and confirm the resolved account name before committing — nothing is saved by this call.

**Payload**
```json
{ "bankCode": "058", "accountNumber": "0123456789" }
```
**Response `200`**
```json
{ "success": true, "data": { "bankCode": "058", "bankName": "Guaranty Trust Bank", "accountNumber": "0123456789", "accountName": "ENGINEERING 101 DEPT ASSOCIATION" } }
```
`422 ACCOUNT_UNVERIFIABLE` if the account can't be resolved. `400 VALIDATION_ERROR` (`field: "bankCode"`) for an unknown bank code.

### Set Payout Account
**PUT** `/v1/spaces/{spaceId}/payout/account`

**Flow:** "Save" after the rep confirms the name shown by the preview call above. Re-resolves and saves — `accountName` is never client-supplied, only ever server-resolved. Changing an *existing* account triggers a 24h payout hold and emails every rep of the space as a security notice.

**Payload** — same shape as the lookup above.
```json
{ "bankCode": "058", "accountNumber": "0123456789" }
```
**Response `200`**
```json
{ "bankCode": "058", "bankName": "Guaranty Trust Bank", "accountNumber": "0123456789", "accountName": "ENGINEERING 101 DEPT ASSOCIATION", "cooldownUntil": "2026-07-16T09:30:00.000Z" }
```
(wrapped in the standard `{ success, data }` envelope). `cooldownUntil` is `null` for a first-time save (no hold). `422 ACCOUNT_UNVERIFIABLE` as above.

### Request Payout
**POST** `/v1/spaces/{spaceId}/payout/request` — **Requires `Idempotency-Key`.**

**Flow:** "Withdraw" button. The transfer is initiated automatically server-side; the response comes back `status: "processing"` immediately — poll `GET /v1/spaces/{spaceId}/payouts` or listen for the `payout_completed` notification to know when it settles.

**Payload**
```json
{ "amount": 1000000, "note": "Venue payment" }
```
**Response `201`**
```json
{
  "success": true,
  "data": {
    "id": "pyt_5f2k9m1x",
    "amount": 1000000,
    "reference": "PAY-2026-0642",
    "status": "processing",
    "account": "Guaranty Trust Bank 01234•••••",
    "note": "Venue payment",
    "requestedAt": "2026-07-15T10:15:00.000Z",
    "settledAt": null,
    "failureReason": null
  }
}
```
`423 PAYOUTS_FROZEN` if an admin has frozen payouts for the space. `409 NO_PAYOUT_ACCOUNT` / `409 ACCOUNT_COOLDOWN` if the account isn't set or is still on hold. `402 INSUFFICIENT_PAYOUT_BALANCE` if it exceeds `available`.

### List Payouts
**GET** `/v1/spaces/{spaceId}/payouts`

**Flow:** Payouts history tab. Poll this (or watch notifications) after a request to see it flip from `processing` to `completed`/`failed`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "pyt_5f2k9m1x", "amount": 1000000, "reference": "PAY-2026-0642", "status": "completed", "account": "Guaranty Trust Bank 01234•••••", "note": "Venue payment", "requestedAt": "2026-07-15T10:15:00.000Z", "settledAt": "2026-07-15T10:16:30.000Z", "failureReason": null }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

---

## 10. Polls & Voting

### Rep: List Polls
**GET** `/v1/spaces/{spaceId}/polls`

**Flow:** "Polls" tab in the circle dashboard.

**Query:** `status` (`draft` | `active` | `closed`).

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "pol_9k2m1x",
      "spaceId": "spc_9f3k2j1",
      "title": "Best Dressed",
      "description": "Vote for the sharpest dresser",
      "deadline": "2026-08-01",
      "status": "active",
      "membersOnly": true,
      "paid": true,
      "amountPerVote": 20000,
      "slug": "best-dressed-4821",
      "totalVotes": 42,
      "revenue": 840000,
      "categories": [
        { "id": "cat_1", "title": "Male", "imageUrl": "https://api.duevy.com/uploads/polls/c1d2.jpg", "nominees": [{ "id": "nom_1", "name": "John", "imageUrl": "https://api.duevy.com/uploads/polls/a1b2.jpg", "votes": 20 }, { "id": "nom_2", "name": "James", "imageUrl": null, "votes": 22 }] }
      ]
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

### Rep: Upload Poll Image
**POST** `/v1/spaces/{spaceId}/polls/image` — `multipart/form-data`, field name `file` (JPEG/PNG/WebP, ≤ 2 MB).

**Flow:** Called from the poll builder as each category or nominee photo is picked, before the poll itself is created — the returned `imageUrl` is then included on that category/nominee in the create-poll payload (or sent via the edit-category / edit-nominee calls below for an existing poll). Same endpoint serves both — it just uploads and hands back a URL, with no association until you attach it.

**Response `200`**
```json
{ "success": true, "data": { "imageUrl": "https://api.duevy.com/uploads/polls/a1b2c3d4.jpg" } }
```

### Rep: Create Poll
**POST** `/v1/spaces/{spaceId}/polls`

**Flow:** "New poll" form — a multi-step builder (title/deadline → categories/nominees → paid or free). Leave `publish: false` (default) to save a draft first.

**Payload**
```json
{
  "title": "Best Dressed",
  "description": "optional",
  "deadline": "2026-08-01",
  "membersOnly": true,
  "paid": true,
  "amountPerVote": 20000,
  "categories": [
    { "title": "Male", "imageUrl": "https://api.duevy.com/uploads/polls/c1d2.jpg", "nominees": [{ "name": "John", "imageUrl": "https://api.duevy.com/uploads/polls/a1b2c3d4.jpg" }, { "name": "James" }] }
  ],
  "publish": false
}
```
`amountPerVote` is required (and > 0) when `paid: true`. Each category needs at least 2 nominees. `imageUrl` on a category or nominee is optional — omit it for a text-only entry. `deadline` must be in the future.

**Response `201`** — created poll, same shape as a list row above.

### Rep: Edit Nominee Image
**PATCH** `/v1/spaces/{spaceId}/polls/{pollId}/nominees/{nomineeId}`

**Flow:** Add or replace a nominee's photo on an existing poll (e.g. from the results/edit screen), or clear it by sending `null`. Cosmetic only, so unlike other structural fields this is allowed at any poll status, including `active`.

**Payload**
```json
{ "imageUrl": "https://api.duevy.com/uploads/polls/e5f6a7b8.jpg" }
```
**Response `200`** — updated poll, same shape as a list row above. `404` if the poll or nominee doesn't exist in this space.

### Rep: Edit Category Image
**PATCH** `/v1/spaces/{spaceId}/polls/{pollId}/categories/{categoryId}`

**Flow:** Add or replace an award category's cover photo on an existing poll, or clear it by sending `null`. Cosmetic only, so it's allowed at any poll status, including `active`.

**Payload**
```json
{ "imageUrl": "https://api.duevy.com/uploads/polls/f1a2b3c4.jpg" }
```
**Response `200`** — updated poll, same shape as a list row above. `404` if the poll or category doesn't exist in this space.

### Rep: Edit Poll
**PATCH** `/v1/spaces/{spaceId}/polls/{pollId}`

**Flow:** "Edit poll" form. While `draft`, everything except `categories` is editable. Once `active`, structural fields (`membersOnly`, `paid`, `amountPerVote`) are locked and `deadline` may only be extended.

**Payload**
```json
{ "title": "Best Dressed 2026", "deadline": "2026-08-10" }
```
**Response `200`** — updated poll. `409 POLL_STRUCTURE_LOCKED` if editing a locked field on an active poll, or shortening its deadline. `409 POLL_CLOSED` once closed.

### Rep: Publish / Close Poll
**POST** `/v1/spaces/{spaceId}/polls/{pollId}/publish` — draft → active. **Flow:** makes the poll's public link live and votable.
**POST** `/v1/spaces/{spaceId}/polls/{pollId}/close` — active → closed. **Flow:** stops new votes and reveals tallies to voters; idempotent (calling again on an already-closed poll just returns it, no error).

**Response `200`** — updated poll, same shape as a list row.

### Rep: Poll Results
**GET** `/v1/spaces/{spaceId}/polls/{pollId}/results`

**Flow:** Results/analytics screen for a poll.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "poll": { "id": "pol_9k2m1x", "title": "Best Dressed", "status": "closed" },
    "totalVotes": 42,
    "revenue": 840000,
    "categories": [
      { "id": "cat_1", "title": "Male", "imageUrl": "https://api.duevy.com/uploads/polls/c1d2.jpg", "nominees": [{ "id": "nom_1", "name": "John", "imageUrl": "https://api.duevy.com/uploads/polls/a1b2.jpg", "votes": 20 }, { "id": "nom_2", "name": "James", "imageUrl": null, "votes": 22 }] }
    ]
  }
}
```

### Get Poll (Public/Voter)
**GET** `/v1/polls/{slug}`

**Flow:** The public voting page, linked from social/QR. Auth is optional — an anonymous visitor can view a non-members-only poll; casting a vote still requires login. A poll past its `deadline` auto-closes on this read.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "pol_9k2m1x",
    "spaceId": "spc_9f3k2j1",
    "title": "Best Dressed",
    "description": "Vote for the sharpest dresser",
    "deadline": "2026-08-01",
    "status": "active",
    "membersOnly": true,
    "paid": true,
    "amountPerVote": 20000,
    "slug": "best-dressed-4821",
    "totalVotes": 42,
    "categories": [
      { "id": "cat_1", "title": "Male", "imageUrl": "https://api.duevy.com/uploads/polls/c1d2.jpg", "nominees": [{ "id": "nom_1", "name": "John", "imageUrl": "https://api.duevy.com/uploads/polls/a1b2.jpg" }, { "id": "nom_2", "name": "James", "imageUrl": null }], "remaining": 1 }
    ]
  }
}
```
Nominee vote counts (`votes`) are only included once the poll is `closed`. `404` while still a draft. `403 MEMBERS_ONLY` if members-only and the (authenticated) caller isn't a space member. `remaining` per category is only present when authenticated — the votes left for that category (`null` if uncapped, i.e. non-members-only).

### Cast Vote
**POST** `/v1/polls/{slug}/votes` — paid votes **require `Idempotency-Key`**.

**Flow:** Vote-submission button. Free polls need no `method`; paid polls need a payment method exactly like a due payment. Members-only polls cap each caller to one vote per category.

**Free Poll**
```json
{ "selections": [{ "categoryId": "cat_1", "nomineeId": "nom_2", "quantity": 1 }] }
```
**Response `201`**
```json
{ "success": true, "data": { "receiptId": "DVY-6621-0043", "totalCharged": 0 } }
```
`409 ALREADY_VOTED` on a members-only poll if the caller already voted in that category.

**Wallet**
```json
{ "selections": [{ "categoryId": "cat_1", "nomineeId": "nom_2", "quantity": 3 }], "method": "wallet" }
```
**Response `201`**
```json
{ "success": true, "data": { "receiptId": "txn_88pq", "totalCharged": 61800 } }
```
`402 INSUFFICIENT_FUNDS` if the wallet balance is too low.

**Saved Card**
```json
{ "selections": [{ "categoryId": "cat_1", "nomineeId": "nom_2", "quantity": 1 }], "method": "card", "cardId": "card_9x2k1" }
```
**Response `201`** — same shape as wallet. `404` card not found, `402 CARD_DECLINED`.

**Online**
```json
{ "selections": [{ "categoryId": "cat_1", "nomineeId": "nom_2", "quantity": 1 }], "method": "online" }
```
**Response `200`**
```json
{ "success": true, "data": { "checkoutUrl": "https://sandbox.monnify.com/checkout/...", "reference": "DVY-6621-0099" } }
```
Redirect, then poll `GET /v1/payments/{reference}/status`.

Paid votes charge the same 3% fee structure as dues (1.5% Duevy + 1.5% Monnify) on top of `amountPerVote × quantity`.

---

## 11. Referrals (Rep Only)
Available to reps, admins, or anyone who leads/co-runs a space. `403` for students.

### Get My Referral Info
**GET** `/v1/referrals`

**Flow:** Referrals/rewards screen. A referral code is generated lazily on first call if the account doesn't have one yet — no separate "generate code" step needed.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "code": "TUNDE4F2",
    "link": "https://duevy.app/join?ref=TUNDE4F2",
    "rewardPerReferral": 100000,
    "summary": { "invited": 5, "joined": 3, "earned": 300000 },
    "referrals": [
      { "id": "ref_1", "name": "Aisha Bello", "status": "joined", "reward": 100000, "date": "2026-07-01T09:00:00.000Z" }
    ]
  }
}
```
`403 FORBIDDEN` for plain students.

### Send Invites
**POST** `/v1/referrals/invites`

**Flow:** "Invite friends" form — send a batch of emails at once.

**Payload**
```json
{ "emails": ["friend1@example.com", "friend2@example.com"] }
```
(1–20 emails)

**Response `200`**
```json
{ "success": true, "data": { "sent": 2 } }
```
Fires an invite email per address containing the caller's referral link/code.

---

## 12. Disputes & Notifications

### File Dispute
**POST** `/v1/disputes`

**Flow:** "Report an issue" form — available to any authenticated role (a student disputing a payment, or a rep disputing non-remittance).

**Payload**
```json
{ "type": "payment_not_reflecting", "transactionReference": "DVY-4821-7735", "description": "I paid via card but the due still shows unpaid on my dashboard." }
```
`description` must be 10–2000 characters. `transactionReference` is optional.

**Response `201`**
```json
{
  "success": true,
  "data": {
    "id": "dsp_9k1m2x",
    "type": "payment_not_reflecting",
    "openedBy": "Aisha Bello",
    "email": "aisha@example.com",
    "department": "Engineering 101",
    "status": "open",
    "slaDays": 3,
    "ageDays": 0,
    "breached": false,
    "txnReference": "DVY-4821-7735",
    "description": "I paid via card but the due still shows unpaid on my dashboard.",
    "resolution": null,
    "createdAt": "2026-07-15T10:30:00.000Z"
  }
}
```

### List My Disputes
**GET** `/v1/disputes`

**Flow:** "My disputes" tracker — shows the caller's own filed disputes and whether each is past its SLA.

**Response `200`** — array of the same shape as above, newest first.

### List Notifications
**GET** `/v1/notifications`

**Flow:** Notification bell/inbox. Use `since` for lightweight polling (only fetch what's new since the last check) instead of re-paging everything.

**Query:** `since` (ISO timestamp), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "ntf_1", "kind": "payment_received", "tone": "brand", "title": "Payment received", "detail": "Aisha Bello paid ₦5,000.00 for \"Dept levy\".", "href": "/dashboard/collections", "read": false, "createdAt": "2026-07-15T09:20:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1, "unreadCount": 1 }
}
```
`kind` ∈ `due_reminder` | `payment_received` | `join_request` | `payout_completed` | `poll_milestone` | `referral_earned` | `system`. `tone` ∈ `brand` | `amber` | `rose`.

### Mark Notification Read
**POST** `/v1/notifications/{notificationId}/read`

**Flow:** Fired when a notification is opened/tapped.

**Response `204`** — no body. `404` if not found.

### Mark All Notifications Read
**POST** `/v1/notifications/read-all`

**Flow:** "Mark all as read" action in the notification inbox.

**Response `204`** — no body.

---

## 13. Transactions & Payments

### List Transactions (Ledger)
**GET** `/v1/transactions`

**Flow:** Full transaction-history screen (superset of `GET /wallet/activity`), with filters for a "search my history" experience.

**Query:** `direction` (`all` | `in` | `out`, default `all`), `type` (`due` | `topup` | `referral` | `withdrawal` | `refund` | `vote`), `status` (`completed` | `pending` | `failed`), `from`, `to` (ISO dates), `q` (search title/reference), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "txn_44df", "type": "due", "title": "Dept levy", "detail": "Engineering 101", "amount": -515000, "method": "Wallet", "status": "completed", "reference": "DVY-4821-7735", "createdAt": "2026-07-10T08:30:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

### Get Transaction
**GET** `/v1/transactions/{transactionId}`

**Flow:** Transaction-detail screen after tapping a ledger row.

**Response `200`** — single object, same shape as a list row. `404` if not the caller's.

### Transaction Receipt
**GET** `/v1/transactions/{transactionId}/receipt`

**Flow:** "Download receipt" from a transaction row. Returns a PDF, same as `GET /dues/{dueId}/receipt`.

### Poll Online Payment Status
**GET** `/v1/payments/{reference}/status`

**Flow:** Call this on return from any `checkoutUrl` redirect flow (due payment, wallet top-up, card save, or poll vote) — poll every few seconds until it's no longer `pending`.

**Response `200`** (pending)
```json
{ "success": true, "data": { "status": "pending" } }
```
**Response `200`** (completed)
```json
{
  "success": true,
  "data": {
    "status": "completed",
    "transaction": { "id": "txn_44df", "type": "due", "title": "Dept levy", "detail": "Engineering 101", "amount": -515000, "method": "Monnify", "status": "completed", "reference": "DVY-4821-7735", "createdAt": "2026-07-15T09:20:00.000Z" }
  }
}
```
`transaction` is only present once `status: "completed"`. `404` if the reference doesn't belong to the caller.

---

## 14. Admin (`/v1/admin/...`)
Every route below requires an authenticated `admin` account. Routes annotated with a **permission** additionally require that permission on the admin's role (`userManagement`, `payouts`, `disputes`, or `overrides`) — configured via §14.9 Roles. `PUT /admin/roles/{role}` requires the `super_admin` sub-role specifically. Nearly every mutating admin action is recorded to the audit log (§14.9).

### 14.1 Overview
**GET** `/v1/admin/overview`

**Flow:** Admin dashboard landing screen — a single call for the top-line metrics plus a dynamic "needs attention" feed the admin can click straight into (pending rep approvals, overdue dues, low-collection spaces, breached-SLA disputes).

**Response `200`**
```json
{
  "success": true,
  "data": {
    "totalUsers": 4820,
    "activeReps": 62,
    "duesCollected": 128500000,
    "duesTarget": 210000000,
    "floatHeld": 18500000,
    "overdue": { "amount": 4200000, "count": 6 },
    "attention": [
      { "id": "pending-reps", "tone": "warning", "badge": "Verification", "title": "3 rep applications awaiting review", "detail": "New reps cannot collect dues until verified.", "href": "/admin/reps", "linkLabel": "Review reps" },
      { "id": "overdue-dues", "tone": "warning", "badge": "Overdue", "title": "6 dues past deadline with unpaid balances", "detail": "₦42,000.00 still outstanding across overdue dues.", "href": "/admin/spaces", "linkLabel": "Review spaces" }
    ]
  }
}
```

### 14.2 Users — *userManagement*

**GET** `/v1/admin/users` — **Flow:** admin's user-directory table. **Query:** `role`, `kycStatus`, `suspended` (`true`/`false`), `q`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "usr_9f2k3a1x", "role": "student", "name": "Aisha Bello", "email": "aisha@example.com", "department": "Engineering 101", "walletBalance": 1250000, "isSuspended": false, "isDeactivated": false, "kycStatus": "unverified", "kycDocs": [], "spaces": ["Engineering 101"] }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 4820, "totalPages": 241 }
}
```

**GET** `/v1/admin/users/{userId}` — **Flow:** user-detail drawer. **Response `200`** — single object, same shape as above.

**POST** `/v1/admin/users/{userId}/suspend` — **Flow:** "Suspend" action, e.g. after a fraud flag. Revokes all sessions immediately.
```json
{ "reason": "Multiple failed KYC attempts flagged by compliance" }
```
**Response `204`**.

**POST** `/v1/admin/users/{userId}/unsuspend` — **Flow:** "Reinstate" action. No payload. **Response `204`**.

**POST** `/v1/admin/users/{userId}/deactivate` — **Flow:** admin-initiated account closure (distinct from user-initiated `DELETE /me`). Revokes all sessions.
```json
{ "reason": "Requested by user via support ticket #4821" }
```
**Response `204`**.

**POST** `/v1/admin/users/{userId}/kyc/review` — **Flow:** KYC review queue action.
```json
{ "decision": "verified", "note": "ID and selfie match" }
```
**Response `200`**
```json
{ "success": true, "data": { "kycStatus": "verified" } }
```

### 14.3 Reps — *userManagement* (unless noted)

**GET** `/v1/admin/reps` — **Flow:** Reps table — active reps plus pending applicants in one list. **Query:** `q`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "usr_7q1m9z2p", "name": "Tunde Okafor", "departmentIds": ["spc_9f3k2j1"], "status": "active", "verification": "verified", "heldAmount": 18500000, "uncollectedAmount": 17250000, "collectionRate": 0.6 }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 62, "totalPages": 4 }
}
```

**GET** `/v1/admin/reps/applications` — **Flow:** Rep-application review queue, `pending` by default. **Query:** `status` (`pending` default, `approved`, `rejected`), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "userId": "usr_7q1m9z2p",
      "applicant": { "id": "usr_7q1m9z2p", "name": "Tunde Okafor", "email": "tunde@unilag.edu.ng", "matricNo": "190802044", "level": "300" },
      "status": "pending",
      "requestedSpace": { "name": "Economics Student Association", "short": "ESA", "kind": "association", "school": "University of Lagos", "faculty": "Social Sciences", "theme": "ocean" },
      "coRepInvites": ["cofounder@example.com"],
      "referralCode": null,
      "submittedAt": "2026-07-14T08:00:00.000Z",
      "reviewedAt": null,
      "reviewNote": null
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

**GET** `/v1/admin/reps/{repId}/application` — **Flow:** single-application detail view before approving/rejecting. **Response `200`** — same shape as one row above. `404` if the user never applied.

**POST** `/v1/admin/reps/{repId}/verify` — **Flow:** the rep-approval keystone. Creates the space, promotes the user to `rep`, links any referral, and emails the applicant — all in one transaction.
```json
{ "note": "Confirmed with department secretary" }
```
**Response `200`** — same shape as a `GET /admin/reps` row, `status: "active"`, `verification: "verified"`. `409 NOT_PENDING` if there's no pending application.

**POST** `/v1/admin/reps/{repId}/reject` — **Flow:** rejects the application; the account stays a plain student. Emails the applicant with the reason.
```json
{ "reason": "Space name conflicts with an existing department" }
```
**Response `204`**.

**POST** `/v1/admin/reps/{repId}/suspend` — same payload/response shape as user suspend, scoped to reps.
**POST** `/v1/admin/reps/{repId}/reinstate` — no payload, `204`.

**POST** `/v1/admin/reps/{repId}/freeze-payouts` — *payouts* permission. **Flow:** freezes payouts for every space this rep leads, e.g. during a compliance investigation.
```json
{ "reason": "Pending dispute investigation" }
```
**Response `204`**.

**POST** `/v1/admin/reps/{repId}/unfreeze-payouts` — *payouts* permission. No payload. **Response `204`**.

### 14.4 Spaces — *userManagement*

**GET** `/v1/admin/spaces` — **Flow:** Spaces table. **Query:** `type` (space kind), `school`, `q`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "spc_9f3k2j1", "name": "Engineering 101", "short": "ENG101", "kind": "department", "school": "University of Lagos", "memberCount": 84, "duesTarget": 43260000, "collectedAmount": 25750000, "assignedRepIds": ["usr_7q1m9z2p"], "isArchived": false, "payoutsFrozen": false }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 58, "totalPages": 3 }
}
```

**POST** `/v1/admin/spaces` — **Flow:** admin-created space (bypasses the rep-application flow entirely — used to pre-provision a department before assigning a rep to it).
```json
{ "name": "Engineering 101", "short": "ENG101", "kind": "department", "school": "University of Lagos", "faculty": "Engineering" }
```
**Response `201`**
```json
{ "success": true, "data": { "id": "spc_9f3k2j1", "name": "Engineering 101", "short": "ENG101", "kind": "department", "school": "University of Lagos", "joinCode": "ENG101-7F2K" } }
```
Auto-generates a join code.

**PATCH** `/v1/admin/spaces/{spaceId}` — same fields, all optional (at least one required).
```json
{ "faculty": "College of Engineering" }
```
**Response `200`**
```json
{ "success": true, "data": { "id": "spc_9f3k2j1", "name": "Engineering 101", "short": "ENG101", "kind": "department", "school": "University of Lagos", "faculty": "College of Engineering" } }
```

**POST** `/v1/admin/spaces/{spaceId}/assign-rep` — **Flow:** attach a rep to an admin-created space. Promotes the target user to `rep` if they aren't already one.
```json
{ "userId": "usr_7q1m9z2p", "role": "lead" }
```
**Response `201`**
```json
{ "success": true, "data": { "userId": "usr_7q1m9z2p", "spaceId": "spc_9f3k2j1", "role": "lead" } }
```

**POST** `/v1/admin/spaces/{spaceId}/archive`
```json
{ "reason": "Duplicate of an existing department" }
```
**Response `204`**.

### 14.5 Transactions Oversight — *userManagement* (refunds need *overrides*)

**GET** `/v1/admin/transactions` — **Flow:** platform-wide transaction search/audit table. **Query:** `type` (`deposit` | `dues_payment` | `payout` | `refund`), `status`, `spaceId`, `userId`, `from`, `to`, `q`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "txn_44df", "type": "dues_payment", "title": "Dept levy", "detail": "Engineering 101", "amount": -515000, "method": "Wallet", "status": "completed", "reference": "DVY-4821-7735", "createdAt": "2026-07-10T08:30:00.000Z", "refundOfTxnId": null, "userName": "Aisha Bello", "userEmail": "aisha@example.com", "spaceName": "Engineering 101" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 12500, "totalPages": 625 }
}
```
`status` shows as `"refunded"` when fully refunded regardless of the underlying transaction's stored status.

**POST** `/v1/admin/transactions/{txnId}/refund` — *overrides* permission. **Flow:** "Issue refund" action from a transaction row, e.g. resolving a dispute. Credits the user's wallet.
```json
{ "amount": 515000, "reason": "Duplicate charge confirmed by dispute #dsp_9k1m2x" }
```
(`amount` optional — omit to refund the remaining refundable balance in full)

**Response `201`**
```json
{ "success": true, "data": { "id": "txn_99zz", "type": "refund", "title": "Refund", "detail": "Duplicate charge confirmed by dispute #dsp_9k1m2x", "amount": 515000, "method": "Wallet", "status": "completed", "reference": "DVY-7712-4401", "createdAt": "2026-07-15T11:00:00.000Z" } }
```
`409 NOT_REFUNDABLE` / `409 ALREADY_REFUNDED` as applicable.

### 14.6 Disputes — *disputes*

**GET** `/v1/admin/disputes` — **Flow:** disputes queue. **Query:** `status`, `type`, `q`, `page`, `perPage`. **Response `200`** — array of the same shape as §12 File Dispute's response, paginated.

**POST** `/v1/admin/disputes/{id}/claim` — **Flow:** "Claim" button — assigns the dispute to the calling admin so others know it's being worked. No payload.
**Response `200`** — updated dispute, `status: "under_review"`. `409 DISPUTE_RESOLVED` if already resolved.

**POST** `/v1/admin/disputes/{id}/resolve` — *overrides* permission. **Flow:** "Resolve" action after investigation. Notifies the student who opened it.
```json
{ "resolution": "upheld", "note": "Confirmed duplicate charge; refund issued", "refundTxnId": "txn_99zz" }
```
**Response `200`** — updated dispute, `status: "resolved"`.

### 14.7 Polls Oversight

**GET** `/v1/admin/polls` — no extra permission beyond `admin`. **Flow:** platform-wide polls list for moderation. **Query:** `status`, `q`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "pol_9k2m1x", "title": "Best Dressed", "status": "active", "space": "Engineering 101", "paid": true, "totalVotes": 42, "revenue": 840000, "deadline": "2026-08-01T23:59:59.000Z", "createdAt": "2026-07-01T09:00:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 1, "totalPages": 1 }
}
```

**POST** `/v1/admin/polls/{pollId}/close` — *overrides* permission. **Flow:** force-close any poll regardless of owner, e.g. for policy violations.
```json
{ "reason": "Nominee names violate community guidelines" }
```
**Response `204`**.

### 14.8 Referral Integrity — *userManagement* (resolving flags needs *overrides*)

**GET** `/v1/admin/referrals/summaries` — **Flow:** per-referrer rollup for spotting abuse patterns. **Query:** `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "userId": "usr_7q1m9z2p", "userName": "Tunde Okafor", "email": "tunde@unilag.edu.ng", "invited": 12, "joined": 2, "earned": 200000, "riskTier": "high" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 40, "totalPages": 2 }
}
```
`riskTier` is a heuristic (high invite volume with a low join-through rate looks riskier).

**GET** `/v1/admin/referrals/flags` — **Flow:** flagged-referral review queue. **Query:** `status` (`pending` | `paid` | `voided` | `clawed_back`), `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "flg_1", "referrer": "Tunde Okafor", "referred": "Fake Student", "label": "Suspicious signup pattern", "description": "5 referrals from the same device fingerprint within 1 hour", "amount": 100000, "status": "pending", "date": "2026-07-12T09:00:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 3, "totalPages": 1 }
}
```

**POST** `/v1/admin/referrals/flags/{flagId}/resolve` — *overrides* permission. **Flow:** "Approve" pays the reward out normally, "Void" cancels it without penalty, "Claw back" reverses an already-paid reward.
```json
{ "action": "void", "note": "Confirmed device-fingerprint fraud" }
```
**Response `200`**
```json
{ "success": true, "data": { "id": "flg_1", "status": "voided" } }
```

### 14.9 Audit Logs & Roles

**GET** `/v1/admin/audit-logs` — no extra permission required. **Flow:** compliance/security audit trail of every admin action. **Query:** `severity`, `actorId`, `from`, `to`, `page`, `perPage`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "id": "aud_1", "actor": "Chidi Okeke", "role": "admin", "action": "rep.verify", "target": "usr_7q1m9z2p", "ip": "102.89.10.5", "device": "Chrome on macOS", "severity": "info", "createdAt": "2026-07-14T10:00:00.000Z" }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 940, "totalPages": 47 }
}
```

**GET** `/v1/admin/roles` — no extra permission required. **Flow:** roles-management screen — shows how many admins hold each sub-role and their current permission grants.

**Response `200`**
```json
{
  "success": true,
  "data": [
    { "role": "super_admin", "userCount": 2, "permissions": { "userManagement": true, "payouts": true, "disputes": true, "overrides": true } },
    { "role": "compliance_officer", "userCount": 3, "permissions": { "userManagement": true, "payouts": false, "disputes": true, "overrides": false } },
    { "role": "support_lead", "userCount": 5, "permissions": { "userManagement": true, "payouts": false, "disputes": true, "overrides": false } }
  ]
}
```

**PUT** `/v1/admin/roles/{role}` — **`super_admin` only.** **Flow:** bulk-updates permissions for every admin currently holding that sub-role at once.
```json
{ "userManagement": true, "payouts": false, "disputes": true, "overrides": false }
```
(all 4 booleans required)

**Response `200`**
```json
{ "success": true, "data": { "role": "compliance_officer", "permissions": { "userManagement": true, "payouts": false, "disputes": true, "overrides": false } } }
```

### 14.10 Reports — *userManagement*

**POST** `/v1/admin/reports` — **Flow:** "Generate report" form. Generation is on-demand at download time, not async — the `202` comes back immediately with `status: "ready"` and a `downloadUrl` you can call right away.
```json
{ "scope": "financial_summary", "format": "csv", "from": "2026-01-01", "to": "2026-06-01", "spaceId": "optional — scopes space_collection to one space" }
```
`scope` ∈ `financial_summary` | `space_collection` | `rep_performance` | `full_ledger`. `format` ∈ `csv` | `pdf`.

**Response `202`**
```json
{
  "success": true,
  "data": {
    "id": "rpt_1",
    "name": "financial_summary (2026-01-01 – 2026-06-01)",
    "scope": "financial_summary",
    "format": "csv",
    "status": "ready",
    "generatedAt": "2026-07-15T11:15:00.000Z",
    "fileSize": null,
    "downloadUrl": "https://api.duevy.com/v1/admin/reports/rpt_1/download",
    "createdAt": "2026-07-15T11:15:00.000Z"
  }
}
```

**GET** `/v1/admin/reports` — **Flow:** previously generated reports list. **Query:** `page`, `perPage`. **Response `200`** — array of the same shape as above, paginated.

**GET** `/v1/admin/reports/{id}/download` — **Flow:** the actual file download, triggered from a report row's "Download" button. Streams the CSV or PDF file (`Content-Disposition: attachment`). Links expire 7 days after generation (`409 REPORT_EXPIRED`).

---

## 15. Reference Data

### Categories
- **Space Kind:** `department`, `association`, `faculty`, `club`.
- **Due Category:** `levy`, `dinner`, `handout`, `welfare`, `sport`.
- **Transaction Type:** `due`, `topup`, `referral`, `withdrawal`, `refund`, `vote`, `card_verification`.
- **Space Hue:** `emerald`, `indigo`, `amber`, `rose`, `slate`.
- **Space Theme:** `emerald`, `ocean`, `royal`, `crimson`, `tangerine`.
- **Notification Kind:** `due_reminder`, `payment_received`, `join_request`, `payout_completed`, `poll_milestone`, `referral_earned`, `system`.
- **Notification Tone:** `brand`, `amber`, `rose`.
- **Dispute Type:** `payment_not_reflecting`, `non_remittance`, `refund_request`.
- **KYC Status:** `unverified`, `pending`, `verified`, `rejected`.
- **Admin Sub-Role:** `super_admin`, `compliance_officer`, `support_lead`.
- **Report Scope:** `financial_summary`, `space_collection`, `rep_performance`, `full_ledger`.

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
- `ALREADY_REP` / `LAST_LEAD_REP` / `NOT_A_REP` / `ALREADY_LEAD` / `USER_NOT_FOUND`: Circle-management conflicts.
- `NO_PAYOUT_ACCOUNT` / `ACCOUNT_COOLDOWN` / `ACCOUNT_UNVERIFIABLE` / `PAYOUTS_FROZEN` / `INSUFFICIENT_PAYOUT_BALANCE`: Payout conflicts.
- `POLL_CLOSED` / `POLL_STRUCTURE_LOCKED` / `ALREADY_VOTED` / `INVALID_TRANSITION`: Poll/due lifecycle conflicts.
- `NOT_REFUNDABLE` / `ALREADY_REFUNDED`: Admin refund conflicts.
- `NOT_PENDING` / `NO_APPLICATION` / `DISPUTE_RESOLVED`: Admin review-queue conflicts.
- `WALLET_NOT_EMPTY` / `ACTIVE_REP_OBLIGATIONS`: Account-deletion blockers.
- `ONLY_DRAFTS_DELETABLE`: A published due can be closed but not deleted.
- `REMINDER_COOLDOWN`: Due reminders are rate-limited to once per 24h.
- `REPORT_EXPIRED`: Admin report download link is past its 7-day expiry.
- `FIELD_READ_ONLY`: Attempted to edit a server-controlled field via `PATCH /me`.
- `EMAIL_IN_USE`: New email on `PATCH /me` is already registered to another account.
- `NOT_IMPLEMENTED`: Feature not configured server-side (e.g. Google sign-in).
- `PROVIDER_ERROR`: An upstream provider (e.g. Monnify bank list) failed.
- `UNAUTHENTICATED` / `TOKEN_EXPIRED` / `FORBIDDEN` / `NOT_FOUND` / `INTERNAL_ERROR`: Generic envelope errors.

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
  amount: number; // Face amount the rep set
  processingFee: number; // 3% fee added on top
  payableAmount: number; // amount + processingFee
  status: 'unpaid' | 'paid' | 'overdue';
  dueDate: string; // YYYY-MM-DD
  paidAt: string | null;
  reference: string | null;
}

interface RepDue {
  id: string;
  title: string;
  amount: number;
  status: 'draft' | 'active' | 'closed';
  paidCount: number;
  memberCount: number;
  dueDate: string;
  allowGuests: boolean;
}

interface Space {
  id: string;
  name: string;
  short: string;
  kind: 'department' | 'association' | 'faculty' | 'club';
  hue: 'emerald' | 'indigo' | 'amber' | 'rose' | 'slate';
  school: string;
  faculty: string | null;
  theme: 'emerald' | 'ocean' | 'royal' | 'crimson' | 'tangerine';
  memberCount: number;
  membership?: 'member' | 'guest' | 'rep';
}

interface Poll {
  id: string;
  spaceId: string;
  title: string;
  description: string | null;
  deadline: string; // YYYY-MM-DD
  status: 'draft' | 'active' | 'closed';
  membersOnly: boolean;
  paid: boolean;
  amountPerVote: number;
  slug: string;
  totalVotes: number;
  revenue?: number; // rep/admin views only
  categories: Array<{
    id: string;
    title: string;
    imageUrl: string | null;
    nominees: Array<{ id: string; name: string; imageUrl: string | null; votes?: number }>;
    remaining?: number | null; // voter view only
  }>;
}

interface Notification {
  id: string;
  kind: 'due_reminder' | 'payment_received' | 'join_request' | 'payout_completed' | 'poll_milestone' | 'referral_earned' | 'system';
  tone: 'brand' | 'amber' | 'rose';
  title: string;
  detail: string;
  href: string | null;
  read: boolean;
  createdAt: string;
}

interface Transaction {
  id: string;
  type: 'due' | 'topup' | 'referral' | 'withdrawal' | 'refund' | 'vote' | 'card_verification';
  title: string;
  detail: string | null;
  amount: number; // Positive = IN, Negative = OUT
  method: string;
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
  account: string; // e.g. "Guaranty Trust Bank 01234•••••"
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
  email: string;
  department: string | null;
  status: 'open' | 'under_review' | 'resolved';
  slaDays: number;
  ageDays: number;
  breached: boolean;
  txnReference: string | null;
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
- **Redirect flows:** `checkoutUrl` responses (due/top-up/poll `method: "online"`, and `POST /wallet/cards`) all follow the same pattern — redirect the browser there, then poll `GET /payments/{reference}/status` on return until it's no longer `pending`.
- **204 responses:** Many mutating endpoints (suspend, archive, remove-member, mark-read, delete-card, etc.) return `204 No Content` on success — don't expect a `data` body.
- **Idempotency:** Always send a fresh `Idempotency-Key` (UUID) per user action, not per retry — retries of the same logical request should reuse the same key so the server can dedupe.
- **Pagination:** List endpoints accept `page` and `perPage` query params and return `meta.total` / `meta.totalPages`; endpoints without explicit pagination notes above still accept these params.
