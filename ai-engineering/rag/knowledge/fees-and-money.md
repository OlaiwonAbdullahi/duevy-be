---
title: Fees and money units
source: Duevy internal knowledge base
category: finance
updated: 2026-11-14
---

# Money units: naira and kobo

Nigerian currency is the naira (₦). 1 naira = 100 kobo. Duevy stores monetary
values internally in **kobo** (the minor unit): a stored value of `500000` means
₦5,000.00, `150000` means ₦1,500.00, and `507500` means ₦5,075.00. Divide a
stored kobo value by 100 to show naira.

- Amounts a rep types in chat or the dashboard are in **naira**.
- Values already written with a ₦ sign (e.g. in a created-due summary or a
  withdrawal quote) are already naira and should be shown as-is.

# Student checkout fee

When a student pays a due, a **1.5% checkout fee** is added on top of the due
amount. The student pays the face amount plus this fee. Example: for a ₦2,000
due, the fee is ₦30, so the student pays ₦2,030.

# Withdrawal fees

Withdrawing collected funds to a bank account incurs a payout fee. The exact fee
depends on the amount and the space's fee band; reps should always view the
**withdrawal quote** (amount, fee, net received) before confirming a payout. The
precise fee schedule is configured in the backend and returned by the quote —
retrieve it rather than quoting a fixed number.

Source: Duevy internal knowledge base; see src/lib/money.ts and the payout quote endpoint.
