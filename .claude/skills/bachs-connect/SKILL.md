---
name: bachs-connect
description: End-to-end reference for building on Bachs Connect (bachs.io) — connected accounts, capabilities, Tasks/onboarding, identity verification, balances, split-payment transfers, withdrawals, clawbacks, and webhooks. Use this skill whenever the work touches Bachs, connected accounts, marketplace or platform payouts, splitting a collected charge between a platform and a seller, paying departments/creators/contractors, or any Duevy payment, payout, or settlement code — even if the user just says "payments", "payout", "split", "settlement", or "wallet" without naming Bachs.
---

# Bachs Connect

Bachs Connect gives every business or person you pay a financial identity you create and own. This skill covers the whole loop: create account → onboard → capability enabled → collect → split → withdraw → reconcile.

**Running reference: Duevy** (`duevy.app`) — Nigerian student dues platform. Students pay departmental dues; Duevy collects centrally and pays each department out. Every example below is written in Duevy's terms so the mapping to a real codebase is concrete.

## Duevy mapping

| Bachs concept                 | Duevy concept                                               |
| ----------------------------- | ----------------------------------------------------------- |
| Your platform organization    | Duevy Ltd (`org_duevy...`)                                  |
| Connected account             | A department space (e.g. "LAUTECH Computer Science")        |
| Account representative        | The course rep / dept admin                                 |
| Charge                        | A student paying one or more dues in a single tap           |
| Transfer                      | Duevy sending the department its face amount                |
| Platform cut                  | The 1.5% Duevy keeps out of the 3% added on top             |
| Withdrawal                    | The quorum-approved payout to the department's bank account |
| Clawback (transfer to `self`) | Refund recovery under the quorum refund policy              |

## Non-negotiables

Get these wrong and money misroutes silently.

- **Money is a decimal string** at the currency's precision (`"7000.00"`), always paired with an ISO 4217 `currency`. Never minor units, never a JS `number`. Use `decimal.js` or Postgres `NUMERIC(18,2)` end to end.
- **Sandbox first.** `https://sandbox-api.bachs.io` with `sk_sandbox_` keys; production is `https://api.bachs.io` with `sk_live_`. Going live is a base-URL + key swap and nothing else.
- **Webhooks are the source of truth** for fulfilment. Never a redirect, never a client event, never a `200` from checkout creation.
- **Gate on `capability.status === "active"`.** Not `setup_status: "complete"`, not `satisfied: true`, not "the form was submitted". Every other value denies the action.
- **Send `Idempotency-Key` on every money-moving POST** (transfers, withdrawals). Derive it deterministically from your own domain ids so a retry is provably the same request.
- **A network error or `5xx` is not proof nothing happened.** Read the resource back (Get Transfer / Get Withdrawal) or retry with the identical `Idempotency-Key`.
- **Balances never go below zero.** A transfer or withdrawal over `available_balance` returns `INSUFFICIENT_BALANCE` and records no debt.
- **IDs carry prefixes** (`org_`, `cust_`, `prod_`, `chk_`, `tr_`, `wd_`, `pd_`, `per_`, `upl_`, `cal_`); timestamps are ISO 8601 UTC.

---

## Step 0 — Choose the integration shape

One decision shapes everything else, and changing it later means re-onboarding every account:

> When a student pays, do they pay **Duevy**, or the **department**?

Answer in order; first match wins:

1. Must the customer see the seller's name as the merchant on the charge? → the account collects.
2. Can you not absorb refunds and disputes? → the account collects.
3. Are your accounts individuals rather than registered businesses? → **you collect** (their Tasks are much shorter).
4. Otherwise → you collect.

**Duevy collects.** Course reps are individuals, not registered businesses, so the short-Tasks path is the only one they will finish. Duevy already owns refunds through its quorum refund policy. Departments therefore need exactly two capabilities — `transfers` and `payouts` — and nothing that accepts payments.

If a future product _does_ need the seller as merchant of record, read the "Account collects" section near the end.

## Step 1 — Become a platform

`connect` must be `active` on your own organization before you can create anything.

- Requested from the **dashboard only**. There is no API-key endpoint for it.
- Requesting it **converts your org from individual to company, irreversibly**, and re-evaluates every capability you already hold as a company. Do this on the Duevy business entity (CAC-registered), not a personal org.
- Check status: `GET /v1/organizations/me` · scope `organizations:read` → `capabilities.connect.status`.

`connect` gates: creating a connected account, issuing an account link, writing an account's Tasks, and transferring **to** an account. It does **not** gate: reading accounts/balances/capabilities, an already-issued link (so accounts mid-onboarding can finish), or transferring **from** an account back to you.

## Step 2 — Create a connected account

`POST /v1/organizations/connected-accounts` · scope `connected_accounts:write`

```bash
curl -X POST https://sandbox-api.bachs.io/v1/organizations/connected-accounts \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contact_email": "rep@lautech.edu.ng",
    "display_name": "LAUTECH Computer Science",
    "country": "NG",
    "entity_type": "individual",
    "capabilities": {
      "transfers": { "requested": true },
      "payouts":   { "requested": true }
    }
  }'
```

Returns `id` (`org_...`), `capabilities` (all `restricted` at first), and a `requirements` block. **Persist `id` on the Duevy `departments` row immediately** — every later call needs it.

- `contact_email` is the only required field. Bachs emails onboarding correspondence there.
- `country` decides which Tasks the account gets; it defaults to your org's country.
- `entity_type` is `individual` or `company`. Changing country or entity type recomputes the entire Task set.
- **Always send `capabilities` explicitly.** Omitting it requests _every_ capability the account can hold, which lengthens Tasks and increases abandonment. Send `{}` to request nothing yet.
- Request more later with `PATCH /v1/connected-accounts/{id}` using the same map. `"requested": false` returns `400 capability_unrequest_unsupported` — there is no unrequest path.
- A connected account cannot create connected accounts (`403`).

### Acting as an account

Send `X-Connected-Account-ID: org_...` on any API-key endpoint and the request runs as that account. There is no per-account API key. Naming an account you don't own returns `404` (never `403`, so the response never confirms the id exists).

## Step 3 — Onboard it

Two routes, same information collected.

|                                | Hosted link | API onboarding       |
| ------------------------------ | ----------- | -------------------- |
| You build                      | A redirect  | The whole interface  |
| New Tasks appear automatically | Yes         | No — you render them |
| Lifetime                       | Single use  | n/a                  |

**Use the hosted link for Duevy v1.** API onboarding is a standing maintenance commitment: when compliance adds a field, it arrives as a Task your form doesn't render and reps stall with nothing visibly wrong.

### 3a. Hosted link

`POST /v1/connected-accounts/{id}/account-links` · scope `connected_accounts:write`

```bash
curl -X POST https://sandbox-api.bachs.io/v1/connected-accounts/org_dept123/account-links \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "onboarding",
    "refresh_url": "https://duevy.app/dashboard/space/settings/payouts/refresh",
    "return_url":  "https://duevy.app/dashboard/space/settings/payouts/done"
  }'
```

- `type`: `onboarding` for a new account, `update` to collect more from a live one.
- **Creating a link supersedes the previous one** (`previous_link_superseded`). Never mint a link on page render — a link generated when the settings page loads kills the one you emailed yesterday. Mint it on an explicit "Set up payouts" click, and again from your `refresh_url` handler.
- The `return_url` redirect fires whether the rep finished or abandoned, and is lost entirely if the browser never comes back. Treat it as a cue to show a status screen, never as confirmation.

### 3b. API onboarding (only if you own the UI)

1. `GET /v1/connected-accounts/{id}/requirements/checklist` — every field with `state`, `provided`, `error_reason`, `reference`, plus a per-capability breakdown. Render `checklist` as your form.
2. `GET .../requirements/banks` and `.../requirements/momo` — reference data for fields that can't be typed freely.
3. `POST .../requirements/accounts/resolve` with `{ account_number, bank_code }` — confirms the real account name. Do this _before_ submission: it turns a rejection days later into an inline error while the rep is still on the page.
4. `POST .../uploads` (multipart: `file`, `scope`) → `upload_id`. Reference that id in the submission, not the file.
5. `POST .../requirements/submit` with `{ country, draft, data: { persons: [...], "company.*", "business_profile.*", external_account } }`. Send `draft: true` for partial saves — validation problems come back in `errors` instead of failing the request.
6. Re-read the checklist. Rejected fields return as `currently_due` with `provided: true` and a display-ready `error_reason`.

### Field states (checklist)

`currently_due` · `eventually_due` · `past_due` · `pending_verification` · `pending_review` · `satisfied`

`provided` disambiguates: `currently_due` + `provided: true` = rejected; + `provided: false` = never filled in.

Header counts use different names from the states: `currently_due`, `pending_review`, `in_verification` (counts `pending_verification`), `needs_attention` (rejected, awaiting resubmission).

`GET .../requirements/tasks` returns human-facing units with `title`, `type` (`document` | `form_field` | `action` | `edit_section`), `status`, `due_date`, `rejection_reason`, and `impacts_capability` — show that last one so the rep knows what stalls if they ignore it.

The account object also carries a compact roll-up for a status badge: `setup_status` (`incomplete` | `awaiting_review` | `complete`), four arrays of **field keys**, and `errors[]`. List responses carry `fields_needing_resubmission` — a count of standing rejections only (`null` = unknown, not zero). Use it to flag departments needing attention on Duevy's admin index.

## Step 4 — Identity verification

Identity is where accounts abandon most. Branch on what the country supports rather than hardcoding a screen.

- `GET .../identity/methods` → `{ hosted_available, nin_available, country }`. For NG both are typically true — offer the choice.
- `GET .../identity/representative` → pre-fill for a returning rep; `exists: false` means none created yet. If `verification_status` is already verified, don't re-collect.
- `POST .../identity/session` → `{ url, token, status, expires_at }`. Any device opening `url` drives the same session, so it works as a link, an embed, or a QR code. `POST .../identity/hosted-link` is the emailable variant.
- `POST .../identity/nin` with `{ nin, consent: true }` (+ optional base64 `selfie` for face match). `consent` must be true — the rep is attesting to a government database check, so surface that in the UI copy. Returns `status`: `verified` | `failed` | `pending`, with `reason` on failure.
- `GET .../identity/status` → current state, `failure_reason`, `verification_url` if a session is still open.

### Reuse a verified identity — high payoff for Duevy

A rep who runs two departments should never verify twice.

```bash
GET  /v1/connected-accounts/{id}/requirements/reusable-identity
POST /v1/connected-accounts/{id}/requirements/reusable-identity/apply  -d '{"person_public_id":"per_..."}'
```

The GET returns `available`, `person_public_id`, name, `verification_status`, and `used_by` (the businesses already using it). **Show the name and `used_by` and get explicit confirmation — never apply it silently.** The response deliberately never exposes the identity number or documents.

## Step 5 — Monitor onboarding (webhooks, not polling)

A reviewer enables capabilities on no fixed schedule, so polling is either wasteful or late.

```bash
curl -X POST https://sandbox-api.bachs.io/v1/webhooks/endpoints \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Duevy Connect",
    "url": "https://duevy.app/api/webhooks/bachs/connect",
    "event_source": "connect",
    "event_types": ["account.updated","capability.updated","transfer.created","payout.paid","payout.failed"]
  }'
```

- **`event_source` is the whole trick.** Without it an endpoint receives only your own org's events, never your accounts'. Use `connect` for accounts' events, `all` to handle both on one endpoint.
- On a Connect event, `organization_id` is **the connected account, not your platform**. Read the account from the payload; don't assume it's you.
- Drive Duevy's payout-setup status screen from `account.updated` (`setup_status`, `outstanding`).
- Unlock features only on `capability.updated` with `status: "active"` for the specific capability.
- A capability can change more than once, **including back to `restricted`**. Handle it as a state change every time, and re-check before any action that moves money.
- After an outage, reconcile by reading `GET /v1/connected-accounts/{id}/capabilities` rather than replaying assumptions.

## Step 6 — Collect and split

### Balances

`GET /v1/accounts/balances` · scope `accounts:read` (add `X-Connected-Account-ID` for a department's balance — works from the moment the account exists, whatever its capability state).

- `available_balance` funds transfers and withdrawals.
- `pending_balance` is charged-but-unsettled money and **cannot be moved**.
- `pending_settlements_by_day` gives the date each pending amount becomes available, per currency. Schedule against this.
- `total_balance_usd` is display-only; no operation accepts it.
- Currencies are independent. A USD balance never funds an NGN transfer, and transfers never convert.

### The Duevy flow

1. **Collect.** Ordinary checkout session on Duevy's own account — nothing Connect-specific. Student pays face + 3%.
2. **Wait for settlement.** A transfer sent before settlement fails with `INSUFFICIENT_BALANCE`. Trigger the split on settlement, not on `collection.succeeded`.
3. **Transfer the department its share.**
4. **Confirm** from `transfer.created`.

```bash
curl -X POST https://sandbox-api.bachs.io/v1/transfers \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: SPLIT-chg_2f8a71c4e05b-dept" \
  -d '{
    "destination": "org_dept123",
    "amount": "5000.00",
    "currency": "NGN",
    "transfer_group": "chg_2f8a71c4e05b",
    "description": "CSC 200L dept dues — order #4471"
  }'
```

**There is no `source` field.** The debited side is always the authenticated org, so direction follows from authentication: platform key alone = money out to the account; `X-Connected-Account-ID` + `destination: "self"` = money back to you. Account-to-account is rejected with `400`; moving value between two departments is two transfers through Duevy.

**Your cut is whatever you don't transfer.** There is no fee schedule to configure. For Duevy: student pays `face × 1.03`, you transfer exactly `face`, the 3% stays behind. Because the department's share is a known face amount rather than a percentage, Duevy sidesteps the rounding trap — but the rule still stands: **divide the collected amount, never round percentages independently**, or you leave an unexplained remainder. Assign any remainder deliberately.

**`transfer_group`**: use the funding charge id, and reuse it on every transfer for that charge including later clawbacks. For batch payouts with no charge behind them (rep referral payouts), use the run id instead — e.g. `payrun_2026_08` — and derive the `Idempotency-Key` from run + recipient so a retried run reconciles as one set and cannot pay anyone twice. There is no batch endpoint; one call per recipient keeps one failure from taking down the run.

**Reconcile**: `GET /v1/transfers?connected_account_id=org_dept123&limit=50` returns transfers your platform was a party to, newest first, in either direction. **Listing does not filter by `transfer_group`** — store the group on the Duevy order row yourself; that's what takes you from an order to its transfers and from a `transfer.created` back to the order.

**Timing is a risk lever.** The longer Duevy holds a share, the more likely a dispute arrives while the funds are still reachable. Match the hold window to the dispute window rather than transferring on the settlement date.

## Step 7 — Withdrawals (Duevy's quorum payout)

Requires `payouts` **active** on the withdrawing account. Duevy's own rule — `ceil(team_size × 0.8)` approvals — is enforced in Duevy's `payout_requests` / `payout_approvals` tables _before_ any Bachs call. Bachs has no concept of your quorum.

1. **Register a destination** — `POST /v1/payouts/destinations` · scope `payouts:write`. `destination_type` is `bank_account` | `mobile_money` | `crypto_wallet`. Resolve bank details first so the account name is confirmed before funds move.
2. **Quote** — `POST /v1/payouts/quotes`. Required only when `from_currency ≠ to_currency`. The quote fixes a rate and expires; create it immediately before the withdrawal. NGN→NGN needs none.
3. **Create** — `POST /v1/payouts/withdrawals`.
4. **Track to terminal status** — subscribe to `payout.paid` / `payout.failed`, or poll Get Withdrawal.

```bash
curl -X POST https://sandbox-api.bachs.io/v1/payouts/withdrawals \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "X-Connected-Account-ID: org_dept123" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: WD-duevy-payoutreq_8821" \
  -d '{
    "from_currency": "NGN",
    "to_currency": "NGN",
    "amount": "5000.00",
    "payment_method": "BANK_TRANSFER",
    "reference": "WD-duevy-payoutreq_8821",
    "email": "rep@lautech.edu.ng",
    "payout_destination_id": "pd_6b2f91a7c04e"
  }'
```

`reference` is your own identifier and must be unique **per account** — key it off the Duevy payout request id. Status runs `REQUESTED`/`PENDING` → `PROCESSING` → `COMPLETED` | `FAILED`, with `APPROVED`/`REJECTED` where the withdrawal is reviewed first.

**Once a department withdraws, that money is gone from your reach.** No debt is recorded, so a later clawback simply fails.

## Step 8 — Refunds and clawbacks

Because Duevy collected the charge, a refund or lost dispute debits **Duevy's** balance, not the department's. Recover the share by acting as the department and transferring to `self`:

```bash
curl -X POST https://sandbox-api.bachs.io/v1/transfers \
  -H "Authorization: Bearer $BACHS_SECRET_KEY" \
  -H "X-Connected-Account-ID: org_dept123" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: CLAWBACK-chg_2f8a71c4e05b" \
  -d '{
    "destination": "self",
    "amount": "5000.00",
    "currency": "NGN",
    "transfer_group": "chg_2f8a71c4e05b",
    "description": "Order #4471 refund recovery"
  }'
```

Reuse the original `transfer_group` so the clawback sits with the split. The department needs `transfers` active to be transferred _from_, same as to be transferred _to_ — the capability governs its participation, not one direction of it. Your own `connect` capability is **not** checked on the inbound direction, so a restricted platform can still recover funds it's liable for.

If the department already withdrew, this fails with `INSUFFICIENT_BALANCE` and nothing is recorded. That's the argument for a hold window in Step 6.

---

## Errors

Standard error envelope throughout.

| Code                               | HTTP    | Cause                                                                                                  | Fix                                                        |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `FORBIDDEN`                        | 403     | Capability not `active` (`connect` on outbound transfer, `transfers`, `payouts`), or key missing scope | Re-read capabilities; don't retry blindly                  |
| `NOT_FOUND`                        | 404     | Account isn't one of yours (also returned for another platform's account)                              | Check the stored `org_` id                                 |
| `INSUFFICIENT_BALANCE`             | 400     | Source `available_balance` < `amount` in that currency                                                 | Check `pending_settlements_by_day`, retry after settlement |
| `BAD_REQUEST`                      | 400     | Two sides aren't a platform and its own account                                                        | Route through the platform                                 |
| `VALIDATION_ERROR`                 | 400/422 | Bad `amount` string, missing destination field for the `payment_method`                                | Inspect `errors[]`                                         |
| `CONFLICT`                         | 409     | Same `Idempotency-Key` in flight                                                                       | Short delay, retry                                         |
| `capability_unrequest_unsupported` | 400     | Sent `"requested": false`                                                                              | No unrequest path; contact support                         |

## Endpoint index

| Purpose                  | Call                                                                                                               | Scope                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Platform status          | `GET /v1/organizations/me`                                                                                         | `organizations:read`        |
| Create account           | `POST /v1/organizations/connected-accounts`                                                                        | `connected_accounts:write`  |
| List / read account      | `GET /v1/organizations/connected-accounts` · `GET /v1/connected-accounts/{id}`                                     | `connected_accounts:read`   |
| Request capability later | `PATCH /v1/connected-accounts/{id}`                                                                                | `connected_accounts:write`  |
| Capability status        | `GET /v1/connected-accounts/{id}/capabilities`                                                                     | `connected_accounts:read`   |
| Hosted onboarding link   | `POST /v1/connected-accounts/{id}/account-links`                                                                   | `connected_accounts:write`  |
| Tasks                    | `GET .../requirements/checklist` · `.../requirements/tasks`                                                        | `connected_accounts:read`   |
| Reference data           | `GET .../requirements/banks` · `.../requirements/momo` · `POST .../requirements/accounts/resolve`                  | mixed                       |
| Upload / submit          | `POST .../uploads` · `POST .../requirements/submit`                                                                | `connected_accounts:write`  |
| Identity                 | `GET .../identity/methods` · `/representative` · `/status` · `POST .../identity/session` · `/hosted-link` · `/nin` | mixed                       |
| Reusable identity        | `GET .../requirements/reusable-identity` · `POST .../apply`                                                        | mixed                       |
| Balances                 | `GET /v1/accounts/balances`                                                                                        | `accounts:read`             |
| Transfers                | `POST /v1/transfers` · `GET /v1/transfers`                                                                         | `transfers:write` / `:read` |
| Payouts                  | `POST /v1/payouts/destinations` · `/quotes` · `/withdrawals`                                                       | `payouts:write`             |
| Webhooks                 | `POST /v1/webhooks/endpoints`                                                                                      | `webhooks:write`            |
| Checkout (as an account) | `POST /v1/checkout-sessions` + `X-Connected-Account-ID`                                                            | —                           |

## Duevy persistence

Minimum columns to add (Postgres):

```sql
ALTER TABLE departments
  ADD COLUMN bachs_account_id        TEXT UNIQUE,   -- org_...
  ADD COLUMN bachs_setup_status      TEXT,          -- incomplete | awaiting_review | complete
  ADD COLUMN bachs_transfers_active  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN bachs_payouts_active    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN bachs_payout_destination_id TEXT;      -- pd_...

ALTER TABLE payments
  ADD COLUMN bachs_charge_id   TEXT,
  ADD COLUMN transfer_group    TEXT,                -- = bachs_charge_id
  ADD COLUMN face_amount       NUMERIC(18,2) NOT NULL,
  ADD COLUMN gross_amount      NUMERIC(18,2) NOT NULL,  -- face * 1.03
  ADD COLUMN settled_at        TIMESTAMPTZ,
  ADD COLUMN split_transfer_id TEXT;                -- tr_...
```

Drive the two `*_active` booleans **only** from `capability.updated`, and re-read capabilities before any money movement rather than trusting the cached flag.

## Client skeleton (TypeScript)

```ts
// lib/bachs.ts
const BASE = process.env.BACHS_BASE_URL!; // https://sandbox-api.bachs.io
const KEY = process.env.BACHS_SECRET_KEY!; // sk_sandbox_...

type Opts = {
  as?: string;
  idempotencyKey?: string;
  body?: unknown;
  method?: string;
};

export async function bachs<T>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
  if (opts.as) headers["X-Connected-Account-ID"] = opts.as;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(json?.code ?? res.statusText), {
      status: res.status,
      body: json,
    });
  return json as T;
}

// Split: department receives the full face amount; the 3% add-on stays with Duevy.
export const splitToDepartment = (p: {
  accountId: string;
  chargeId: string;
  faceAmount: string;
  description: string;
}) =>
  bachs("/v1/transfers", {
    idempotencyKey: `SPLIT-${p.chargeId}-${p.accountId}`,
    body: {
      destination: p.accountId,
      amount: p.faceAmount, // decimal string, never a number
      currency: "NGN",
      transfer_group: p.chargeId,
      description: p.description,
    },
  });

export const clawback = (p: {
  accountId: string;
  chargeId: string;
  amount: string;
}) =>
  bachs("/v1/transfers", {
    as: p.accountId,
    idempotencyKey: `CLAWBACK-${p.chargeId}`,
    body: {
      destination: "self",
      amount: p.amount,
      currency: "NGN",
      transfer_group: p.chargeId,
    },
  });
```

## If the seller must collect instead

Only when the department has to appear as the merchant on the charge, and can absorb its own refunds.

- Each account needs a payment-accepting capability → **substantially longer Tasks**.
- Create the checkout with `X-Connected-Account-ID`. **Omitting the header silently routes the charge to your balance** — the request succeeds either way, so this is a funds-misrouting bug, not an error.
- `collection.succeeded` arrives with the account as origin; read `organization_id` for the seller.
- A reversal draws the seller's `available_balance`, then `pending_balance`, then records a **debt** against the seller recovered from future settlements. Your platform balance is never debited — you carry recovery risk, not the funds.
- You never hold the charge, so there's nothing to transfer; paying the account means funding it from your own balance separately.
- Taking a platform fee in this shape is **not documented** — contact Bachs before building it.

## Pre-launch checklist

- [ ] Whole loop run in sandbox: create → onboard → `capability.updated` active → collect → settle → transfer → withdraw.
- [ ] All money paths use decimal strings; no `parseFloat` anywhere near an amount.
- [ ] Every transfer and withdrawal carries a deterministic `Idempotency-Key`.
- [ ] Split fires on settlement, not on charge success.
- [ ] Capability re-checked immediately before each money movement.
- [ ] Webhook endpoint registered with `event_source: "connect"`; handler reads the account from `organization_id`.
- [ ] Retries verify with Get Transfer / Get Withdrawal before re-sending.
- [ ] Hold window configured against the dispute window, not the settlement date.
- [ ] Live swap is base URL + `sk_live_` key only — no other diff.
