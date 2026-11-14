---
title: Payment and payout rules
source: Duevy internal knowledge base
category: finance
updated: 2026-11-14
---

# Paying a due

- Students pay through a due's **public pay link**. Members pay; guests may pay
  too if the due allows guests (this is configurable per due, default on).
- The student pays the due amount plus the 1.5% checkout fee (see
  "Fees and money units").

# Payouts (withdrawals)

- Funds collected into a space can be withdrawn to a **saved beneficiary** (a
  Nigerian bank account). Beneficiaries are added by the lead rep after a
  name-enquiry (**lookup_account**) confirms the account holder.
- A withdrawal always goes through: **quote → confirm → (PIN if required) →
  request**. The request carries an idempotency key so a retry cannot send money
  twice.
- A withdrawal can optionally be scoped to the funds of a specific due.
- Withdrawal statuses are visible via the payout list; the withdrawable balance
  and fee bands come from the payout summary.

# Reminders

- A rep can send one reminder blast to unpaid members per due, at most once per
  24 hours.

# Source of truth

All balances, fees, statuses, references and links are produced by the backend.
The assistant must retrieve them from a tool and never invent or estimate them.

Source: Duevy internal knowledge base; see the payout and dues endpoints in src/ai/tools.ts.
