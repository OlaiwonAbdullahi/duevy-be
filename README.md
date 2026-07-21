# Duevy Backend

REST API powering **Duevy** — a dues collection platform for Nigerian university departments/classes. Handles auth, spaces (departments/classes), dues collection, payments (Paystack/Monnify), payouts to reps, polls, referrals, disputes, notifications, and an AI chat assistant ("Duey").

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript
- **Framework**: Express 5
- **Database**: PostgreSQL via Prisma ORM (designed for Supabase)
- **Cache/Queue**: Redis (via BullMQ / reconciliation jobs), run through Docker Compose
- **Auth**: JWT (access + refresh tokens via `jose`), bcrypt password hashing
- **Payments**: Paystack and Monnify (both fully implemented, toggled via env var)
- **Email**: Resend
- **AI Assistant**: pluggable LLM provider — Ollama (local), Gemini, or any OpenAI-compatible hosted endpoint
- **Validation**: Zod
- **Testing**: Vitest

## Prerequisites

- Node.js **20+** and npm
- Docker (for local Redis) — or a reachable Redis instance
- A PostgreSQL database (the project is set up for [Supabase](https://supabase.com), but any Postgres works)
- A [Resend](https://resend.com) API key (required — used for transactional email)
- A [Paystack](https://paystack.com) or [Monnify](https://monnify.com) account (test/sandbox keys are fine for local dev)
- (Optional) [Ollama](https://ollama.com) running locally if you want to use the AI assistant with the default `ollama` provider

## Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd duevy-backend
npm install
```

`npm install` runs `postinstall` automatically, which runs `prisma generate` + `tsc` (the build script). This is expected — you don't need to build manually before `npm run dev`.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Then fill in `.env`. At minimum you need:

| Variable | Notes |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Postgres connection strings. `DIRECT_URL` is used for migrations (non-pooled). |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Min 32 chars each. Generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `RESEND_API_KEY` | Required — from [resend.com/api-keys](https://resend.com/api-keys) |
| `PAYMENT_GATEWAY` | `paystack` (default) or `monnify` |
| `PAYSTACK_SECRET_KEY` | Required if `PAYMENT_GATEWAY=paystack` |
| `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE`, `MONNIFY_WEBHOOK_SECRET` | Required if `PAYMENT_GATEWAY=monnify` |
| `REDIS_URL` | Defaults to `redis://localhost:6379` (matches `docker-compose.yml`) |

Everything else in `.env.example` has a sensible default or is optional (Google Sign-In, encryption key overrides, LLM provider config, etc.) — see the inline comments in `.env.example` for details. Env vars are validated on boot via Zod (`src/config/env.ts`); the server refuses to start if something required is missing or malformed.

### 3. Start Redis

```bash
docker compose up -d
```

This starts Redis on `localhost:6379` with a persisted volume.

### 4. Set up the database

```bash
npm run db:migrate   # applies Prisma migrations, generates the client
npm run db:seed       # optional — seeds initial data
```

Use `npm run db:studio` any time to browse the database in Prisma Studio.

### 5. Run the dev server

```bash
npm run dev
```

The API starts at `http://localhost:3000`, with all routes mounted under `/v1` (e.g. `http://localhost:3000/v1/auth/login`). A health check is available at `GET /health`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server with hot reload (`tsx watch`) |
| `npm run build` | Generate Prisma client + compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) — use in production |
| `npm run lint` | Lint `src/` with ESLint |
| `npm run format` | Format `src/` with Prettier |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:migrate` | Run/create Prisma migrations (dev) |
| `npm run db:push` | Push schema changes without a migration |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Run `prisma/seed.ts` |

There's also `scripts/create-admin.mjs` for provisioning an admin user, and one-off scripts under `prisma/` (`backfillSubaccounts.ts`, `convertWalletBalances.ts`, `notifyBalanceConversion.ts`) for data migrations — run with `tsx prisma/<script>.ts`.

## Project Structure

```
src/
├── app.ts              # Express app: middleware, CORS, routing, error handling
├── server.ts            # Entry point: connects DB, starts server + background jobs
├── config/              # env validation, db client, assistant system prompt
├── routes/               # one file per resource (auth, dues, payouts, polls, ...)
├── services/             # business logic (auth, payments, payouts, polls, referrals, assistant)
├── middleware/            # auth guard, rate limiting, error handling
├── lib/                   # gateway clients (Paystack/Monnify), email, PDF, LLM adapters
├── jobs/                  # background jobs (payment reconciliation)
└── types/                 # shared TypeScript types

prisma/
└── schema.prisma          # data model (users, spaces, dues, payments, payouts, polls, ...)
```

Key domain concepts: a **Space** is a department/class; a **SpaceRep** collects **Dues** from members via **DuePayment**s; payments flow through Paystack or Monnify and reconcile into **Transaction**s; reps request **Payout**s to their **BankAccount**.

## API Documentation

- [`docs/FRONTEND_API_GUIDE.md`](docs/FRONTEND_API_GUIDE.md) — guide for frontend consumers
- [`docs/ASSISTANT_API_GUIDE.md`](docs/ASSISTANT_API_GUIDE.md) — Duey (AI assistant) integration guide

## Notes

- Payment gateway is swappable via `PAYMENT_GATEWAY` env var — both Paystack and Monnify implementations are kept fully working (`src/lib/paystack.ts`, `src/lib/monnify.ts`, selected in `src/lib/paymentGateway.ts`).
- The AI assistant (`src/services/assistant.service.ts`) is provider-agnostic — switch between `ollama`, `gemini`, and any OpenAI-compatible `hosted` endpoint via `LLM_PROVIDER` with no code changes.
- Uploaded files (avatars, nominee images) are served statically from `/uploads`.
