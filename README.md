# Duevy Backend

REST API for **Duevy**, a dues collection platform for Nigerian universities. Students join their department or association with a join code and pay its dues. Reps collect the money and withdraw it.

Payments run on **9jaPay** virtual accounts ([docs.9japay.com](https://docs.9japay.com)); rep identity is checked by **Didit** against NIMC ([docs.didit.me](https://docs.didit.me)). Launch is LAUTECH only, but the data model is multi-school.

- API reference: [`API.md`](API.md)
- How the 9jaPay integration works, the cutover runbook and the open questions: [`docs/NINEJAPAY.md`](docs/NINEJAPAY.md)
- The previous rail, kept for history: [`docs/BACHS.md`](docs/BACHS.md)

## Tech stack

- **Runtime:** Node.js 20+, TypeScript, Express 5
- **Database:** PostgreSQL (Supabase) through Prisma
- **Validation:** Zod for request bodies and env vars
- **Auth:** JWT access tokens plus httpOnly refresh cookies (jose, bcrypt)
- **Payments:** 9jaPay, behind a provider interface in `src/providers/payment`
- **Identity:** Didit NIN checks, behind `src/providers/identity`
- **Jobs:** a database-backed queue for webhooks plus a reconciliation sweep. No Redis is required.
- **Logging:** pino (structured JSON), with sensitive fields redacted
- **Email:** Resend
- **Tests:** Vitest. Integration tests run against a throwaway embedded Postgres.

## How money moves

1. **Rep onboarding.** A rep signs up, their application is `pending`, and an admin approves it, which sets `isRep`.
   - An approved rep can create a space and draft dues straight away.
   - Publishing dues, and so collecting, needs KYC.
2. **KYC.** Two checks, both needed before the rep's spaces can collect:
   - **Identity, by Didit.** The rep submits their NIN and date of birth; Didit checks them against NIMC under the rep's name, there and then. A match verifies the rep; a partial match goes to an admin; no match counts as a failed attempt (3 lock retries for 24 hours).
   - **Student status, by Duevy.** In the same submission the rep uploads their student ID card. It is stored privately in ImageKit, and an admin approves or rejects it.
   - The NIN and date of birth are never stored or logged. Only the outcome, Didit's request id and the ImageKit file reference are kept.
   - The money is the space's, not the rep's. KYC records who is accountable for running the space; a new rep verifies before they can act.
3. **Checkout.** A student picks one or more dues from one space. Duevy computes the amounts:
   - face = the sum of the dues
   - fee = 1.5% of the face (a processing fee covering 9jaPay's charges)
   - total = face + fee

   9jaPay opens a one-time account that accepts exactly the total, and the student pays everything with **one bank transfer**. It settles into Duevy's business account.
4. **Webhook.** 9jaPay's `new_transaction` prompts Duevy to read the account's transactions back from 9jaPay; then the dues are marked paid, the space's ledger is credited with the face amount, and a receipt is issued.
   - Underpaid, overpaid, late and duplicate payments are all handled; see [`docs/NINEJAPAY.md`](docs/NINEJAPAY.md).
5. **Ledger.** Each space has an append-only ledger, and the balance is always the sum of its entries. A database trigger rejects any UPDATE or DELETE.
6. **Sweep.** Each space has its own permanent 9jaPay account. Once a day (and whenever a withdrawal needs it) the space's collections are moved from Duevy's account into it. Duevy pays for the move out of the processing fee; the space's balance doesn't change.
7. **Withdrawal.** A rep withdraws the space's money from the space's account to one of its beneficiaries (the department's account, a vendor's, a rep's).
   - Fee: 9jaPay's transfer charge, ₦10 / ₦15 / ₦20 by amount, deducted from the withdrawal.
   - A space account moves at most ₦10M a day.
   - Safeguards: the request needs an idempotency key, the space is locked, and only one withdrawal can be in flight.
   - The amount is debited from the ledger when the withdrawal is created. If it fails or is reversed, the full amount is credited back.

All money is integer kobo. Fees are always computed on the server.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in, see "Environment variables"
npm run db:deploy         # apply migrations (npm run db:migrate in development)
npm run db:seed           # super admin, test rep, test student, a space with dues
npm run dev               # http://localhost:3000, all routes under /v1
```

`npm install` runs `postinstall`, which runs the build (`prisma generate` + `tsc`).

**Running locally without 9jaPay, Didit or ImageKit.** Set `PAYMENT_PROVIDER=fake`, leave `DIDIT_API_KEY` unset and set `FILE_STORAGE=memory`. The fake provider opens fake bank accounts and resolves names instantly, and every NIN matches, but webhooks still use the real 9jaPay signature scheme. With `fake`, the seed also KYC-verifies the test rep and creates one paid checkout, so every dashboard has data.

Seeded logins (password `Demo1234!`):

| Who | Email |
|---|---|
| Super admin | `admin@duevy.test` |
| Rep (lead of "Computer Science Department", join code `CSC-LAU1`) | `rep@duevy.test` |
| Student (member of that space) | `student@duevy.test` |

## Dev and prod environments

Two databases and two sets of keys, never mixed:

| | Dev | Prod |
|---|---|---|
| Where it runs | your machine (`npm run dev`) | Render |
| Config | `.env` (gitignored) | Render → Environment |
| Database | dev Postgres (Supabase project `duevy-dev`) | prod Postgres (Supabase project `duevy-prod`) |
| `NODE_ENV` | `development` | `production` |
| 9jaPay | sandbox keys + `https://developer.test.9japay.com` | live keys + the live base URL from 9jaPay |
| 9jaPay webhook | "Test Webhook URL" → a tunnel to localhost (e.g. ngrok), or none | "Live Webhook URL" → `https://api.duevy.app/v1/webhooks/9japay` |
| Didit | sandbox app key | live app key |
| JWT secrets | any | their own, never shared with dev |
| Migrations | `npm run db:migrate` (creates them) | `npm run db:deploy` on every deploy (Render build command: `npm ci && npm run db:deploy`) |
| First admin | `npm run db:seed` | `node scripts/create-admin.mjs <email> <name> <password>` |

9jaPay account numbers exist in only one 9jaPay environment, so sandbox rows must never be copied into the prod database.

Without a dev webhook, payments still settle in dev: the pay page checks 9jaPay directly, and the reconciliation job (which also runs the daily sweep) runs every minute.

## Environment variables

Every variable is validated at boot in `src/config/env.ts`, and the server refuses to start if a required one is missing. `.env.example` lists them all with comments.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | yes | Postgres. `DIRECT_URL` is the non-pooled URL used for migrations. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | At least 32 characters each. |
| `RESEND_API_KEY` | yes | Email delivery. |
| `PAYMENT_PROVIDER` | no (`ninejapay`) | `ninejapay` or `fake`. `fake` is refused in production. |
| `NINEJAPAY_BASE_URL` | no | Sandbox `https://developer.test.9japay.com`; live from 9jaPay. |
| `NINEJAPAY_API_KEY`, `NINEJAPAY_SECRET_KEY` | with `ninejapay` | From the 9jaPay dashboard. The secret key also verifies webhooks. |
| `NINEJAPAY_BUSINESS_ACCOUNT_NUMBER` | with `ninejapay` | The dashboard's "Collection Account Number": where collections settle and sweeps start. Its name is looked up from 9jaPay. |
| `NINEJAPAY_BANK_CODE` | no (`090629`) | 9jaPay's bank code, for transfers into space accounts. |
| `SWEEP_MIN_KOBO` | no (100000) | Unswept collections below this wait for the next day. |
| `DIDIT_API_KEY` | with `ninejapay` | Rep NIN checks. Unset with `fake` = an in-memory verifier. |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me`. |
| `CHECKOUT_EXPIRY_MINUTES` | no (60) | Lifetime of a checkout's bank account, 1–1440. |
| `RUN_WORKERS` | no (`true`) | Run the webhook worker and reconciliation inside the API. Set `false` and run `npm run worker` separately. |
| `LOG_LEVEL` | no (`info`) | pino level. |
| `ENCRYPTION_KEY` | recommended | Encrypts stored bank account numbers. |
| `FILE_STORAGE` | no (`imagekit`) | `imagekit`, or `memory` for tests and local dev (refused in production). |
| `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT` | with `imagekit` | Private storage for student ID cards. |
| `IMAGEKIT_KYC_FOLDER` | no (`/duevy/kyc`) | Folder the KYC documents go in. |
| `FEATURE_POLLS`, `FEATURE_ASSISTANT`, `FEATURE_REFERRALS` | no (`false`) | Features outside the MVP. Paid voting stays off. |

Google sign-in, CORS, cookies and LLM settings are documented inline in `.env.example`.

## Testing

```bash
npm test            # unit tests: fees, kobo/decimal conversion, signatures, event parsing, state machines
npm run test:int    # integration tests against a real, throwaway Postgres
npm run test:all    # both
```

`test:int` downloads and starts an embedded Postgres (`embedded-postgres`) and applies the real migration chain to it. That also proves the migrations apply from a clean baseline. It never touches the `DATABASE_URL` in `.env`. To use an existing **empty** database instead (for example in CI), set `TEST_DATABASE_URL`.

What the integration suite covers:

- **Webhook idempotency.** One event delivered 5 times, some of them concurrently, plus the same outcome under a second event id. The result is exactly one paid checkout, one ledger credit per due, and one receipt. A forged signature gets 401.
- **Payment outcomes.**
  - Underpaid: nothing is marked paid.
  - Overpaid: the dues are paid at face value and the excess is flagged.
  - Expired: the checkout closes, and money that arrives later is still honoured.
  - Unknown reference: the event is retried with backoff.
- **Ledger.** The balance is derived from entries, a reversal restores it, and UPDATE or DELETE is refused by the database.
- **Withdrawal locking.** With five concurrent requests, exactly one succeeds and the other four get `WITHDRAWAL_IN_PROGRESS`. Also covered: insufficient balance, a provider refusal (balance restored), a timeout (left pending, never assumed failed), payout webhooks, and Idempotency-Key replay and reuse over HTTP.
- **KYC.** NIN, date of birth and student ID card in one multipart submission; the NIN check answers at once and an admin approves the card, and collection opens only when both are done. Also covered: a partial match approved or rejected by an admin, a no-match using up attempts while an outage doesn't, a Bachs-verified rep carried over, replacing a rejected card (the old file is deleted), rejecting files that aren't really images or PDFs, and checking that the NIN and date of birth appear nowhere in the database.
- **Sweeps.** The daily sweep moves a space's collections into its own account once a day without touching its balance; a withdrawal sweeps what it needs first; a failed sweep fails the waiting withdrawal and restores the balance; the ₦10M daily limit stops both sweeps and withdrawals.

## Testing webhooks locally

`scripts/send-test-webhook.ts` posts a correctly signed 9jaPay-format event, signed with `NINEJAPAY_SECRET_KEY`, to the running API:

```bash
# Start a checkout as the seeded student, then report a payment into its one-time account:
npm run webhook:test -- paid     DVY-XXXX-XXXX <accountNumber> 5075   # amount in naira = the checkout total
npm run webhook:test -- credited <spaceId> <spaceAccountNumber> 5000  # a sweep landing in a space account
npm run webhook:test -- transfer WD-2026-XXXXXX Success               # or a sweep reference; Success | Failed
EVENT_ID=evt_same npm run webhook:test -- transfer WD-2026-XXXXXX Success   # repeat to test dedupe
```

Handlers never trust the event: each asks the provider what happened. Against the fake provider that means setting its state first (see `src/test/integration/fixtures.ts`, `payCheckout`). `WEBHOOK_URL` overrides the target (the default is `http://localhost:$PORT/v1/webhooks/9japay`).

**Against the 9jaPay sandbox:**

1. Expose the API with a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
2. In the 9jaPay dashboard (Settings → Developer), set the Test Webhook URL to `https://<tunnel>/v1/webhooks/9japay`.
3. Simulate a student's transfer with `POST /v1/api/transactions/simulate-deposit` on the sandbox (needs the `authKey` 9jaPay issues).

The webhook route only verifies the signature, stores the event (deduplicated by its id) and returns 200. Processing happens in `src/jobs/webhookWorker.ts`. Events that keep failing land in `dead` and show on `GET /v1/admin/health`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` / `npm run dev:worker` | API / standalone worker, with hot reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled API |
| `npm run worker` | Run the compiled worker (webhook queue + reconciliation) |
| `npm test`, `npm run test:int`, `npm run test:all` | Tests |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:migrate` | Create and apply migrations (development) |
| `npm run db:seed` | Seed development data. Refuses to run in production. |
| `npm run db:studio` | Prisma Studio |
| `npm run webhook:test -- …` | Send a signed test webhook |

## Project structure

```
src/
├── app.ts / server.ts / worker.ts   Express app, API entry point, standalone worker entry point
├── config/                          env validation, Prisma client
├── providers/payment/               PaymentProvider interface + 9jaPay and fake implementations
├── providers/identity/              NIN checks: Didit + fake
├── services/                        checkout, ledger, sweep, withdrawal, kyc, receipt, webhookProcessor, …
├── jobs/                            webhookWorker (DB queue), reconciliation (backstop for lost webhooks, daily sweep)
├── routes/                          one router per resource
├── middleware/                      auth, idempotency, rate limits, validation, errors
├── lib/                             money (kobo + fees), state machines, logger, …
└── test/                            unit test setup, integration fixtures
prisma/
├── schema.prisma
├── migrations/
└── seed.ts
```

## Notes

- **Out of MVP scope:** polls, the assistant, referrals and co-rep features exist behind feature flags, but their payment paths are disabled. This includes paid voting and discount codes at checkout. The payout approval quorum is gone.
- **Earlier rails' columns** (`anchor*`, `kycTier`, `bachs*`, `payoutDestination*`, the remittance and fee-settlement fields) are kept read-only. Rows from before each cutover keep `provider = 'anchor'` or `'bachs'`, and reconciliation only touches the current provider's. See [`docs/NINEJAPAY.md`](docs/NINEJAPAY.md) for the Bachs → 9jaPay cutover.
