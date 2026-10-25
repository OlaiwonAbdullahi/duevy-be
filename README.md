# Duevy Backend

REST API for **Duevy**, a dues collection platform for Nigerian universities. Students join their department or association with a join code and pay its dues. Reps collect the money and withdraw it.

Payments run on **Kredi Pay** ([documentation.thekredibank.com](https://documentation.thekredibank.com)); rep identity checks run on **Didit** ([docs.didit.me](https://docs.didit.me)). Launch is LAUTECH only, but the data model is multi-school.

- API reference: [`API.md`](API.md)
- How the Kredi and Didit integrations work, and the open questions: [`docs/KREDI.md`](docs/KREDI.md)

## Tech stack

- **Runtime:** Node.js 20+, TypeScript, Express 5
- **Database:** PostgreSQL (Supabase) through Prisma
- **Validation:** Zod for request bodies and env vars
- **Auth:** JWT access tokens plus httpOnly refresh cookies (jose, bcrypt)
- **Payments:** Kredi Pay, behind a provider interface in `src/providers/payment`
- **Rep identity:** Didit (phone OTP, BVN match), behind an interface in `src/providers/identity`
- **Jobs:** a database-backed queue for webhooks plus a reconciliation sweep. No Redis is required.
- **Logging:** pino (structured JSON), with sensitive fields redacted
- **Email:** Resend
- **Tests:** Vitest. Integration tests run against a throwaway embedded Postgres.

## How money moves

Money is **pooled**: every payment lands in Duevy's Kredi merchant account, and each space's append-only ledger says how much of it belongs to that space.

1. **Rep onboarding.** A rep signs up, their application is `pending`, and an admin approves it, which sets `isRep`.
   - An approved rep can create a space and draft dues straight away.
   - Publishing dues, and so collecting, needs KYC.
2. **KYC.** Gated steps, each needing the one before:
   1. **Phone.** Didit texts a one-time code; entering it makes the number the rep's verified phone. VoIP and disposable numbers are declined, and a number can back only one account.
   2. **BVN.** The rep submits their BVN, date of birth, gender, address and consent, with their student ID card. Didit matches the BVN against their name and date of birth. A BVN can back only one rep account.
   3. **Kredi.** Only then is the rep registered as a Kredi customer, with the verified phone and the matched BVN.
   4. **Student status, by Duevy.** The student ID card is stored privately in ImageKit, and an admin approves it, along with the rep application.
   - The BVN, date of birth and codes are never stored or logged. Only statuses, a keyed one-way BVN fingerprint (`bvnHash`), Didit's request id and the ImageKit file reference are kept.
3. **Checkout.** A student picks one or more dues from one space. Duevy computes the amounts:
   - face = the sum of the dues
   - fee = 1.5% of the face + ₦20, capped at ₦250
   - total = face + fee

   It then opens a Kredi **payment link** for the total, keyed by the checkout reference, and redirects the student to it. Kredi keeps ₦20 per payment.
4. **Webhook.** A successful collection webhook marks the dues paid, credits the space's ledger with the face amount, and issues a receipt.
   - Underpaid, overpaid, late, duplicate and second payments are all handled; see [`docs/KREDI.md`](docs/KREDI.md).
5. **Ledger.** Each space has an append-only ledger, and the balance is always the sum of its entries. A database trigger rejects any UPDATE or DELETE.
6. **Withdrawal.** The rep withdraws to a beneficiary (their own account, a lecturer's, a vendor's), sent with a Kredi Payout V2 transfer from the merchant account.
   - Fee: ₦50 under ₦10,000; ₦120 from ₦10,000 to ₦50,000; ₦200 above ₦50,000. Deducted from the withdrawal; it stays in the merchant account.
   - Name enquiry runs again just before the transfer, and a changed account holder is refused.
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

**Running locally without Kredi, Didit or ImageKit.** Set `PAYMENT_PROVIDER=fake`, `IDENTITY_PROVIDER=fake` and `FILE_STORAGE=memory`. The fake provider opens fake payment links and resolves names instantly, but webhooks still use the real Kredi signature scheme. The fake identity checker accepts the code `123456` and matches every BVN. With `fake`, the seed also KYC-verifies the test rep and creates one paid checkout, so every dashboard has data.

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
| Kredi | test host `https://walletv2-api.test.kredimfb.com` + test keys | live host + live keys |
| Kredi webhook | `APP_BASE_URL` → a tunnel to localhost (e.g. ngrok), or none | `https://api.duevy.app/v1/webhooks/kredi` (also set as the payout webhook on the dashboard) |
| Didit | `sk_test_…` (sandbox: BVN checks always match) | `sk_live_…` |
| JWT secrets | any | their own, never shared with dev |
| Migrations | `npm run db:migrate` (creates them) | `npm run db:deploy` on every deploy (Render build command: `npm ci && npm run db:deploy`) |
| First admin | `npm run db:seed` | `node scripts/create-admin.mjs <email> <name> <password>` |

The server refuses to start with the live Kredi host outside `NODE_ENV=production`, or the test host in production.

Kredi references (customers, payment links, transfers) exist in only one Kredi environment, so test rows must never be copied into the prod database. Reps redo KYC in prod.

Without a dev webhook, payments still settle in dev. The pay page checks Kredi directly, and the reconciliation job runs every minute. KYC needs no webhook: the Didit and Kredi calls answer synchronously.

## Environment variables

Every variable is validated at boot in `src/config/env.ts`, and the server refuses to start if a required one is missing. `.env.example` lists them all with comments.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | yes | Postgres. `DIRECT_URL` is the non-pooled URL used for migrations. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | At least 32 characters each. |
| `RESEND_API_KEY` | yes | Email delivery. |
| `PAYMENT_PROVIDER` | no (`kredi`) | `kredi` or `fake`. `fake` is refused in production. |
| `KREDI_BASE_URL` | with `kredi` | Test `https://walletv2-api.test.kredimfb.com`; live from Kredi. |
| `KREDI_API_KEY`, `KREDI_AUTH_TOKEN` | with `kredi` | From the Kredi dashboard. A new token invalidates the old one. |
| `KREDI_WEBHOOK_SECRET` | with `kredi` | The secret Kredi signs webhooks with. |
| `KREDI_WEBHOOK_SECRET_PREVIOUS` | no | The outgoing secret during a rotation. |
| `IDENTITY_PROVIDER` | no (`didit`) | `didit` or `fake`. `fake` is refused in production. |
| `DIDIT_API_KEY` | with `didit` | `sk_test_…` or `sk_live_…`. |
| `DIDIT_PHONE_CHANNEL` | no (`sms`) | `sms`, `whatsapp`, `telegram` or `voice`. |
| `DIDIT_BVN_SERVICE` | no | The Nigeria BVN service id from the Didit console. |
| `BVN_HASH_PEPPER` | yes (outside tests) | 32+ characters. Keys the one-way BVN fingerprint; never change it once reps have verified. |
| `CHECKOUT_EXPIRY_MINUTES` | no (60) | How long a checkout's payment link is treated as open, 1–1440. |
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

- **Webhook idempotency.** One transfer delivered 5 times, some of them concurrently, racing the reconciliation poll. The result is exactly one paid checkout, one ledger credit per due, and one receipt. A second, different transfer into a paid checkout is flagged for a refund. A forged or missing signature gets 401.
- **Payment outcomes.**
  - Underpaid: nothing is marked paid.
  - Overpaid: the dues are paid at face value and the excess is flagged.
  - Expired: the checkout closes, and money that arrives later is still honoured.
  - Unknown reference: the event is retried with backoff.
- **Ledger.** The balance is derived from entries, a reversal restores it, and UPDATE or DELETE is refused by the database.
- **Withdrawal locking.** With five concurrent requests, exactly one succeeds and the other four get `WITHDRAWAL_IN_PROGRESS`. Also covered: insufficient balance, a provider refusal (balance restored), a timeout (left pending, never assumed failed), payout webhooks, and Idempotency-Key replay and reuse over HTTP.
- **KYC.** Phone OTP, then BVN plus student ID card; Kredi is only called after both Didit checks pass, and collection opens only once an admin approves the card. Also covered: wrong and declined codes, resend throttling, one phone and one BVN per account, mismatches counting as attempts while outages don't, a Kredi outage not re-billing the BVN check, replacing a rejected card, rejecting files that aren't really images or PDFs, and checking that the BVN and date of birth appear nowhere in the database.

## Testing webhooks locally

`scripts/send-test-webhook.ts` posts a correctly signed Kredi-format webhook, signed with `KREDI_WEBHOOK_SECRET`, to the running API:

```bash
# Start a checkout as the seeded student, then pay it (amount in naira):
npm run webhook:test -- paid DVY-XXXX-XXXX 5095          # the checkout total (a ₦5,000 due + ₦95 fee)
npm run webhook:test -- paid DVY-XXXX-XXXX 3000          # short: recorded as underpaid
npm run webhook:test -- payout-paid   WD-2026-XXXXXX 19880   # the net amount sent
npm run webhook:test -- payout-failed WD-2026-XXXXXX 19880
REMIT_REFERENCE=same npm run webhook:test -- paid DVY-XXXX-XXXX 5095   # repeat to test dedupe
```

`WEBHOOK_URL` overrides the target (the default is `http://localhost:$PORT/v1/webhooks/kredi`).

**Against the Kredi test environment:**

1. Expose the API with a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, and set `APP_BASE_URL` to it — payment links carry `${APP_BASE_URL}/v1/webhooks/kredi` as their webhook URL.
2. On the Kredi dashboard (Settings → API/Webhook), set the payout (outward) webhook to the same URL and its secret to `KREDI_WEBHOOK_SECRET`.
3. `POST /api/webhook/test` on Kredi sends a sample collection webhook to any URL.

The webhook route only verifies the signature, stores the event (deduplicated by Kredi's own references) and returns 200. Processing happens in `src/jobs/webhookWorker.ts`. Events that keep failing land in `dead` and show on `GET /v1/admin/health`, which also compares the ledgers with the real merchant balance.

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
├── providers/payment/               PaymentProvider interface + Kredi and fake implementations
├── providers/identity/              IdentityVerifier interface (phone OTP, BVN) + Didit and fake
├── services/                        checkout, ledger, withdrawal, kyc, receipt, webhookProcessor, …
├── jobs/                            webhookWorker (DB queue), reconciliation (backstop for lost webhooks)
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
- **Anchor-era columns** (`anchor*`, `kycTier`, the remittance fields) are kept read-only. Payouts and webhook events from before the cutover are tagged `provider = 'anchor'`, and reconciliation never touches them. Bachs-era rows keep `provider = 'bachs'`. See [`docs/KREDI.md`](docs/KREDI.md).
