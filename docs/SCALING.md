# Scaling & performance — audit, changes, and what's left

November 2026. Branch `feat/9japay-didit`. Covers the backend only (this repo).

## 1. Architecture as found

- **One Express 5 process** (`src/server.ts`) on a single VPS container behind Caddy (`docker-compose.yml`), Postgres on Supabase via its pooler, Prisma 5.
- **Background work runs in the same process** by default (`RUN_WORKERS=true`): the webhook queue (polls every 2s), reconciliation (every 60s: pending checkouts, payouts, sweeps, daily sweeps, guest invites), and KYC reminder emails (hourly). `src/worker.ts` runs these on their own.
- **No Redis.** The webhook queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`. Rate limits use `express-rate-limit`'s in-memory store. (`bullmq` is in `package.json` but nothing imports it.)
- **Money paths are already built for concurrency:** checkout creation is serialised per student (advisory lock); every outcome (`fulfilCheckout`, `markUnderpaid`, `expireCheckout`, payouts, sweeps) row-locks and checks a state machine. The ledger is append-only with unique keys per `(type, duePaymentId)` / `(type, payoutId)`, and balances are derived, never stored. Webhooks are deduplicated on `(provider, providerEventId)`, and handlers re-read the truth from 9jaPay instead of trusting the event body. Payouts and sweeps rely on 9jaPay refusing a duplicate reference.
- **Queries had already had a performance pass:** lists are paginated in the database, aggregates use `groupBy`, and there are no N+1 loops on hot paths.

The design was sound. The bottlenecks were CPU on the event loop, a few per-process assumptions that break with more than one instance, and operational gaps.

## 2. Findings, by impact

| # | Finding | Impact | Status |
|---|---|---|---|
| 1 | Password hashing (`bcryptjs`, cost 12) ran in pure JS **on the event loop**: 273 ms of CPU per login. | One process handled ~3.6 logins/s **in total**, and every other request (webhooks included) stalled behind it. This was the collapse point under load (see §4). | **Fixed** |
| 2 | Login timing equaliser hashed at cost 10 while real hashes are cost 12. | An unknown email answered ~4× faster, which lets anyone enumerate registered accounts. | **Fixed** |
| 3 | `checkouts.vaAccountNumber` (looked up on **every** payment webhook) had no index. | Sequential scan of the checkouts table per payment; grows linearly with history. | **Fixed** |
| 4 | Pay-page status poll: 4–5 sequential queries per poll, and its "ask 9jaPay at most every 10s" throttle was an in-process `Map`. | With N instances, provider calls multiplied by N; the map was also cleared wholesale at 5,000 entries. | **Fixed** |
| 5 | Webhook worker processed a claimed batch one event at a time; each event is a 9jaPay round trip (up to 20s). | A collection-day burst queued for minutes before students saw "paid". | **Fixed** |
| 6 | Shutdown called `process.exit` without draining; the Dockerfile's `sh -c "… && node …"` could keep SIGTERM from reaching Node; Docker's default 10s grace. | Every deploy killed in-flight requests (502s) and in-progress jobs (money stayed safe, since everything is transactional and idempotent, but work was redone via stale-lock reclaim). | **Fixed** |
| 7 | Node's default 5s keep-alive is shorter than Caddy's 2-minute upstream idle timeout. | Sporadic 502s when Caddy reuses a socket Node is closing. | **Fixed** |
| 8 | `/health` is liveness only; no readiness check. | A load balancer can't drain an instance or detect a dead DB connection. | **Fixed** (`/health/ready` added; `/health` unchanged) |
| 9 | Expired refresh tokens, email verifications and password resets were never deleted. | Unbounded table growth (a row per sign-in, forever). | **Fixed** |
| 10 | Public metrics cache: on expiry every concurrent request recomputed 7 platform-wide aggregates. | Cache stampede on the biggest tables. | **Fixed** |
| 11 | Receipt PDF re-read ~1.25 MB of fonts (twice) and images from disk per render, synchronously. | 183 ms on the event loop per receipt. | **Improved** (−22%) |
| 12 | Four redundant indexes duplicating `@unique` columns. | Write amplification. | **Fixed** |
| 13 | Rate limits are per process, in memory. | With N instances every limit is N× looser (including the checkout limit that bounds account minting at 9jaPay), and limits reset on every deploy. | **Open: needs a decision (§6)** |
| 14 | Uploads (avatars, poll images) are written to the container's local disk. | A second instance can't see the files; this blocks horizontal scaling. | **Fixed** (§3.7); run the one-off migration in production |
| 15 | Deploy recreates the only container. | Downtime on every deploy. | **Open (§6)** |
| 16 | No Prisma pool settings (`connection_limit` / `pool_timeout`). | The pool size depends on the host's CPU count; under saturation requests hang instead of failing fast. | **Documented** (`.env.example`); needs setting in production `.env` |
| 17 | Guest pay link (`GET /public/dues/:id`) shares the 10/min per-IP join-code limiter; guest checkout is 10/min per IP; the guest flow also counts against the 1,500/15 min IP-wide limit. | Measured: of 300 students opening a shared link from one campus IP, **290 (97%) were refused**. | **Fixed** (§3.8) |
| 18 | Signup and password reset wait on Resend in the request. | Resend latency or outage is on the critical path. | Open, low priority |
| 19 | Integration tests call the real Resend API with a fake key. | Network-dependent tests. | Open, low priority |
| 20 | `npm run lint` fails: ESLint 9 with no `eslint.config.js`. | No lint in CI. | Open, low priority |

## 3. What changed

### 3.1 Native bcrypt (findings 1, 2)
- **Problem:** `bcryptjs` hashes in JS on the main thread. Measured: one compare = 273 ms; 8 concurrent compares → **858 ms max event-loop stall**, 2.3 s total.
- **Change:** `src/lib/password.ts` wraps native `bcrypt@6` (`hashPassword` / `verifyPassword` / `hashPasswordSync`); all 10 call sites use it. `DUMMY_HASH` now uses `env.BCRYPT_ROUNDS`.
- **Why it helps:** the async calls run on libuv's threadpool. Same 8 compares: **1 ms max stall**, 578 ms total (4× throughput, 4 threads).
- **Compatibility:** existing `$2a$` hashes verify unchanged, tested both directions. No data migration; nobody needs to reset a password.
- **Trade-offs:** a native dependency. `bcrypt@6` ships prebuilt binaries for linux-x64/arm64 glibc (`node:20-bookworm-slim` matches), so no compiler is needed. Not verified in a Docker build here (no Docker on this machine): **build the image once in staging before production.**

### 3.2 Indexes (findings 3, 12)
Migration `20261107140000_scaling_indexes`: adds `checkouts(vaAccountNumber, status)` and the nullable `checkouts.lastProviderCheckAt`, and drops 4 duplicate indexes. Additive or drop-only, so it is safe to apply live. Verified: `prisma migrate diff` between the migration history and `schema.prisma` is empty.

### 3.3 Pay-page status poll (finding 4), `src/routes/transactions.ts`
- The throttle is now a conditional `UPDATE … WHERE lastProviderCheckAt < now-10s` on the checkout row, so it holds across any number of instances. A poll that loses costs one indexed UPDATE that matches nothing.
- The common poll (pending, throttled) is **2 queries instead of 4**; it re-reads only when 9jaPay was actually asked. The response shape is unchanged (covered by test).
- **Trade-off:** `checkouts.updatedAt` is bumped at most once per 10s while a checkout is being polled.

### 3.4 Concurrent webhook processing (finding 5), `src/jobs/webhookWorker.ts`
- A claimed batch now runs with bounded concurrency (`WEBHOOK_WORKER_CONCURRENCY`, default 4).
- **Why it's safe:** it is the same situation as several worker processes, which the design already supports. Every handler row-locks or claims conditionally; `providerTransactionId` and the ledger keys are unique; money-out dispatch relies on 9jaPay's duplicate-reference refusal, which maps to a status lookup. A failure to record an outcome no longer aborts the rest of the batch.
- **Trade-off:** each in-flight event can hold a DB connection while it writes. Keep the setting well under `connection_limit`.

### 3.5 Graceful shutdown, timeouts, readiness (findings 6–8)
- `src/lib/lifecycle.ts` (used by the API and the worker): on SIGTERM it marks itself not-ready, stops timers, stops accepting connections, waits for in-flight requests, the webhook drain, the reconciliation pass and the KYC run, then disconnects. The hard deadline is 25s.
- Dockerfile: `exec node …`, so SIGTERM reaches Node. Compose: `stop_grace_period: 30s`.
- `server.keepAliveTimeout = 125s` (above Caddy's 2 min), `headersTimeout = 126s`, `requestTimeout = 120s`.
- `GET /health/ready`: 503 while shutting down or if `SELECT 1` takes longer than 2s. Health probes are no longer request-logged.

### 3.6 Smaller fixes
- Batched, hourly purge of expired auth tokens (finding 9); refresh tokens are kept 7 days past expiry for support. The user-facing message is the same either way ("Invalid or expired").
- Single-flight refresh of the public metrics cache (finding 10).
- Receipt assets read once per process (finding 11): 183 → 142 ms per render.
- `.env.example`: how to size `connection_limit` / `pool_timeout`, and `pgbouncer=true` for the transaction pooler (finding 16). Every lock the app takes is transaction-scoped, so transaction pooling is safe.

### 3.7 Avatars and poll images → ImageKit (finding 14)
- **Problem:** `POST /me/avatar` and `POST /spaces/:id/polls/image` wrote to `uploads/` on the container and were served by the API at `/uploads/…`. With two instances, a file written on one 404s on the other.
- **Change:** a public image store in `src/lib/storage` (ImageKit, `isPrivateFile: false`, folder `IMAGEKIT_PUBLIC_FOLDER`, default `/duevy/public`), next to the private KYC store. Uploads keep the same validation (2 MB, type sniffed from the bytes) and return the ImageKit CDN URL; the response shape is unchanged. Replacing an avatar, by upload or by `PATCH /me` with a different URL, deletes the old file (`users.avatarFileId`, migration `20261107150000_avatar_file_id`). If ImageKit is down, the upload answers 502 `UPLOAD_FAILED` and the profile is untouched. Startup refuses a public folder that overlaps the KYC folder.
- **Why it helps:** instances become stateless for files, and images are served by a CDN instead of the API process.
- **Existing files:** `src/scripts/migrateUploads.ts` uploads them and rewrites `users.avatarUrl`, `poll_categories.imageUrl` and `nominees.imageUrl`. It defaults to a dry run, can be re-run safely, and rewrites a row only if it still holds the old URL. Run it in the API container: `docker compose exec api node dist/scripts/migrateUploads.js` (report), then with `--apply`. Until then the legacy `/uploads` route and volume stay; remove both afterwards.
- **Trade-offs:** the upload request now waits on an ImageKit round trip. Avatar URLs are now public CDN URLs, as they effectively already were.

### 3.8 Guest pay link limits (finding 17), `src/middleware/rateLimiter.ts`
Guests have no account, so the IP is the only key, and a class shares one campus IP. Each limit now separates one person from one network:

| Guest route | Before | After |
|---|---|---|
| `GET /public/dues/:id` (view the link) | 10/min per IP | 600/min per IP |
| `POST /public/dues/:id/checkout` (opens a 9jaPay account) | 10/min per IP | 10/min per person (account, or IP + email) **and** 60/min per IP for anonymous guests |
| `GET /public/checkouts/:ref` + receipt | IP-wide 1,500/15 min only | 60/min per checkout |
| `POST /public/checkouts/:ref/account` (emails a link) | 10/min per IP | 5 per 10 min per checkout |
| IP-wide 1,500/15 min | applied | skipped for these paths (they have their own limits) |

Measured with `load-tests/guest-link.js` (one IP, the page's data request):

| Class opening the link within one minute | Before | After |
|---|---|---|
| 300 students | 10 loaded, **290 refused** | 300 loaded, p95 **7.5 ms** |
| 600 students | — | 600 loaded (cap), p95 7.6 ms |

When the page does load it takes ~6–8 ms server-side, before and after; the network to the student dominates. The remaining throttle is starting payments: 60 a minute per network, so a class of 300 all starting at once is through in about 5 minutes. That bounds how many one-time accounts one address can open at 9jaPay; raise it if real classes need it.

## 4. Testing

**Regression:** typecheck clean; unit **52/52** (2 new); integration **108/108** (5 in `uploadsAndGuestLimits.int.test.ts`: avatar upload/replace/delete and ImageKit-down handling, the legacy-upload migration, guest link and checkout limits; 4 in `scaling.int.test.ts`: a 25-payment burst with duplicate deliveries drained by 3 concurrent workers, the cross-instance poll throttle and its response shape, the token purge, readiness). Baseline before any change: 50/50 unit and 99/99 integration.

A pre-existing race in `guestAccount.int.test.ts` (it waited on the invite *claim*, which is written before the email is sent) surfaced once in 5 runs and is fixed; 8/8 green since.

**Load** (`load-tests/duevy.js`, k6, against `scripts/loadtest/server.ts`): the real app and jobs on embedded Postgres, 20 spaces, 2,000 students, 80k history rows, 9jaPay faked with 250 ms latency, Prisma pool 10, k6 + Postgres + API all on one 8-core laptop. After every run, `scripts/loadtest/audit.ts` checks that each paid checkout has exactly one due payment, ledger credit and receipt; that there are no double payments; that the ledger balance equals the face value collected; and that no webhook is dead or stuck.

Mixed "deadline day" profile: 150 browsing users, 5 logins/s, 8 payments/s (checkout → webhook ×2 → pay-page polling), 2.5 min.

| | Original code | After |
|---|---|---|
| Requests (failed) | 7,240 (21% failed) | 48,523 (0 failed) |
| Payments confirmed | 288 of ~1,200 | 1,201 of 1,201 |
| Time to "paid", p95 | 80 s | 1.0 s |
| Dashboard reads, p95 | 25.6 s | 5.3 ms |
| Checkout, p95 (includes the 250 ms provider call) | 37.3 s | 266 ms |
| Login, p95 | 31.2 s | 350 ms |
| Webhook ack, p95 | 10.5 s | 1.6 ms |
| Event-loop stall, max | 3.7 s | ~12 ms |
| Ledger audit | consistent | consistent |

The original code collapses under this load: 5 logins/s needs 1.4 CPU-seconds per second of bcrypt on one thread. Its money stayed consistent even while it collapsed, which confirms the money-path design.

**Breaking point** (stress profile ramping to 800 users, 30 logins/s, 40 payments/s): 154,683 requests, **0 errors, 3,756 payments, ledger consistent**. On this shared host the first limit is **login at ~10–12/s per process**, where bcrypt cost 12 uses ~3 cores. Beyond that, logins queue (p95 37 s) and reads degrade from <25 ms to ~1 s p95 at ~740 req/s as CPU runs out. Raising `UV_THREADPOOL_SIZE` to 8 made things *worse* on this host (CPU-bound), so it is not recommended without measuring on the real hardware. Payments kept confirming within 3.3 s p95 throughout.

Reproduce: `npm run loadtest:server`, then `npm run loadtest` (or `loadtest:stress`), then `npm run loadtest:audit`. Run the load generator on a different machine from the target for numbers that reflect production.

## 5. Benchmarks to hold

Per API process (pool 10), from the runs above: dashboard reads p95 < 300 ms up to ~550 req/s; checkout p95 < 1.5 s; time-to-paid p95 < 10 s; webhook ack p95 < 200 ms; 0% errors; ledger audit consistent. Login capacity is ~10/s per process at cost 12 and is the first thing to plan instances around (a deadline-day sign-in rush).

## 6. Remaining work and decisions

1. **Shared rate-limit store (finding 13).** Required before running more than one API instance. Options: Redis (`rate-limit-redis`, which also unlocks a shared cache), or a Postgres-backed store (no new infrastructure, adds a write per request). Recommendation: managed Redis.
2. **Run the upload migration** (§3.7) in production, then remove the `/uploads` route and volume.
3. **Zero-downtime deploys (finding 15).** Two API replicas behind Caddy (`lb_policy` plus `health_uri /health/ready`), rolled one at a time. That depends on 1 and 2. Background jobs can stay in-process on every replica (safe by design) or move to one `npm run worker` service with `RUN_WORKERS=false` on the API.
4. **Production `.env`:** set `connection_limit` / `pool_timeout` (and `pgbouncer=true` if on port 6543), sized as `(API + worker processes) × connection_limit < pooler size`.
5. **bcrypt cost.** Cost 11 halves login CPU (about 2× login capacity) at a modest security cost. This is a product/security call; it isn't changed here. Existing hashes keep working either way.
6. **Monitoring:** alert on `/health/ready`, on dead webhook events (already shown on `GET /admin/health`), on 5xx rate and on p95 latency. Export event-loop delay (the harness shows how) and Prisma pool wait time.
7. **Later, at much larger scale:** balances are a `SUM` over the space's ledger on each read. That's fine at thousands of entries per space; past ~100k per space, add a covering index `(spaceId) INCLUDE (direction, amountKobo)` (index-only scans suit an append-only table) or periodic balance snapshots.
