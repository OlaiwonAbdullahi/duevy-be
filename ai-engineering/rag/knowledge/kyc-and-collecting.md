---
title: KYC and collecting payments
source: Duevy internal knowledge base
category: compliance
updated: 2026-11-14
---

# KYC gating

Before a space can collect money from students, it must pass **KYC**
(verification). Concretely:

- A due can be saved as a **draft** at any time.
- **Publishing** a due (opening it for payment) requires the space to have
  passed KYC. Publishing a due in an unverified space is rejected.

The assistant can check a space's KYC status and report what, if anything, is
still outstanding before the space can collect. If a publish fails for KYC
reasons, the correct response is to explain that verification is still needed and
offer to show what's missing — not to retry blindly.

# Draft vs active vs closed dues

- **draft** — created but not open for payment; can be deleted.
- **active** — published and accepting payments.
- **closed** — no longer accepting payments.

Only draft dues can be deleted. An active due can be **closed** to stop
accepting payments.

Source: Duevy internal knowledge base; see the KYC-status and publish endpoints referenced in src/ai/tools.ts.
