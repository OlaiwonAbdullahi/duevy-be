# Duevy — Product Requirements Document

**MVP — Rep onboarding, spaces, and dues collection on Anchor**

| Field | Value |
|---|---|
| Product | Duevy — "Pay your dues. Simply." |
| Entity | Duevy Labs Ltd |
| Document | MVP PRD v1.0 (draft) |
| Author | Abdullahi Olaiwon |
| Date | 3 September 2026 |
| Status | Draft for build |
| Payment rail | Anchor (getanchor.co) — BaaS Standard pricing |
| Pilot | LAUTECH, single department cohort |

---

## Contents

1. [Summary](#1-summary) — goals, and what is deliberately out of scope
2. [Roles and permissions](#2-roles-and-permissions)
3. [Rep onboarding](#3-rep-onboarding) — registration, admin approval, KYC banner, Anchor TIER_2
4. [The space](#4-the-space) — space code, dues, members
5. [Student flow](#5-student-flow) — signup, joining, multi-due checkout
6. [Anchor integration](#6-anchor-integration) — objects, provisioning, collections, webhooks, payouts
7. [Money flow and unit economics](#7-money-flow-and-unit-economics)
8. [Data model](#8-data-model)
9. [Edge cases and failure handling](#9-edge-cases-and-failure-handling)
10. [Non-functional requirements](#10-non-functional-requirements)
11. [Success metrics for the pilot](#11-success-metrics-for-the-pilot)
12. [Build order](#12-build-order)
13. [Open questions](#13-open-questions)

---

## 1. Summary

Duevy lets a course rep collect departmental dues from students online, and lets students pay several dues at once without a bank-transfer-and-screenshot loop. This document covers the MVP only: the smallest build that can take real money from a real student at LAUTECH and land it in a rep's bank account.

The MVP has exactly three actors and one money path. A rep registers and is approved by the platform admin. The rep completes KYC with Anchor, which provisions the space's bank account. Students join the space with a code, select the dues they owe, and pay in one transaction. The rep withdraws the balance to their own bank account.

> **THE ONE-LINE TEST FOR MVP SCOPE**
>
> If a feature is not required for a student to pay a due and a rep to receive that money, it is not in the MVP.

### 1.1 Goals

- Ship a live, real-money collection flow for one department at LAUTECH.
- Prove the Anchor integration end to end: customer creation, KYC, deposit account, virtual account collection, payout, webhooks.
- Prove the fee model works at real ticket sizes (see §7).
- Keep the rep's manual work to: create dues, share a code, withdraw.

### 1.2 Non-goals

These are deliberately deferred. They are not "phase 2 maybe" — they are out of this build entirely, and no schema or UI should be added for them now.

| Deferred | Why it is out |
|---|---|
| Polls and paid voting | Revenue-adjacent, not required for the core loop. |
| Saved cards / card storage | Adds PCI surface and a second payment method. Bank transfer to a virtual account is enough. |
| Student wallet / balance | Holding student float multiplies compliance load. Money moves student → space account directly. |
| Co-rep team and approval quorum | One rep per space in MVP. No payout approvals. |
| Referral programme | Growth feature, no place in a single-department pilot. |
| "Ask Duey" AI assistant, chatbot, receipt parsing | Nice-to-have layered on a working core. |
| WhatsApp channel | Email notifications only in MVP. |
| Installments / split payments / lending | Changes the ledger model. Later phase. |
| Multi-school onboarding, public API | Schema stays multi-school-ready; no UI or flow for it. |
| Refunds (self-service) | Handled manually by the platform admin in MVP (see §9.4). |

---

## 2. Roles and permissions

Three roles. No sub-roles, no per-permission toggles.

| Role | Who | Can do |
|---|---|---|
| Platform admin | You (Duevy Labs) | Approve or reject rep registrations; view all spaces, dues, payments and payouts; suspend a space; trigger a manual refund; view the Anchor reconciliation view. |
| Rep | Course rep / class governor | Create one space; create and close dues; view members; view collections; withdraw the space balance to their own bank account; remove a member. |
| Student | Any student with a space code | Join a space; see the dues that apply to them; select several and pay; view and download receipts; leave a space. |

> **ACCESS MODEL**
>
> Both reps and students land on `/dashboard`. What the dashboard renders is decided by the account's role, not by a separate URL tree.
>
> The platform admin console lives at `/admin` and is a separate surface.
>
> A single email address is one account with one role. Role switching is not in the MVP.

---

## 3. Rep onboarding

This is the flow with the most states in the MVP, and the one that gates everything else. A space cannot receive a naira until the rep behind it is a KYC-verified Anchor customer.

### 3.1 Registration

1. Rep opens `/register` and picks "I'm a course rep".
2. Fills: full name, email, phone number, school (LAUTECH, fixed in MVP), faculty, department, level/set, and the name they want for the space.
3. Verifies their email with a 6-digit code. Unverified emails never reach the approval queue.
4. Account is created with status `pending_approval`. Rep sees a holding screen: "We're reviewing your request — we'll email you within 24 hours."
5. Platform admin receives an email and sees the request in `/admin/reps`.

> **WHY ADMIN APPROVAL EXISTS AT ALL**
>
> Anyone can claim to be the course rep for Computer Science 400 level. Approval is the only defence against a stranger collecting a department's money.
>
> In MVP the check is manual and offline: the admin confirms the person is the real rep (WhatsApp, a department group, a lecturer). The console just records the decision and a note.

### 3.2 Admin approval

The admin sees the submitted details plus a free-text note field, and picks one of two actions.

| Action | Result |
|---|---|
| Approve | Rep status → `approved`. Email sent: "You're in — finish setup to start collecting." Rep can now sign in to the dashboard. |
| Reject | Rep status → `rejected`, with a reason. Email sent. The account cannot sign in; the rep may re-register after 7 days. |

*Every decision writes to an audit log: admin id, rep id, action, reason, timestamp.*

### 3.3 First dashboard — the KYC banner

An approved rep lands on the dashboard immediately. The dashboard is not blank and not locked: the rep can look around, create the space profile, and draft dues. What they cannot do is take money.

> **BANNER COPY (persistent, top of every rep page)**
>
> "Verify your identity to start collecting. Your space can't receive payments until this is done. It takes about 2 minutes — you'll need your BVN." **[Verify now]**

**What is unlocked before KYC**

- **Available:** create the space, set its name, description and cover; create dues as drafts; copy the space code; invite students; browse the dashboard.
- **Blocked:** publishing a due, generating an account number, any student payment, any withdrawal. Every blocked action shows the same modal pointing at KYC.

Students who join a pre-KYC space see the space and its draft dues marked "Not open yet". This is intentional: the rep can seed the space and get students in while verification is pending.

### 3.4 KYC — Anchor TIER_2

MVP verifies reps at Anchor's BVN-validated tier. It is automatic, resolves by webhook in seconds, and costs ₦50 per verification against Anchor's published rate card.

> **THE TIER IS CALLED `TIER_2` IN THE API, NOT `TIER_1`**
>
> Anchor's prose docs describe this level as "Tier 1", but the verification endpoint's `level` enum accepts only `TIER_2` and `TIER_3`, and the BVN payload goes in a `level2` object. The fee-type enum (`KYC_TIER_2` / `KYC_TIER_3`) confirms the priced "Individual KYC Tier 2 — ₦50" is this level.
>
> Submitting `TIER_1` is rejected. This resolves open question 1.

| Collected at KYC | Notes |
|---|---|
| BVN (11 digits) | The name and phone number on the BVN must match the name and phone number the customer was created with at Anchor. Mismatch is the single most common rejection cause. |
| Date of birth | `YYYY-MM-DD`. |
| Gender | As recorded against the BVN. |
| Bank account for payouts | Account number + bank. Resolved and name-matched before it is saved (see §6.5). |

Verification is asynchronous. The rep submits, sees a "Verifying…" state, and Duevy waits for the Anchor webhook.

| Webhook event | Duevy does |
|---|---|
| `customer.identification.approved` | Rep status → `verified`. Create the deposit account and the space's virtual account. Banner is replaced with "You're verified — your space can now collect." Drafted dues become publishable. |
| `customer.identification.rejected` | Rep status → `kyc_failed`. Banner turns amber with the rejection reason and a "Fix and retry" action. Rep can resubmit; each attempt is a fresh Anchor call and a fresh ₦50. |
| `customer.identification.error` | Transient. Retry with backoff (3 attempts, 1/5/30 minutes). Rep sees "Still verifying" and is not asked to do anything. |

> ⚠️ **SUPERSEDED IN PART — SEE OPEN QUESTION 3**
>
> Collection is no longer bounded by these limits: students pay into Duevy's
> settlement account, which Anchor confirmed is unlimited, so **Consequence 1
> below is void** and a due may be any amount. What may still bind is the
> balance the rep's own account can hold, which is unconfirmed.
>
> ⚠️ **TIER 2 LIMITS — THIS CONSTRAINS THE PRODUCT, NOT JUST COMPLIANCE**
>
> TIER_2: maximum single deposit ₦50,000; maximum cumulative balance ₦300,000.
>
> **Consequence 1:** a single due priced above ₦50,000 cannot be paid in one inflow. MVP caps a single due at ₦50,000 and caps a single checkout at ₦50,000 — a student with more than that in selected dues pays in two goes.
>
> **Consequence 2:** a 300-student space collecting ₦5,000 each will hit the ₦300,000 balance ceiling long before it finishes. Duevy therefore nudges withdrawal at 70% of the ceiling and hard-warns at 90%: "Withdraw now — your space is close to its limit."
>
> Reps who repeatedly hit the ceiling are the trigger to add a Tier 2 upgrade path (deferred, see §12).

### 3.5 Rep state machine

| State | Entered when | Can collect? |
|---|---|:--:|
| `pending_approval` | Registration submitted, email verified | No |
| `rejected` | Admin rejects | No — cannot sign in |
| `approved` | Admin approves | No — KYC banner shown |
| `kyc_pending` | KYC submitted, awaiting webhook | No |
| `kyc_failed` | Anchor rejected the identification | No — retry offered |
| `verified` | Anchor approved; account provisioned | **Yes** |
| `suspended` | Admin suspends the space or the rep | No — payments refused, balance frozen |

---

## 4. The space

A space is one department cohort — "Computer Science, 2024/2025, 400 Level". One rep owns one space in the MVP. The space is the unit that has an account number, a balance, dues, and members.

### 4.1 Space code

- Six characters, uppercase alphanumeric, generated on space creation.
- Excludes visually ambiguous characters (`0`, `O`, `1`, `I`, `L`) — reps read these out loud in lecture halls.
- Unique across the platform; collision check on generation with retry.
- Rep can regenerate the code once per 24 hours. Regenerating does not remove existing members.
- Shareable as a code and as a join link, `/join/ABC234`, which pre-fills the code.

### 4.2 Dues

A due is one line item a student can owe. The rep creates them; there is no template library in the MVP.

| Field | Rules |
|---|---|
| Title | Required. E.g. "Departmental Due 2025/26". |
| Type | One of: `departmental_due`, `handout`, `exam_levy`, `lab_manual`, `association_due`, `departmental_wear`, `trip_fee`, `clearance`, `other`. |
| Amount | Required, fixed. ₦100 minimum, ₦49,019 maximum — the ceiling applies to what the student transfers, which is the due plus the 2% charge. No variable or "pay what you can" amounts in MVP. |
| Description | Optional, shown to students. |
| Deadline | Optional date. Past the deadline the due shows as overdue but is still payable — MVP does not auto-close. |
| Status | `draft` → `open` → `closed`. Only `open` dues are payable. Closing a due does not affect payments already made. |
| Mandatory flag | Optional. Mandatory dues are pre-selected in the student's checkout; the student can still deselect. |

*Dues apply to the whole space. Per-student or per-group assignment is not in the MVP.*

### 4.3 Members

- A student joins by code and is a member immediately — no rep approval step in the MVP.
- The rep sees the member list with name, matric number, email, total paid and outstanding.
- The rep can remove a member. Removal does not delete their payment history or receipts.
- A student can belong to more than one space (department + association), and the dashboard groups dues by space.

---

## 5. Student flow

### 5.1 Signup and joining

1. Student opens `/register`, picks "I'm a student", and enters full name, matric number, email, phone, and a password.
2. Verifies email with a 6-digit code.
3. Lands on an empty dashboard with one action: "Enter your space code".
4. Enters the code from the rep. Duevy shows a confirmation card — space name, department, rep name — before joining, so a mistyped code cannot silently drop them in the wrong space.
5. Joins. The dashboard now lists that space's open dues.

The matric number is collected for the rep's reconciliation, not for verification. There is no matric-number check against a school register, and no student KYC of any kind in the MVP — students are payers, not account holders.

### 5.2 Selecting and paying

1. The student sees every open due in the space as a checkbox row: title, amount, deadline, and a paid badge where relevant.
2. Mandatory dues are pre-ticked. The student ticks any others.
3. A sticky summary bar shows: selected dues subtotal, the 2% service charge, and the total to pay.
4. "Pay ₦X" opens the payment screen. Duevy requests a virtual account from Anchor for exactly this amount and shows: account number, bank name, account name, amount, and a countdown.
5. The student transfers from any bank app. The screen polls payment status live; no screenshot, no "I have paid" button.
6. On the inflow webhook, the payment is marked successful, every selected due is marked paid for that student, a PDF receipt is generated, and a confirmation email goes out.

> **DESIGN RULES FOR THE CHECKOUT**
>
> One transfer covers many dues. The student never pays four times for four dues.
>
> The amount shown is the exact amount to transfer, service charge included. Anything else breaks reconciliation.
>
> The virtual account is single-use and expires in 30 minutes. Expired accounts are not reused.
>
> Nothing is marked paid on the client. Only the Anchor webhook (or a status poll confirming it) can mark a payment successful.

### 5.3 After payment

- **Receipt:** PDF with reference, space, rep, itemised dues, service charge, total, timestamp. Downloadable from the dashboard indefinitely.
- Paid dues move to a "Paid" section and cannot be selected again.
- Email confirmation to the student; the rep gets a daily digest, not a per-payment email.

---

## 6. Anchor integration

Anchor is the only money rail in the MVP. Everything below maps to Anchor's documented API groups: customers, verification, deposit accounts, virtual accounts, money movement, and events.

### 6.1 Object mapping

| Duevy concept | Anchor object |
|---|---|
| Rep | Individual Customer (created at approval, before KYC) |
| Rep KYC | Individual verification, level `TIER_2` (BVN + DOB + gender) |
| Space account | Deposit account (savings), owned by the rep's customer record |
| Checkout | Pay With Transfer account (dynamic, single-use, amount-fixed, expiring) settling into **Duevy's** settlement account |
| Withdrawal | NIP transfer out to the rep's saved counterparty bank account |
| Duevy revenue | Whatever stays in the settlement account after `netToSpace` is remitted — no sweep |

### 6.2 Provisioning sequence

1. Admin approves rep → `POST` create Individual Customer (name, email, phone, address).
2. Rep submits KYC → `POST /api/v1/customers/{customerId}/verification/individual` with level `TIER_2`.
3. Await `customer.identification.approved`.
4. Create the deposit account against the verified customer.
5. Store account id, NUBAN and bank name against the space. The space is now live.

*Steps 4 and 5 are never triggered by the client. They run in a webhook handler, so a rep who closes the tab still ends up provisioned.*

### 6.3 Collections

- One Pay With Transfer account per checkout attempt (`POST /pay/pay-with-transfer`), fixed to the exact total and expiring in 30 minutes. **Anchor enforces both**, so a wrong amount cannot be sent and a late transfer cannot land.
- Funds settle into **Duevy's settlement account**, not the space's. `remitToSpaces()` then book-transfers `netToSpace` on to the rep — free, and the reason the rep receives the face value untouched.
- Anchor charges **0.5% capped at ₦500** on inflow, against the settlement account, so Duevy absorbs it.
- CBN stamp duty of ₦50 applies to transfers above ₦10,000 — it applies on both inflow and payout and is the single biggest threat to the margin (see §7).
- The `payin.received` webhook is the single source of truth for a successful payment.
- **`/pay/*` is production-only**, gated on a payment program, so none of this can be exercised in sandbox before KYB.

### 6.4 Webhooks

Duevy subscribes to, at minimum:

- `customer.identification.approved` / `.rejected` / `.error`
- `account.opened` / `accountNumber.created`
- `payin.received` — **registered separately**; it belongs to the Payments product, not the BaaS event enum
- `nip.transfer.successful` / `.failed` / `.reversed`
- `book.transfer.successful` / `.failed` — remittance outcomes

**Handler rules — non-negotiable**

| Rule | Implementation |
|---|---|
| Verify signature | Reject any payload failing Anchor's signature check. Never trust an unsigned webhook. |
| Idempotency | Persist every event by Anchor event id in a `webhook_events` table before processing. A repeated id is acknowledged and dropped. |
| Acknowledge fast | Return 200 immediately, process in a queued job. Anchor retries on non-200 and duplicate processing is worse than a slow job. |
| Never mark from the client | The frontend poll reads Duevy's own payment record. It never writes one. |
| Reconcile daily | A nightly job compares Duevy payment records against Anchor account statements and flags mismatches to `/admin`. |

### 6.5 Payouts

1. Rep opens Withdraw, sees the available balance, enters an amount.
2. Destination is the bank account saved at KYC. Changing it requires re-entering the password and a name match against the rep's verified name — this is the highest-risk action in the product.
3. Duevy charges a flat ₦100 withdrawal fee, deducted from the amount sent, plus ₦50 CBN stamp duty on withdrawals above ₦10,000. The fee breakdown is shown before the rep confirms (see §7.3).
4. Payout row is created as `processing` and resolved by the transfer webhook to `successful` or `failed`. A failed transfer returns the amount to the available balance and emails the rep.

- No approval quorum, no co-rep sign-off — one rep, one account, MVP.
- Minimum withdrawal ₦1,000. No maximum beyond the account balance.
- Withdrawals are blocked while a space is suspended.

### 6.6 Environments

- Build against the Anchor sandbox with test BVNs; every flow in this document must pass in sandbox before go-live.
- API keys are scoped and stored as server-side secrets. No Anchor key is ever exposed to the browser.
- Go-live requires Anchor's production approval for Duevy Labs Ltd as a business customer (KYB, ₦1,000).

---

## 7. Money flow and unit economics

### 7.1 The rule

Duevy charges on both ends, and both charges are visible to the person paying them. The student pays a percentage on collection; the rep pays a flat fee on withdrawal. Neither is hidden inside the due amount.

> **FEE MODEL**
>
> **Collection — the student pays:** due total + **2% service charge**. The 2% is *inclusive* of Anchor's 0.5% collection fee; Duevy does not stack Anchor's cut on top of it.
>
> The space receives the full face amount of every due. "Your ₦5,000 due stays ₦5,000" is the pitch to the rep, and it stays true.
>
> **Withdrawal — the rep pays:** **₦100 flat per payout** (₦50 to Anchor for the NIP transfer, ₦50 to Duevy), deducted from the amount sent.
>
> CBN stamp duty of ₦50 on any transfer above ₦10,000 is statutory and sits outside both charges — see §7.3.

### 7.2 Collection economics

Anchor charges 0.5% of the amount transferred, capped at ₦500, on inflow through a virtual NUBAN. That 0.5% is levied on what the student actually sends — the due plus the 2% — so the true cost is 0.51% of the due.

| Due total | 2% charge | Student pays | Anchor inflow | Stamp duty | Duevy net |
|---:|---:|---:|---:|:--:|---:|
| ₦2,000 | ₦40 | ₦2,040 | ₦10.20 | — | ₦29.80 |
| ₦5,000 | ₦100 | ₦5,100 | ₦25.50 | — | ₦74.50 |
| ₦20,000 | ₦400 | ₦20,400 | ₦102.00 | ₦50 | ₦248.00 |
| ₦50,000 | ₦1,000 | ₦51,000 | ₦255.00 | ₦50 | ₦695.00 |

Net margin on collection is **1.49% of the due** (2% less 0.51%), minus ₦50 stamp duty once a single checkout exceeds ₦10,000. The ₦500 inflow cap never binds at MVP ticket sizes — 0.5% only reaches ₦500 at ₦100,000, which is double the TIER_2 single-deposit limit.

> ⚠️ **STAMP DUTY IS THE SHARP EDGE IN THE COLLECTION MODEL**
>
> On a ₦20,000 checkout, ₦50 of stamp duty eats 12.5% of the ₦400 charge. On a ₦10,500 checkout it eats 24% of ₦210.
>
> Because the duty is a flat ₦50 that switches on at ₦10,000, margin per naira actually dips just above that threshold and recovers as the ticket grows.
>
> This is an argument for encouraging students to pay several dues in one checkout: one ₦20,000 payment pays the ₦50 duty once, where four ₦5,000 payments pay it zero times. Both are fine; two ₦10,500 payments are the bad case.

### 7.3 Withdrawal economics

The rep is charged ₦100 per withdrawal. Anchor takes ₦50 for the NIP transfer, leaving Duevy ₦50 — but on any withdrawal above ₦10,000 the CBN levies a further ₦50 in stamp duty, which is exactly the size of that margin.

| Withdrawal | Rep charged | Anchor NIP | Stamp duty | Duevy net |
|---|---:|---:|:--:|---:|
| ₦8,000 | ₦100 | ₦50 | — | ₦50 |
| ₦25,000 — pass through **(recommended)** | ₦150 | ₦50 | ₦50 | ₦50 |
| ₦25,000 — Duevy absorbs | ₦100 | ₦50 | ₦50 | ₦0 |

**Recommendation:** pass the duty through as a separate statutory line, so the rep sees "Duevy fee ₦100 + stamp duty ₦50". It is a government charge, reps already meet it on every bank transfer they make, and absorbing it means every meaningful withdrawal earns Duevy nothing. Whichever way this goes, the withdrawal screen must show the full breakdown and the exact amount that will land in the rep's account before they confirm.

*A rep withdrawing weekly costs Duevy nothing and earns ₦50 a time. A rep withdrawing daily to dodge the TIER_2 balance ceiling (§3.4) earns ₦350 a week — the ceiling and the payout fee push in the same direction, which is convenient but should not become a reason to leave the ceiling unsolved.*

### 7.4 What one space is worth

A realistic pilot space: 300 students, one ₦5,000 departmental due, the rep withdrawing four times over the semester.

| Line | Working | Amount |
|---|---:|---:|
| Collection margin | 300 × ₦74.50 | **₦22,350** |
| Withdrawal margin | 4 × ₦50 | **₦200** |
| Rep KYC (one-off) | 1 × ₦50 | **−₦50** |
| **Net from one space, one semester** | | **₦22,500** |

**A rep costs ₦50 to verify and repays that on their first ₦5,000 payment, or their second ₦2,000 one. That is the whole acquisition maths of the MVP.**

**Anchor prices that are not per-transaction**

| Item | Anchor price | Who absorbs it |
|---|---|---|
| Deposit account creation | ₦0.00 | — |
| Virtual account creation | ₦0.00 | — |
| Monthly account maintenance | ₦0.00 | — |
| Account statement | ₦0.00 | — |
| Individual KYC (BVN tier) | ₦50.00 | Duevy — acquisition cost, once per rep |
| Business KYB (Duevy Labs) | ₦1,000.00 | Duevy — one-off, at onboarding |
| Payout (NIP transfer) | ₦50.00 | Covered by the rep's ₦100 withdrawal fee |

---

## 8. Data model

PostgreSQL. Multi-school-ready columns stay in the schema even though only LAUTECH is onboarded, but no multi-school UI is built.

| Table | Key columns |
|---|---|
| `users` | id, role (`admin` / `rep` / `student`), full_name, email, email_verified_at, phone, password_hash, status, created_at |
| `students` | user_id, matric_number, school_id, level |
| `reps` | user_id, school_id, faculty, department, kyc_status, anchor_customer_id, kyc_submitted_at, kyc_resolved_at, rejection_reason |
| `schools` | id, name, slug, state |
| `spaces` | id, rep_user_id, school_id, name, description, code (unique), status, anchor_account_id, nuban, bank_name, created_at |
| `space_members` | space_id, student_user_id, joined_at, removed_at |
| `dues` | id, space_id, title, type, amount_kobo, description, deadline, is_mandatory, status (`draft` / `open` / `closed`), created_at |
| `payments` | id, reference, space_id, student_user_id, subtotal_kobo, service_charge_kobo, total_kobo, status (`pending` / `successful` / `failed` / `expired`), virtual_account_number, virtual_account_expires_at, anchor_payment_id, paid_at |
| `payment_lines` | payment_id, due_id, amount_kobo — the many-dues-one-payment join |
| `payouts` | id, space_id, amount_kobo, duevy_fee_kobo, anchor_fee_kobo, stamp_duty_kobo, net_sent_kobo, destination_bank, destination_account, status, anchor_transfer_id, requested_at, resolved_at |
| `webhook_events` | anchor_event_id (unique), type, payload, received_at, processed_at, status — the idempotency table |
| `audit_log` | actor_user_id, action, target_type, target_id, metadata, created_at |

> **MONEY STORAGE**
>
> Every amount is stored in **kobo as an integer**. No floats anywhere in the payment path.
>
> BVN is submitted to Anchor and **never persisted** in Duevy's database — not raw, not encrypted. Store only Anchor's customer id and the KYC status it returns.

---

## 9. Edge cases and failure handling

### 9.1 Payment

| Case | Behaviour |
|---|---|
| Student transfers less than the amount | Payment stays `pending`. Underpayment is flagged to `/admin` for manual resolution; the student sees "We received ₦X of ₦Y — contact support". No dues are marked paid. |
| Student transfers more | Dues are marked paid; the excess is flagged to `/admin` for manual refund. Not automated in MVP. |
| Student pays after the virtual account expires | Anchor still credits the space. The inflow is flagged as unmatched in `/admin` and reconciled manually against the reference. |
| Duplicate transfer to the same virtual account | Second inflow is unmatched and flagged for refund. Single-use accounts make this rare. |
| Due closed while a checkout is open | The payment completes and is honoured. Closing never invalidates an in-flight payment. |
| Two students, same matric number | Allowed to pay; both flagged in the rep's member list as a possible duplicate. |

### 9.2 KYC

- BVN name/phone mismatch is the dominant rejection. The failure screen says exactly that, in plain words, and tells the rep to use the phone number registered on their BVN.
- Three consecutive failed attempts locks retries for 24 hours and notifies the admin.
- A rep stuck at `kyc_failed` keeps their space, code and drafted dues. Nothing is destroyed.

### 9.3 Suspension

- The admin can suspend a space. Payments are refused at checkout, withdrawals are blocked, the balance stays where it is.
- Students in a suspended space see a neutral notice, not an accusation.

### 9.4 Refunds

- No self-service refunds in MVP. The admin issues one as a manual NIP transfer from the space account, recorded against the payment with a reason.
- If the space balance is short, the refund is blocked and escalated — Duevy does not front the money.

---

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| Stack | Next.js (App Router) frontend, Node/Express or Next route handlers for the API, PostgreSQL, hosted on Vercel with a managed Postgres. |
| Security | Anchor keys server-side only; signed webhooks; rate limiting on join, login and checkout; passwords hashed with argon2/bcrypt. |
| Data protection | NDPR: a privacy policy at signup, stated retention, and an export/delete path on request. BVN never persisted. |
| Auditability | Every admin action, KYC transition, payment status change and payout writes to `audit_log`. |
| Availability | Checkout and webhook handling are the critical paths. A failed webhook is retried; a dropped one is caught by nightly reconciliation. |
| Mobile | Students pay on phones. The checkout is designed mobile-first, with a tap-to-copy account number. |
| Emails | Transactional only: email verification, approval decision, KYC result, payment receipt, payout result, rep daily digest. |
| Observability | Error tracking plus an `/admin` health view: pending webhooks, unmatched inflows, stuck payments. |

---

## 11. Success metrics for the pilot

| Metric | Target | Why it matters |
|---|:--:|---|
| Reps approved → verified | ≥ 80% | Measures whether the KYC step is survivable. |
| Time from approval to first published due | < 24 hours | Measures onboarding friction. |
| Students joined per active space | ≥ 60% of cohort | Measures whether the code distribution works. |
| Checkout started → paid | ≥ 70% | Measures the transfer flow and the countdown pressure. |
| Payments needing manual reconciliation | < 2% | Measures whether the money plumbing is sound. |
| Unprompted rep withdrawals | ≥ 1 per active space | Proves the loop closes. |

---

## 12. Build order

Four milestones. Nothing in a later milestone is started before the earlier one works end to end in sandbox.

| # | Milestone | Contains |
|:--:|---|---|
| **M1** | Accounts and approval | Auth, email verification, rep registration, admin console with approve/reject, role-based dashboard shell, KYC banner (non-functional). |
| **M2** | Anchor identity | Anchor customer creation, TIER_2 verification, webhook infrastructure with signature checks and idempotency, deposit account provisioning, verified state. |
| **M3** | Collections | Space code and joining, dues CRUD, multi-select checkout, virtual account generation, inflow webhook, payment records, receipts, emails. |
| **M4** | Payouts and hardening | Withdrawal flow, transfer webhooks, balance warnings against the TIER_2 ceiling, nightly reconciliation, admin unmatched-inflow view, audit log. |

---

## 13. Open questions

These need an answer from Anchor or a decision from you before M2 starts.

| # | Question |
|:--:|---|
| 1 | ~~**Tier naming mismatch**~~ — **ANSWERED.** The API's `level` enum accepts only `TIER_2` and `TIER_3`, and the fee types are `KYC_TIER_2` / `KYC_TIER_3`. The BVN level is `TIER_2`, so the pricing sheet's "Individual KYC Tier 2 — ₦50" is the right line and the ₦50 assumption in §7.2 holds. See §3.4. |
| 2 | ~~**Account ownership**~~ — **ANSWERED BY ANCHOR: neither original option.** Sub-accounts are **internal-use only** and cannot hold customer funds, so the FBO + sub-ledger model is off the table. The supported shape is: students pay into **Duevy's own settlement account** via Pay With Transfer, and each department's share is then moved on by a **free book transfer** to a deposit account owned by the rep's verified customer record. Duevy therefore holds student funds transiently, between `payin.received` and remittance — which makes SCUML (question 6) materially more likely, not less. |
| 3 | ~~**Balance ceiling**~~ — **PARTLY ANSWERED.** Anchor confirmed **Duevy's settlement account has no limit**, so the ₦50,000 single-deposit cap no longer constrains checkout and a due may be any amount (§3.4's Consequence 1 is void). What remains unconfirmed is whether the rep's own TIER_2 deposit account still enforces the ₦300,000 cumulative ceiling against **inbound book transfers**. The withdrawal nudge stays in place as advisory until Anchor answers. |
| 4 | ~~**Dynamic virtual accounts**~~ — **ANSWERED: `POST /pay/pay-with-transfer`.** Fixed `amount` (so under/overpayment is impossible), real `expiryTime` in seconds (so the 30-minute countdown is enforced by Anchor, not cosmetic), single-use, and `customer.fullName` omitted means the payer sees **"DUEVY"** rather than the rep's BVN name. The cost: `/pay/*` is the Payments product, gated on a payment program and **production-only**, so the entire collection path is untestable until KYB clears. The earlier `POST /api/v2/virtual-nubans` route is documented and real but settles to the rep's account, which Anchor does not support for collections. |
| 5 | ~~**Service-charge settlement**~~ — **ANSWERED, AND SIMPLER THAN EITHER OPTION.** The full amount lands in Duevy's settlement account and only `netToSpace` is book-transferred out, so Duevy's margin is simply what stays behind — there is no sweep, and no way to take Anchor's cut twice. Anchor's 0.5% collection fee is charged against the settlement account, so Duevy absorbs it and the rep receives the full face value. Book transfers are internal and free. |
| 6 | **SCUML registration** — flagged as applicable given third-party fund handling. Confirm whether Anchor requires it before production approval for Duevy Labs Ltd. |
| 7 | ~~**Stamp duty on payouts**~~ — **DECIDED: passed through.** The rep is charged ₦100 (₦50 Anchor NIP + ₦50 Duevy) plus ₦50 stamp duty above ₦10,000, shown as a separate statutory line. Anchor deducts the duty itself as a `STAMP_DUTY` fee row, so Duevy does not add it to the transfer — it is taken out of the rep's gross request so the account reconciles exactly. Still worth confirming the duty is charged to the customer account rather than the organisation's. |
| 8 | ~~**Inflow fee**~~ — **ANSWERED: charged separately, not netted off.** Anchor books its fees as distinct `CustomerFee` rows against the account (`PAYMENT_COLLECTION`, `STAMP_DUTY`, `TRANSFER_FEE`, `VAT`, `COT`), so the credit equals what the student sent. No top-up from revenue is needed. The consequence for the sweep: only Duevy's own margin is moved out, never `processingFee`, or Anchor's cut would be taken twice. |

---

*Sources: Anchor BaaS Standard pricing sheet and 3-Tiered KYC Requirements (both supplied), docs.getanchor.co, and Anchor's published OpenAPI specification (the authority for the tier enum, fee types, transfer statuses and the lowercase `reference` constraint).*
