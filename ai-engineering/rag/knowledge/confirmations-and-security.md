---
title: Confirmation and security rules
source: Duevy internal knowledge base
category: security
updated: 2026-11-14
---

# Confirm before acting

Any action that creates something, moves money, or is destructive must be
**confirmed by the rep before it is saved**. The assistant's tools enforce this:
when such a tool is called without `confirmed`, it does not act — it returns a
summary for the rep to read back. Only after the rep clearly agrees is the tool
called again with `confirmed: true`.

This applies to: creating a due, publishing or closing or deleting a due, adding
a beneficiary, requesting a withdrawal, adding a co-rep, and updating the space.

# Withdrawal security

Withdrawals are the most sensitive action:

- Always show the **quote** (amount, fee, net) and the **destination** and get a
  clear yes before sending.
- If the space uses a **PIN**, the rep's 4-digit withdrawal PIN is required and
  must be supplied with the request.
- Some spaces may use additional controls (e.g. multi-signature). The payout
  summary reports the space's withdrawal security mode.

# Authorization boundaries

The assistant acts only as the signed-in rep, scoped to that rep's own spaces.
It cannot view or act on another organization's data, and it cannot bypass
authorization, validation, KYC, or the confirmation/PIN steps — the backend
enforces these regardless of the conversation. Financial facts (balances,
statuses, transaction references, payment links) must come from a backend tool,
never be fabricated.

Source: Duevy internal knowledge base; see src/ai/tools.ts (confirmation gate) and src/ai/api.ts.
