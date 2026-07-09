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
    "theme": "ocean",
    "requireApproval": false
  }
}
```
*Note: Returns 403 `REP_APPROVAL_PENDING` until admin approval.*

### Login
**POST** `/v1/auth/login`
**Payload:** `{ "email": "john@example.com", "password": "..." }`

---

## 3. Student Dashboard & Dues

### Get Overview
**GET** `/v1/me/overview`
Returns balance, outstanding count, and top 4 open dues.

### Pay a Due (Wallet)
**POST** `/v1/dues/{dueId}/pay`
**Payload:** `{ "method": "wallet" }`

### Pay a Due (Online - Monnify)
**POST** `/v1/dues/{dueId}/pay`
**Payload:** `{ "method": "online" }`
Returns `checkoutUrl` and `reference`. Use `GET /v1/payments/{reference}/status` to poll for completion.

---

## 4. Wallet & Cards

### Top-Up
**POST** `/v1/wallet/top-up`
**Payload:** `{ "amount": 100000, "method": "online" }`

### List Saved Cards
**GET** `/v1/wallet/cards`

---

## 5. Spaces (Departments)

### Lookup Code
**POST** `/v1/spaces/lookup`
**Payload:** `{ "code": "ENG101" }`
Returns space details before joining.

### Join Space
**POST** `/v1/spaces/{spaceId}/join`
**Payload:** `{ "code": "ENG101", "as": "member" }`

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

### Request Payout
**POST** `/v1/spaces/{spaceId}/payout/request`
**Payload:** `{ "amount": 1000000, "note": "Venue payment" }`

---

## 8. Polls & Voting

### Get Poll (Public)
**GET** `/v1/polls/{slug}`

### Cast Vote
**POST** `/v1/polls/{slug}/votes`
**Payload:**
```json
{
  "selections": [{ "categoryId": "...", "nomineeId": "...", "quantity": 1 }],
  "method": "wallet"
}
```

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
  tone: 'info' | 'amber' | 'green' | 'red';
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
