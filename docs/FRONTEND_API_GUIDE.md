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

### Authentication
- **Access Token:** Send in the header: `Authorization: Bearer <token>`.
- **Refresh Token:** Handled automatically via HTTP-Only cookie. Use `/v1/auth/refresh` to rotate.

### Headers
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>`: **Required** for all payment/wallet state-changing requests.

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
  "role": "student"
}
```

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
  "space": {
    "name": "Economics Student Association",
    "short": "ESA",
    "kind": "association",
    "school": "University of Lagos",
    "faculty": "Social Sciences",
    "theme": "ocean"
  }
}
```
*Note: Returns 403 `REP_APPROVAL_PENDING` until admin approval.*

### Login
**POST** `/v1/auth/login`
**Payload:** `{ "email": "john@example.com", "password": "..." }`

### Google Sign-In
**POST** `/v1/auth/google`
**Payload:**
```json
{
  "idToken": "<Google ID token from the OAuth flow>",
  "matricNo": "190802044",
  "role": "student"
}
```
*`matricNo` is only required the first time an account is created this way. `role`/`space` follow the same shape as register when signing up as a rep. Returns `501 NOT_IMPLEMENTED` if Google sign-in isn't configured server-side.*

---

## 3. Student Dashboard & Dues

### Get Overview
**GET** `/v1/me/overview`
Returns balance, outstanding count, and top 4 open dues.

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

### Download Receipt
**GET** `/v1/dues/{dueId}/receipt` (also `/v1/transactions/{transactionId}/receipt`)
Returns a PDF (`Content-Type: application/pdf`) for a settled payment.

---

## 4. Wallet & Cards

### Top-Up (Online - Monnify)
**POST** `/v1/wallet/top-up`
**Payload:** `{ "amount": 100000, "method": "online" }`

### Top-Up (Saved Card)
**POST** `/v1/wallet/top-up`
**Payload:** `{ "amount": 100000, "method": "card", "cardId": "..." }`

### List Saved Cards
**GET** `/v1/wallet/cards`

### Save a Card
**POST** `/v1/wallet/cards`
**Payload:** `{ "providerToken": "...", "brand": "Visa", "last4": "4242", "expiry": "12/28" }`
`providerToken` comes from the PSP's inline tokenization SDK — raw card numbers never touch this API.

---

## 5. Spaces (Departments)

### Lookup Code
**POST** `/v1/spaces/lookup`
**Payload:** `{ "code": "ENG101" }`
Returns space details before joining.

### Join Space
**POST** `/v1/spaces/{spaceId}/join`
**Payload:** `{ "code": "ENG101", "as": "member" }`
Joining is immediate for anyone with a valid code — reps do not approve or gate admission.

---

## 6. Rep Management

### Rep Dashboard
**GET** `/v1/spaces/{spaceId}/overview`
Returns collection stats and active dues list.

### Create Due
**POST** `/v1/spaces/{spaceId}/dues`
**Payload:** `{ "title": "Dinner", "amount": 500000, "dueDate": "2024-05-20", "category": "dinner", "publish": true }`

---

## 7. Payouts (Rep Only)

### List Banks
**GET** `/v1/banks`
Returns `[{ "code": "058", "name": "Guaranty Trust Bank" }, ...]` — the full Monnify-supported
bank list, for populating the bank picker on the payout-account form. Cached server-side for 24h.

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
input, only ever server-resolved.

### Request Payout
**POST** `/v1/spaces/{spaceId}/payout/request`
**Payload:** `{ "amount": 1000000, "note": "Venue payment" }`
Returns a `Payout` with `status: "processing"`. The transfer is initiated automatically and the
payout moves to `completed` or `failed` once the payment provider confirms — poll
`GET /v1/spaces/{spaceId}/payouts` or listen for the `payout_completed` notification.

---

## 8. Polls & Voting

### Get Poll (Public)
**GET** `/v1/polls/{slug}`

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

---

## 9. Disputes & Notifications

### File Dispute
**POST** `/v1/disputes`
**Payload:** `{ "type": "payment_not_reflecting", "transactionReference": "...", "description": "..." }`

### Notifications
**GET** `/v1/notifications`
Returns paginated alerts + `unreadCount` in `meta`.

---

## 10. Reference Data

### Categories
- **Space Kind:** `department`, `association`, `faculty`, `club`.
- **Due Category:** `levy`, `dinner`, `handout`, `welfare`, `sport`.
- **Transaction Type:** `due`, `topup`, `referral`, `withdrawal`, `refund`, `vote`.

### Common Error Codes
- `VALIDATION_ERROR`: Request body failed schema check.
- `INSUFFICIENT_FUNDS`: Wallet balance too low.
- `CARD_DECLINED`: Saved-card charge was rejected by the payment provider.
- `REP_APPROVAL_PENDING`: Rep registered but not yet approved by admin.
- `DUE_ALREADY_PAID`: Duplicate payment attempt.

---

## 11. TypeScript Interfaces

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  role: 'student' | 'rep' | 'admin';
  walletBalance: number; // Kobo
  spaces: Array<{ id: string; name: string; membership: 'member' | 'rep' }>;
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

---

## 12. Useful Tips
- **Kobo:** All `amount` fields are in Kobo. (₦1 = 100 Kobo).
- **Themes:** Use the `hue` field from a Space to apply primary colors to the UI.
- **Fees:** The API automatically adds a 3% processing fee to the `payableAmount` of any due.
