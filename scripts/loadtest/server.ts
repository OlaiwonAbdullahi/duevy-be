/**
 * Load-test target: the real API (src/app.ts, real middleware, real Postgres,
 * real background jobs) on a throwaway embedded Postgres, seeded with a
 * realistic dataset, with 9jaPay replaced by a fake that answers from the
 * database after a realistic network delay. Nothing leaves the machine.
 *
 *   npx tsx scripts/loadtest/server.ts            # then, in another shell:
 *   k6 run load-tests/duevy.js
 *
 * Tunables (env): LT_PORT (3100), LT_PG_PORT (55433), LT_SPACES (20),
 * LT_STUDENTS (2000), LT_HISTORY (40 transactions per student),
 * LT_PROVIDER_MS (250: simulated 9jaPay round trip), LT_POOL (Prisma
 * connection_limit, default 10). Writes load-tests/.fixtures.json for k6.
 */
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = Number(process.env.LT_PORT ?? 3100);
const PG_PORT = Number(process.env.LT_PG_PORT ?? 55433);
const SPACES = Number(process.env.LT_SPACES ?? 20);
const STUDENTS = Number(process.env.LT_STUDENTS ?? 2000);
const HISTORY = Number(process.env.LT_HISTORY ?? 40);
const PROVIDER_MS = Number(process.env.LT_PROVIDER_MS ?? 250);
const POOL = Number(process.env.LT_POOL ?? 10);
export const LT_PASSWORD = 'LoadTest#2026';
export const LT_WEBHOOK_SECRET = 'whsec_loadtest';
const DUE_CATEGORY = 'departmental_due' as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'duevy-lt-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'duevy', password: 'duevy', port: PG_PORT, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {},
    // A little closer to a hosted Postgres than the defaults.
    postgresFlags: ['-c', 'max_connections=200', '-c', 'shared_buffers=256MB'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('duevy_lt');
  const url = `postgresql://duevy:duevy@localhost:${PG_PORT}/duevy_lt`;
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });

  // Environment for the app, before any of it is imported.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    DATABASE_URL: `${url}?connection_limit=${POOL}&pool_timeout=10`,
    DIRECT_URL: url,
    JWT_ACCESS_SECRET: 'lt-access-secret-0123456789abcdef0123456789',
    JWT_REFRESH_SECRET: 'lt-refresh-secret-0123456789abcdef012345678',
    RESEND_API_KEY: 're_loadtest',
    PAYMENT_PROVIDER: 'fake',
    NINEJAPAY_SECRET_KEY: LT_WEBHOOK_SECRET,
    FILE_STORAGE: 'memory',
    TRUST_PROXY: '1', // k6 spreads virtual users over X-Forwarded-For addresses
    BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ?? '12',
    RUN_WORKERS: 'true',
  });

  // src/config/db.ts reuses globalThis.prisma when set: give it a client that
  // doesn't log every query (development's default would dominate the run).
  const { PrismaClient } = await import('@prisma/client');
  (globalThis as { prisma?: unknown }).prisma = new PrismaClient({ log: ['error'] });
  const { db } = await import('../../src/config/db');
  // (Falls back to bcryptjs so the same harness can drive older revisions for a before/after comparison.)
  const { hashPasswordSync } = await import('../../src/lib/password').catch(async () => {
    const bcryptjs = (await import('bcryptjs' as string)).default as { hashSync: (p: string, r: number) => string };
    return { hashPasswordSync: bcryptjs.hashSync };
  });
  const { setPaymentProvider, FakeProvider } = await import('../../src/providers/payment');
  // Emails are not under test: answer Resend locally, never over the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname.endsWith('resend.com')) {
      return new Response(JSON.stringify({ id: 'lt-email' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  /** 9jaPay stand-in: a round trip's latency, and "the student paid in full" for any open checkout account. */
  class LoadProvider extends FakeProvider {
    async createCollectionAccount(input: Parameters<FakeProvider['createCollectionAccount']>[0]) {
      await sleep(PROVIDER_MS);
      this.calls.length = 0; // the fake logs every call; don't let a long run grow it
      return super.createCollectionAccount(input);
    }
    async getCollectionStatus(accountNumber: string, window: { from: Date; to: Date }) {
      await sleep(PROVIDER_MS);
      this.calls.length = 0;
      const c = await db.checkout.findFirst({ where: { vaAccountNumber: accountNumber }, orderBy: { createdAt: 'desc' }, select: { totalKobo: true } });
      // Paid once the k6 "student" has announced the transfer (webhook sent);
      // the marker is the webhook having been stored for this account.
      const announced = await db.webhookEvent.findFirst({ where: { providerEventId: { startsWith: `new_transaction:lt-${accountNumber}` } }, select: { id: true } });
      void window;
      return c && announced ? { state: 'paid' as const, receivedKobo: c.totalKobo } : { state: 'open' as const, receivedKobo: null };
    }
  }
  setPaymentProvider(new LoadProvider([LT_WEBHOOK_SECRET]));

  // ---- seed --------------------------------------------------------------
  const t0 = Date.now();
  const passwordHash = hashPasswordSync(LT_PASSWORD, Number(process.env.BCRYPT_ROUNDS ?? 12));
  const spaces: { id: string; dueIds: string[] }[] = [];
  for (let s = 0; s < SPACES; s++) {
    const rep = await db.user.create({
      data: { name: `Rep ${s}`, email: `rep${s}@lt.duevy`, passwordHash, emailVerified: true, role: 'rep', isRep: true, repApplicationStatus: 'approved', kycStatus: 'verified', ninCheckOutcome: 'match', studentIdStatus: 'approved' },
    });
    const space = await db.space.create({
      data: { name: `Load Space ${s}`, short: `LS${s}`, kind: 'department', school: 'LAUTECH', joinCode: `LT-${s}-${Date.now()}`.slice(0, 24), walletAccountId: `va_lt_${s}`, walletAccountNumber: `91${String(s).padStart(8, '0')}`, walletAccountName: `DUEVY/LS${s}`, walletBankName: '9jaPay', walletBankCode: '090629', walletCreatedAt: new Date() },
    });
    await db.spaceRep.create({ data: { userId: rep.id, spaceId: space.id, role: 'lead' } });
    const dueIds: string[] = [];
    for (let d = 0; d < 6; d++) {
      const due = await db.due.create({ data: { spaceId: space.id, title: `Due ${d}`, amount: 200_000 + d * 50_000, dueDate: new Date(Date.now() + 30 * 86_400_000), category: DUE_CATEGORY, status: 'active' } });
      dueIds.push(due.id);
    }
    spaces.push({ id: space.id, dueIds });
  }

  const students: { id: string; email: string; spaceId: string; dueIds: string[] }[] = [];
  const CHUNK = 500;
  for (let start = 0; start < STUDENTS; start += CHUNK) {
    const batch = Array.from({ length: Math.min(CHUNK, STUDENTS - start) }, (_, k) => {
      const i = start + k;
      return { id: `usr_lt_${i}`, name: `Student ${i}`, email: `s${i}@lt.duevy`, passwordHash, emailVerified: true, matricNo: `LT/${i}` };
    });
    await db.user.createMany({ data: batch });
    await db.spaceMembership.createMany({ data: batch.map((u, k) => ({ userId: u.id, spaceId: spaces[(start + k) % SPACES]!.id })) });
    // A long transaction history and a backlog of notifications per student.
    await db.transaction.createMany({
      data: batch.flatMap((u, k) => Array.from({ length: HISTORY }, (_, h) => ({
        userId: u.id, type: 'due' as const, title: `Old due ${h}`, detail: 'history', amount: -(100_000 + h), method: 'Bank transfer',
        status: 'completed' as const, reference: `LTH${start + k}X${h}`, spaceId: spaces[(start + k) % SPACES]!.id, createdAt: new Date(Date.now() - (h + 1) * 86_400_000),
      }))),
    });
    await db.notification.createMany({ data: batch.flatMap((u) => Array.from({ length: 20 }, (_, n) => ({ userId: u.id, kind: 'system' as const, title: `Notice ${n}`, detail: 'history' }))) });
    for (const [k, u] of batch.entries()) students.push({ id: u.id, email: u.email, spaceId: spaces[(start + k) % SPACES]!.id, dueIds: spaces[(start + k) % SPACES]!.dueIds });
  }
  await db.$executeRawUnsafe('ANALYZE');
  writeFileSync(path.join(__dirname, '../../load-tests/.fixtures.json'), JSON.stringify({ password: LT_PASSWORD, webhookSecret: LT_WEBHOOK_SECRET, jwtSecret: process.env.JWT_ACCESS_SECRET, students }));
  console.log(`seeded ${SPACES} spaces, ${STUDENTS} students, ${STUDENTS * HISTORY} history rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- serve, exactly as src/server.ts does ---------------------------------
  const { app } = await import('../../src/app');
  const { startWebhookWorker } = await import('../../src/jobs/webhookWorker');
  const { startReconciliationJob } = await import('../../src/jobs/reconciliation');
  const server = app.listen(PORT, () => console.log(`load target on http://localhost:${PORT} (provider latency ${PROVIDER_MS}ms, pool ${POOL})`));
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 126_000;
  const timers = [startWebhookWorker(), startReconciliationJob()];

  // Event-loop lag, the number bcrypt-on-the-main-thread used to wreck.
  const { monitorEventLoopDelay } = await import('perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const lagTimer = setInterval(() => {
    console.log(`event-loop delay p50=${(h.percentile(50) / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms max=${(h.max / 1e6).toFixed(1)}ms rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
    h.reset();
  }, 10_000);

  const stop = async () => {
    clearInterval(lagTimer);
    timers.forEach(clearInterval);
    server.close();
    await db.$disconnect();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
