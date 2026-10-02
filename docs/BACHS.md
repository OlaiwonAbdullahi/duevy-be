# Bachs Connect integration

This covers how Duevy uses Bachs (docs.bachs.io), why it is built this way, what to set up in the Bachs dashboard, and what the Bachs docs leave open. Everything stated as "Bachs does X" is quoted or paraphrased from the docs (October 2026). Anything else is marked as an assumption.

## Shape

| Duevy concept | Bachs concept |
|---|---|
| Rep | A **recipient Connect account** (`POST /v1/accounts`, `entity_type: individual`, capabilities `transfers` and `payouts`). Its representative **person** carries the NIN. |
| Rep KYC | `POST /v1/accounts/{id}/persons` with `id_numbers: [{ type: "nin" }]` and `dob`. Bachs: "The `id_number` requirement is satisfied by any non-BVN entry", and `persons.bvn` is `eventually_due` and "do[es] not block getting started". The verdict arrives through `account.updated` / `capability.updated`; Duevy then re-reads the person (`verification.status`), the `payouts` capability and the account's outstanding `requirements` (shown to the rep as `requirementsDue`). If Bachs asks for a BVN, it is added beside the NIN; if it asks for an ID document, the file goes through `POST /v1/utilities/uploads` (scope `identity_document`) and is attached to the person as `primary_verification`. |
| Student ID card | **Not a Bachs document.** Bachs's ID types are government IDs (`nin`, `passport`, `id_card`, `drivers_license`, `residence_permit`). The card is Duevy's own check that the rep is a student: uploaded at KYC time to private ImageKit storage and approved by an admin. Collection needs Bachs `verified` **and** the card approved. |
| Checkout | A **destination charge** created by the platform with `ui_mode: "custom"`:<br>• `pricing.amount` = face + fee<br>• `platform_fee` = fee<br>• `transfer_data.destination` = the rep's account<br>• `payment_method_types: ["NGN_BANK_TRANSFER"]`<br>Then `PATCH` sets the payment method and `POST …/confirm` returns `next_step.bank_account`, the one-time account the student pays into. |
| Space balance | Duevy's own append-only ledger, per space. The rep's Bachs account holds the money for all of their spaces. |
| Withdrawal | A **payout made as the rep's account** (`X-Account-Id`) to a registered destination (`POST /v1/payouts/destinations`). The payout reference is used as the `Idempotency-Key`. |
| Withdrawal fee | After `payout.paid`, `POST /v1/transfers` as the rep's account with `destination: "self"` moves (Duevy fee − Bachs payout fee) to the platform. If Bachs's fee is the larger of the two, the platform tops the rep's account up instead. |

### Why the rep's Bachs balance always equals the space ledger

| Event | Rep's Bachs account | Space ledger |
|---|---|---|
| Student pays face F + fee f | +F (Bachs keeps `platform_fee` = f on the platform; Duevy absorbs Bachs's processing fee out of f) | +F |
| Rep withdraws G (Duevy fee w) | −(G − w) − b (Bachs charges its payout fee b on top) | −(G − w) − w |
| Fee settlement after success | −(w − b) | — |
| **Net** | **F − G** | **F − G** |

## Dashboard and account setup (before go-live)

1. **Connect.** The platform needs the `connect` capability active.
2. **Custom Checkout.** Its access is gated: email hello@bachs.io. Sandbox works without it.
3. **Processing fee.** Make sure the merchant (Duevy) absorbs Bachs's processing fee on checkouts. If customers bear it, Bachs's price for the checkout won't match Duevy's, and `createCollectionAccount` refuses the checkout with `PRICE_MISMATCH` instead of overcharging the student.
4. **Webhook endpoint.** Point it at `https://<api>/v1/webhooks/bachs` with **`event_source: all`**, then put its secret in `BACHS_WEBHOOK_SECRET`. Subscribe to:
   - `collection.succeeded`, `collection.underpaid`, `collection.failed`
   - `checkout.expired`
   - `payout.paid`, `payout.failed`
   - `account.updated`, `capability.updated`
5. **API key scopes:**
   - `payments:read`, `payments:write`
   - `connected_accounts:read`, `connected_accounts:write`
   - `payouts:read`, `payouts:write`
   - `transfers:read`, `transfers:write`

## Robustness

| Concern | Mechanism |
|---|---|
| Forged or replayed webhook | The webhook's HMAC-SHA256 over `"{t}.{raw body}"` must match, and the timestamp must be within 300 s. Any `v1` matching either the current or the previous secret is accepted. |
| Duplicate delivery | A unique `(provider, providerEventId)` key at enqueue. The same outcome under a new event id is handled by the state machine, row locks, and the ledger's unique `(type, duePaymentId)` / `(type, payoutId)` keys. |
| Slow processing | The route enqueues and returns 200. A DB-backed worker (`FOR UPDATE SKIP LOCKED`) retries failures with exponential backoff, gives up after 8 attempts, and moves the event to `dead`, which shows on `/admin/health`. |
| Lost webhook | Reconciliation, every minute:<br>• polls checkouts that have been pending for 10 minutes or more<br>• resends payouts that never reached Bachs (same idempotency key)<br>• refreshes payouts stuck in processing<br>• retries fee settlements |
| Double withdrawal | A transaction-scoped advisory lock per space, plus a unique `activeSpaceId` (one in-flight withdrawal per space), plus the request's Idempotency-Key, plus the Bachs Idempotency-Key. |
| Timeout from Bachs | Never treated as "didn't happen". Checkout creation and payouts retry with the same idempotency key. |
| Late money | A transfer that lands after expiry is still honoured (`expired → paid`) and flagged for review. |

## Open questions for Bachs (the docs don't answer these)

1. **Custom Checkout and destination charges.** Can `ui_mode: "custom"` be combined with `transfer_data` + `platform_fee`? The guides show each separately, and the OpenAPI spec has no `ui_mode` or `/confirm` at all.
   - Fallback if not: charge on the platform with no split, then `POST /v1/transfers` the face amount to the rep's account once it settles. `createCollectionAccount` is the only place that would change.
2. **Is a NIN enough for KYC in live mode?** Does NIN + name + a resolvable bank account take a recipient account's `payouts` capability to `active`, or will Bachs also ask for an ID document (the create-account example lists `persons.…id_document` as currently due)? Duevy handles either: what is still due is shown to the rep, who can send a government ID through `POST /payout/kyc/government-id`. When is the `eventually_due` BVN actually requested?
3. **How is the ID number sent?** The identity guide uses `id_numbers: [{ type, value, issuing_country }]`; the OpenAPI spec has a single untyped `id_number`. Duevy sends `id_numbers`, so the NIN is unambiguous.
   - Verification statuses also differ: `pending | passed | failed` in the guide, `unverified | pending | verified | failed` in the spec. Both are accepted.
4. **Gender.** Bachs has no gender field. Duevy validates the field (the product requires it) and does not send or store it.
5. **KYC review turnaround.** How long does the human review take for a NIN-only person, and is there an SLA?
6. **Underpaid destination charges.** Does an underpaid charge settle to the rep, get auto-refunded, or wait? Can the student top up the same one-time account? Is there an API to accept a partial payment? Duevy marks the checkout `underpaid`, marks no due paid, and flags it for an admin.
7. **Overpayment.** Is the excess kept, and on which balance (the platform's or the rep's)? Duevy honours the payment and flags the excess for a manual refund.
8. **Payment after `expires_at`.** Is a transfer that arrives after expiry auto-refunded, or credited? Duevy honours it if Bachs reports it as succeeded.
9. **Settlement timing.** How long until a destination charge's share is available on the rep's account? Duevy credits the ledger when the webhook arrives. If a withdrawal reaches Bachs before the funds are available, Bachs returns `INSUFFICIENT_BALANCE`, and the withdrawal fails ("payments are still settling") and is fully restored.
10. **Reversals.** There is no `payout.reversed` event. Duevy treats a `payout.failed` after `payout.paid` as a reversal. Does Bachs restore the account balance when a payout fails, including its own fee?
11. **Webhooks.** The retry schedule, attempt limit, timeout, auto-disable policy and source IPs are undocumented.
12. **Rate limits on name enquiry,** and whether name enquiry costs anything.

## Assumptions made

- **Fees:**
  - The ₦20 flat fee is charged **once per checkout**, not per due.
  - The 2% is rounded half-up to the kobo.
  - The withdrawal threshold is inclusive: ₦50,000.00 pays ₦200.
- **Bachs's own fees** (processing and payout) are absorbed by Duevy out of its fees and never charged to students or reps.
- **Payout account.** It is registered on the lead rep's Bachs account. The name enquiry result must match the rep's name: at least two name words, ignoring order, case, accents and titles.
- **One Bachs account per rep.** A rep's spaces share it, and the ledger separates them.
- **Approval.** Approving a rep still creates the space requested in their application. The rep can also create more spaces with `POST /spaces`. `role` stays `rep` for older clients; permissions check `isRep`.
- **Join codes.** A member joined as `guest` through the join code can pay. Anonymous payers cannot.
- **Admin manual credit** (`POST /admin/dues/:id/credit`) credits the ledger without money moving at Bachs. It is audited as critical and meant only for a payment that demonstrably happened.

## Cutover from Anchor

1. **Before migrating,** settle or record every Anchor-era balance. Anchor-era ledger credits count toward a space's balance, but that money is in Anchor deposit accounts, not at Bachs. A withdrawal against it would fail at Bachs (`INSUFFICIENT_BALANCE`) and be restored, so it is safe but confusing.
2. **Run `prisma migrate deploy`.** The migration is data-preserving:
   - It recreates the ledger table if it was never migrated. It reached existing databases through `db push`.
   - It maps old due categories and payout statuses onto the new ones.
   - It tags all existing payouts and webhook events `provider = 'anchor'`.
   - It debits Anchor-era payouts still in flight so they can't be double-counted.
   - It resets rep KYC to `unverified`. Every rep re-verifies once on Bachs (NIN) and uploads their student ID card.
3. **Resolve by hand** any Anchor payout still `pending`/`processing`, using `GET /admin/payouts?status=processing`.
4. **Ledger uniqueness.** If creating `ledger_entries_type_duePaymentId_key` or `ledger_entries_type_payoutId_key` fails, the ledger already holds a duplicate from before. Investigate it; don't drop the key.
