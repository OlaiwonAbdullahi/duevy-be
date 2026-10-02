# Duevy Backend

REST API for **Duevy**, a dues collection platform for Nigerian universities. Students join their department or association with a join code and pay its dues. Reps collect the money and withdraw it.

Payments run on **Bachs Connect** ([docs.bachs.io](https://docs.bachs.io)). Launch is LAUTECH only, but the data model is multi-school.

- API reference: [`API.md`](API.md)
- How the Bachs integration works, and the open questions: [`docs/BACHS.md`](docs/BACHS.md)

## Tech stack

- **Runtime:** Node.js 20+, TypeScript, Express 5
- **Database:** PostgreSQL (Supabase) through Prisma
- **Validation:** Zod for request bodies and env vars
- **Auth:** JWT access tokens plus httpOnly refresh cookies (jose, bcrypt)
- **Payments:** Bachs Connect, behind a provider interface in `src/providers/payment`
- **Jobs:** a database-backed queue for webhooks plus a reconciliation sweep. No Redis is required.
- **Logging:** pino (structured JSON), with sensitive fields redacted
- **Email:** Resend
- **Tests:** Vitest. Integration tests run against a throwaway embedded Postgres.

## How money moves

1. **Rep onboarding.** A rep signs up, their application is `pending`, and an admin approves it, which sets `isRep`.
   - An approved rep can create a space and draft dues straight away.
   - Publishing dues, and so collecting, needs KYC.
2. **KYC.** The rep submits BVN, date of birth and gender. Duevy creates a Bachs **Connect account** for the rep and adds them as its representative.
   - Bachs reviews the submission, and the verdict arrives by webhook.
   - The BVN and date of birth are never stored or logged. Only the status and Bachs's references are kept.
3. **Checkout.** A student picks one or more dues from one space. Duevy computes the amounts:
   - face = the sum of the dues
   - fee = 2% of the face + ₦20
   - total = face + fee

   It then opens a Bachs **destination charge** for the total:
   - `platform_fee` is set to the fee, and the destination is the rep's account.
   - Bachs returns a one-time bank account, and the student pays everything with **one bank transfer**.
4. **Webhook.** `collection.succeeded` marks the dues paid, credits the space's ledger with the face amount, and issues a receipt.
   - Underpaid, overpaid, expired and duplicate events are all handled; see [`docs/BACHS.md`](docs/BACHS.md).
5. **Ledger.** Each space has an append-only ledger, and the balance is always the sum of its entries. A database trigger rejects any UPDATE or DELETE.
6. **Withdrawal.** The rep withdraws to their own bank account. The account name must match the rep's name.
   - Fee: ₦100 under ₦50,000, ₦200 from ₦50,000, deducted from the withdrawal.
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

**Running locally without Bachs.** Set `PAYMENT_PROVIDER=fake`. The fake provider opens fake bank accounts and resolves names instantly, but webhooks still use the real Bachs signature scheme. With `fake`, the seed also KYC-verifies the test rep and creates one paid checkout, so every dashboard has data.

Seeded logins (password `Demo1234!`):

| Who | Email |
|---|---|
| Super admin | `admin@duevy.test` |
| Rep (lead of "Computer Science Department", join code `CSC-LAU1`) | `rep@duevy.test` |
| Student (member of that space) | `student@duevy.test` |

## Environment variables

Every variable is validated at boot in `src/config/env.ts`, and the server refuses to start if a required one is missing. `.env.example` lists them all with comments.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | yes | Postgres. `DIRECT_URL` is the non-pooled URL used for migrations. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | At least 32 characters each. |
| `RESEND_API_KEY` | yes | Email delivery. |
| `PAYMENT_PROVIDER` | no (`bachs`) | `bachs` or `fake`. `fake` is refused in production. |
| `BACHS_BASE_URL` | no | Sandbox `https://sandbox-api.bachs.io`; live `https://api.bachs.io`. |
| `BACHS_SECRET_KEY` | with `bachs` | `sk_sandbox_…` or `sk_live_…`. |
| `BACHS_WEBHOOK_SECRET` | with `bachs` | The signing secret of the endpoint registered for `/v1/webhooks/bachs`. |
| `BACHS_WEBHOOK_SECRET_PREVIOUS` | no | The outgoing secret during a 24h rotation. |
| `WEBHOOK_TOLERANCE_SECONDS` | no (300) | Maximum age of a signed delivery. |
| `CHECKOUT_EXPIRY_MINUTES` | no (60) | Lifetime of a checkout's bank account, 1–1440. |
| `RUN_WORKERS` | no (`true`) | Run the webhook worker and reconciliation inside the API. Set `false` and run `npm run worker` separately. |
| `LOG_LEVEL` | no (`info`) | pino level. |
| `ENCRYPTION_KEY` | recommended | Encrypts stored bank account numbers. |
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
- **KYC.** Submit, then a webhook confirms. The test also checks that the BVN and date of birth appear nowhere in the database. Publishing dues is blocked until the rep is verified.

## Testing webhooks locally

`scripts/send-test-webhook.ts` posts a correctly signed Bachs-format event, signed with `BACHS_WEBHOOK_SECRET`, to the running API:

```bash
# Start a checkout as the seeded student, then pay it:
npm run webhook:test -- paid      DVY-XXXX-XXXX 6650        # amount in naira = the checkout total
npm run webhook:test -- underpaid DVY-XXXX-XXXX 3000 6650
npm run webhook:test -- overpaid  DVY-XXXX-XXXX 7000 6650
npm run webhook:test -- expired   DVY-XXXX-XXXX
npm run webhook:test -- payout-paid   WD-2026-XXXXXX
npm run webhook:test -- payout-failed WD-2026-XXXXXX
npm run webhook:test -- identity  acct_fake_seed_rep        # makes the API re-read KYC state
EVENT_ID=evt_same npm run webhook:test -- paid DVY-XXXX-XXXX 6650   # repeat to test dedupe
```

`WEBHOOK_URL` overrides the target (the default is `http://localhost:$PORT/v1/webhooks/bachs`).

**Against the Bachs sandbox:**

1. Expose the API with a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
2. In the Bachs dashboard, register `https://<tunnel>/v1/webhooks/bachs` with **`event_source: all`**. Without it, Connect events such as KYC and capability changes never arrive.
3. Put the endpoint's signing secret in `BACHS_WEBHOOK_SECRET`.
4. For sandbox payments, Bachs's custom checkout `confirm` accepts `simulated_outcome` (`success`, `failed` or `underpaid`). `POST /v1/webhooks/replay` re-sends an event.

The webhook route only verifies the signature, stores the event (deduplicated by Bachs's event id) and returns 200. Processing happens in `src/jobs/webhookWorker.ts`. Events that keep failing land in `dead` and show on `GET /v1/admin/health`.

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
├── providers/payment/               PaymentProvider interface + Bachs and fake implementations
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
- **Anchor-era columns** (`anchor*`, `kycTier`, the remittance fields) are kept read-only. Payouts and webhook events from before the cutover are tagged `provider = 'anchor'`, and the Bachs reconciliation never touches them. See [`docs/BACHS.md`](docs/BACHS.md) for cutover steps.
