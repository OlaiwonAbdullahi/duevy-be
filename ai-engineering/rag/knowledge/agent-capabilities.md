---
title: Assistant capabilities (tool surface)
source: Duevy internal knowledge base
category: product
updated: 2026-11-14
---

# What the assistant can do

The assistant performs actions through a fixed set of backend tools. It cannot
do anything outside these; each maps to the same REST endpoint the dashboard
uses, scoped to the rep's spaces.

## Spaces
- **get_my_spaces** — list the rep's spaces and which is active.
- **set_active_space** — choose the space to work on (needed if the rep has more than one).

## Dues
- **list_dues** — list the space's dues with paid/unpaid counts (optional status filter).
- **create_due** — create a due (amount in naira, a deadline, a category); confirm-first.
- **publish_due** — open a draft due for payment (needs KYC).
- **close_due** — stop a due accepting payments; confirm-first.
- **delete_due** — delete a draft due; confirm-first.
- **remind_unpaid** — notify members who have not paid (one blast per due per 24h).
- **get_pay_link** — get a due's public payment link.

## Reporting
- **who_hasnt_paid** — list members who have not paid a due, with totals.
- **collection_summary** — paid/unpaid roster and money totals for a due.
- **space_overview** — the space's dashboard totals (collected, outstanding, rate, active dues, newest members).

## Payouts and beneficiaries
- **payout_summary** — withdrawable balance, KYC state, withdrawal security, fee bands.
- **list_banks** — Nigerian banks and codes.
- **lookup_account** — resolve the account-holder name for a bank + account number.
- **list_beneficiaries** — saved payout destinations.
- **add_beneficiary** — save a payout destination (lead rep only); confirm-first.
- **quote_withdrawal** — fee breakdown for a withdrawal amount.
- **request_withdrawal** — request a withdrawal to a saved beneficiary; confirm-first, PIN if required.
- **list_payouts** — the space's withdrawals and statuses.

## Team, KYC and settings
- **list_members** — the space's members (optional search).
- **list_reps** — the space's reps.
- **add_corep** — add a co-rep by email (lead rep only); confirm-first.
- **kyc_status** — the space's verification status and what's still needed.
- **update_space** — update the space profile (name, about, faculty); lead rep only; confirm-first.

Source: Duevy internal knowledge base, generated from src/ai/tools.ts (25 tools).
