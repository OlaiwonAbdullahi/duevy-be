# Duevy Backend

REST API for **Duevy**, a dues collection platform for Nigerian universities. Students join their department or association with a join code and pay its dues. Reps collect the money and withdraw it.

Payments run on **Bank78** ([public API docs](https://78financials-bank78.github.io/bank78-public-api-docs/)); rep KYC runs on **Didit** ([docs.didit.me](https://docs.didit.me)). Launch is LAUTECH only, but the data model is multi-school.

- API reference: [`API.md`](API.md)

## Tech stack

- **Runtime:** Node.js 20+, TypeScript, Express 5
- **Database:** PostgreSQL (Supabase) through Prisma
- **Validation:** Zod for request bodies and env vars
- **Auth:** JWT access tokens plus httpOnly refresh cookies (jose, bcrypt)
- **Payments:** Bank78, behind a provider interface in `src/providers/payment`
- **KYC:** Didit (phone OTP + NIN database validation), `src/lib/didit.ts`
- **Jobs:** a database-backed queue for webhooks plus a reconciliation sweep. No Redis is required.
- **Logging:** pino (structured JSON), with sensitive fields redacted
- **Email:** Resend
- **Tests:** Vitest. Integration tests run against a throwaway embedded Postgres.

## How money moves

1. **Rep onboarding.** A rep signs up, their application is `pending`, and an admin approves it, which sets `isRep`.
   - An approved rep can create a space and draft dues straight away.
   - Publishing dues, and so collecting, needs KYC.
2. **KYC.** Three checks, all needed before the rep's spaces can collect:
   - **Phone, by Didit.** The rep enters their Nigerian mobile number, Didit texts a one-time code, and the rep confirms it. Virtual, disposable and already-used numbers are refused.
   - **Identity, by Didit.** The rep submits their NIN, BVN, date of birth and gender. Didit checks each number, with the name and date of birth, against the registries there and then. Approval opens the rep's **wallet**: a Bank78 sub-account (Bank78 requires the BVN for it).
   - **Student status, by Duevy.** In the same submission the rep uploads their student ID card. It is stored privately in ImageKit, and an admin approves or rejects it.
   - The NIN, BVN, date of birth and OTP code are never stored or logged. Only the statuses, Didit's request id, the wallet account number and the ImageKit file reference are kept.
3. **Checkout.** A student picks one or more dues from one space. Duevy computes the amounts:
   - face = the sum of the dues
   - fee = 1.5% of the face + Bank78's collection fee (0 until Bank78 publishes one; `bank78CollectionFee` in `src/lib/money.ts`)
   - total = face + fee

   It then opens a Bank78 **dynamic virtual account** for exactly the total (amount constraint: Exact). The student pays everything with **one bank transfer**, which lands in Duevy's Bank78 merchant account.
4. **Webhook.** `virtual-nuban-transaction-credit` marks the dues paid, credits the space's ledger with the face amount, and issues a receipt. Duplicate deliveries, a second credit, money after expiry and short or long credits are all handled.
5. **Routing.** The face amount is then transferred from the merchant account into the lead rep's wallet; Duevy's fee stays behind. Reconciliation retries a transfer that didn't go through.
6. **Ledger.** Each space has an append-only ledger, and the balance is always the sum of its entries. A database trigger rejects any UPDATE or DELETE.
7. **Withdrawal.** The rep withdraws from their wallet to any beneficiary account.
   - No Duevy fee for now. Bank78 charges its own transfer fee on top, which is debited from the ledger when the withdrawal succeeds. The last fee Bank78 charged is held back from the balance so a whole-balance withdrawal can still pay it.
   - Safeguards: the request needs an idempotency key, the space is locked, and only one withdrawal can be in flight.
   - The amount is debited from the ledger when the withdrawal is created. If it fails or is reversed, it is credited back.

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

**Running locally.** Use the Bank78 sandbox and a Didit sandbox key; `FILE_STORAGE=memory` stands in for ImageKit. The seed leaves the test rep unverified, so KYC runs for real. `npm run smoke:bank78` checks the Bank78 credentials and every call Duevy makes against the sandbox.

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
| Bank78 | `https://sandbox.bank78.co` + sandbox credentials | `https://api.bank78.co` + live credentials |
| Bank78 webhook | sandbox merchant profile → a tunnel to localhost (e.g. ngrok), or none | live merchant profile → `https://api.duevy.app/v1/webhooks/bank78`, API version 2 |
| Didit | sandbox application key | live application key |
| JWT secrets | any | their own, never shared with dev |
| Migrations | `npm run db:migrate` (creates them) | `npm run db:deploy` on every deploy (Render build command: `npm ci && npm run db:deploy`) |
| First admin | `npm run db:seed` | `node scripts/create-admin.mjs <email> <name> <password>` |

The server refuses to start against live Bank78 (`api.bank78.co`) outside `NODE_ENV=production`, unless `BANK78_ALLOW_LIVE_OUTSIDE_PRODUCTION=true` is set deliberately.

Bank78 accounts (wallets, virtual accounts) exist in only one Bank78 environment, so sandbox rows must never be copied into the prod database. Reps redo KYC in prod.

Bank78 has no "was this account paid" lookup, so **payments only settle by webhook**: in dev, point the sandbox merchant profile at a tunnel, or use `npm run webhook:test`. Reconciliation expires unpaid checkouts, retries routing to wallets and re-queries withdrawals.

## Environment variables

Every variable is validated at boot in `src/config/env.ts`, and the server refuses to start if a required one is missing. `.env.example` lists them all with comments.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | yes | Postgres. `DIRECT_URL` is the non-pooled URL used for migrations. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | At least 32 characters each. |
| `RESEND_API_KEY` | yes | Email delivery. |
| `BANK78_BASE_URL` | no (sandbox) | Sandbox `https://sandbox.bank78.co`; live `https://api.bank78.co`. |
| `BANK78_CLIENT_ID`, `BANK78_CLIENT_SECRET`, `BANK78_API_KEY` | yes | Merchant dashboard → API Credentials. |
| `BANK78_WEBHOOK_SECRET` | yes | The Webhook Secret on the merchant profile, for `/v1/webhooks/bank78`. |
| `BANK78_WEBHOOK_SECRET_PREVIOUS` | no | The outgoing secret during a rotation. |
| `BANK78_ALLOW_LIVE_OUTSIDE_PRODUCTION` | no (`false`) | Allow live Bank78 outside `NODE_ENV=production`. |
| `DIDIT_API_KEY` | yes | Didit application API key (rep KYC). |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me`. |
| `WEBHOOK_TOLERANCE_SECONDS` | no (300) | Maximum age of a signed delivery. |
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

- **Webhook idempotency.** One credit delivered 5 times, some of them concurrently. The result is exactly one paid checkout, one ledger credit per due, and one receipt. A forged signature gets 401.
- **Routing.** A paid checkout's face amount reaches the rep's wallet exactly once, even when two attempts race; a failed transfer is retried by reconciliation.
- **Payment outcomes.**
  - A second credit on a paid checkout: flagged for review, not applied again.
  - Short credit: nothing is marked paid. Long credit: paid at face value, excess flagged.
  - Expired: money that arrives later is still honoured, and flagged.
  - Unknown reference: the event is retried with backoff.
- **Ledger.** The balance is derived from entries, a reversal restores it, and UPDATE or DELETE is refused by the database.
- **Withdrawal locking.** With five concurrent requests, exactly one succeeds and the other four get `WITHDRAWAL_IN_PROGRESS`. Also covered: insufficient balance, a provider refusal (balance restored), a timeout (left pending, never assumed failed), payout webhooks, and Idempotency-Key replay and reuse over HTTP.
- **KYC.** Phone OTP, then NIN + BVN plus student ID card; Didit decides both numbers, the wallet opens, and collection opens only once an admin approves the card. Also covered: NIN before phone is refused, wrong/declined/blocked codes, a declined BVN, the 3-strikes retry lock (no BVN check once the NIN fails), Didit being down (503, not counted), a failed wallet retried by resubmitting, replacing a rejected card, rejecting files that aren't really images or PDFs, and checking that the NIN and date of birth appear nowhere in the database.

## Testing webhooks locally

`scripts/send-test-webhook.ts` posts a correctly signed Bank78 (API v2) event, signed with `BANK78_WEBHOOK_SECRET`, to the running API:

```bash
# Start a checkout as the seeded student, then pay it:
npm run webhook:test -- paid         DVY-XXXX-XXXX 5075        # amount in naira = the checkout total
npm run webhook:test -- payout-paid  WD-2026-XXXXXX 50         # Bank78's fee in naira
npm run webhook:test -- wrong-amount DVY-XXXX-XXXX 5000 5075   # Bank78 refusing a wrong amount (ignored)
SESSION_ID=same npm run webhook:test -- paid DVY-XXXX-XXXX 5075   # repeat to test dedupe
```

`WEBHOOK_URL` overrides the target (the default is `http://localhost:$PORT/v1/webhooks/bank78`).

**Against the Bank78 sandbox:**

1. `npm run smoke:bank78` — token, bank list, name enquiry, a wallet, a dynamic account, sandbox funding, routing and a payout, each reported PASS/FAIL. It always uses the sandbox host.
2. Expose the API with a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
3. On the sandbox merchant profile set the Webhook URL to `https://<tunnel>/v1/webhooks/bank78`, set a Webhook Secret (put it in `BANK78_WEBHOOK_SECRET`) and choose API version 2.
4. Fund a checkout's account with Bank78's sandbox `POST /virtual-nuban/api/transaction-notification-fund`; the credit webhook follows.

`npm run smoke:didit -- <phone> [nin bvn first last YYYY-MM-DD]` sends a real OTP and checks it, and optionally validates a NIN and a BVN.

The webhook route only verifies the signature, stores the event (deduplicated by its stable reference: the credit's `sessionId`, the transfer's `reference`) and returns 200. Processing happens in `src/jobs/webhookWorker.ts`. Events that keep failing land in `dead` and show on `GET /v1/admin/health`.

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
| `npm run smoke:bank78` | Exercise every Bank78 call against the sandbox |
| `npm run smoke:didit -- …` | Send and check a real Didit OTP; optionally a NIN check |

## Project structure

```
src/
├── app.ts / server.ts / worker.ts   Express app, API entry point, standalone worker entry point
├── config/                          env validation, Prisma client
├── providers/payment/               PaymentProvider interface + the Bank78 implementation
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
- **Anchor-era columns** (`anchor*`, `kycTier`, the remittance fields) are kept read-only. Payouts and webhook events from before the cutover are tagged `provider = 'anchor'` (or `'bachs'`), and reconciliation never touches them.
