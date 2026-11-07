/**
 * Dashboard latency vs. database distance.
 *
 * Every sequential query costs one network round trip between the API and
 * Postgres, so an endpoint's time when the two are far apart (VPS in one
 * region, Supabase in another) is roughly  round_trips_in_a_row × RTT.
 * This puts a TCP proxy in front of a local Postgres that adds RTT/2 each way,
 * seeds a realistic space, and times every dashboard endpoint at several
 * RTTs, counting the SQL statements each one sends.
 *
 *   npx tsx scripts/loadtest/dashboard-latency.ts            # RTTs 0,20,60 ms
 *   LT_RTTS=0,80 npx tsx scripts/loadtest/dashboard-latency.ts
 *   LT_JSON=out.json …                                        # also write results
 *   LT_DB_PARAMS='connection_limit=5&pgbouncer=true' …        # as behind Supabase's transaction pooler
 */
import net from 'net';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';

const PG_PORT = 55470;
const PROXY_PORT = 55471;
const RTTS = (process.env.LT_RTTS ?? '0,20,60').split(',').map(Number);
const RUNS = Number(process.env.LT_RUNS ?? 5);
const MEMBERS = 300;
const PAID = 150;

let oneWayDelayMs = 0;

/** Postgres behind a link that adds `oneWayDelayMs` in each direction (order preserved). */
function startLatencyProxy(): net.Server {
  return net
    .createServer((client) => {
      const upstream = net.connect(PG_PORT, '127.0.0.1');
      const pipe = (from: net.Socket, to: net.Socket) =>
        from.on('data', (chunk) => {
          const d = oneWayDelayMs;
          if (d === 0) to.write(chunk);
          else setTimeout(() => to.write(chunk), d);
        });
      pipe(client, upstream);
      pipe(upstream, client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close).on('close', close);
      upstream.on('error', close).on('close', close);
    })
    .listen(PROXY_PORT);
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'duevy-dash-'));
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'duevy', password: 'duevy', port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('dash');
  const direct = `postgresql://duevy:duevy@localhost:${PG_PORT}/dash`;
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: direct, DIRECT_URL: direct } });
  const proxy = startLatencyProxy();

  Object.assign(process.env, {
    NODE_ENV: 'test', // silent logs, no request logging noise in timings
    DATABASE_URL: `postgresql://duevy:duevy@127.0.0.1:${PROXY_PORT}/dash?${process.env.LT_DB_PARAMS ?? 'connection_limit=10'}`,
    DIRECT_URL: direct,
    JWT_ACCESS_SECRET: 'dash-access-secret-0123456789abcdef0123456789',
    JWT_REFRESH_SECRET: 'dash-refresh-secret-0123456789abcdef012345678',
    RESEND_API_KEY: 're_dash',
    PAYMENT_PROVIDER: 'fake',
    NINEJAPAY_SECRET_KEY: 'whsec_dash',
    FILE_STORAGE: 'memory',
    RUN_WORKERS: 'false',
  });
  // Emails are not under test: answer Resend locally.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname.endsWith('resend.com')) return new Response('{"id":"x"}', { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;

  // Count statements per request.
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let statements = 0;
  client.$on('query' as never, () => {
    statements += 1;
  });
  (globalThis as { prisma?: unknown }).prisma = client;

  const { db } = await import('../../src/config/db');
  const { signAccessToken } = await import('../../src/lib/jwt');
  const { createCheckout, fulfilCheckout } = await import('../../src/services/checkout.service');
  const { appendLedgerEntry } = await import('../../src/services/ledger.service');
  const { app } = await import('../../src/app');

  // ---- seed (no added latency) ----------------------------------------------
  const t0 = Date.now();
  const rep = await db.user.create({ data: { name: 'Rep', email: 'rep@dash.duevy', role: 'rep', isRep: true, repApplicationStatus: 'approved', kycStatus: 'verified', ninCheckOutcome: 'match', studentIdStatus: 'approved', livenessStatus: 'approved', emailVerified: true } });
  const admin = await db.user.create({ data: { name: 'Admin', email: 'admin@dash.duevy', role: 'admin', adminSubRole: 'super_admin', emailVerified: true } });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  const space = await db.space.create({ data: { name: 'CSC 300L', short: 'CSC', kind: 'department', school: 'LAUTECH', joinCode: 'CSC-DASH', walletAccountId: 'va_dash', walletAccountNumber: '9100000001', walletAccountName: 'DUEVY/CSC', walletBankName: '9jaPay', walletBankCode: '090629', walletCreatedAt: new Date() } });
  await db.spaceRep.create({ data: { userId: rep.id, spaceId: space.id, role: 'lead' } });
  const dues = [];
  for (let d = 0; d < 8; d++) {
    dues.push(await db.due.create({ data: { spaceId: space.id, title: `Due ${d}`, amount: 200_000 + d * 25_000, dueDate: new Date(Date.now() + (d - 2) * 7 * 86_400_000), category: 'departmental_due', status: d < 6 ? 'active' : 'closed' } }));
  }
  await db.user.createMany({ data: Array.from({ length: MEMBERS }, (_, i) => ({ id: `usr_dash_${i}`, name: `Student ${i}`, email: `s${i}@dash.duevy`, matricNo: `CSC/${i}`, emailVerified: true })) });
  await db.spaceMembership.createMany({ data: Array.from({ length: MEMBERS }, (_, i) => ({ userId: `usr_dash_${i}`, spaceId: space.id })) });
  // A long personal history for the student we look at, as in a real account.
  await db.transaction.createMany({ data: Array.from({ length: 300 }, (_, h) => ({ userId: 'usr_dash_0', type: 'due' as const, title: `Old ${h}`, amount: -100_000, method: 'Bank transfer', status: 'completed' as const, reference: `DASHH${h}`, createdAt: new Date(Date.now() - (h + 1) * 86_400_000) })) });
  // Real payments through the real checkout path: ledger, receipts, notifications.
  for (let i = 0; i < PAID; i++) {
    const uid = `usr_dash_${i}`;
    const picks = i === 0 ? [dues[0]!.id, dues[1]!.id] : [dues[i % 6]!.id];
    const { checkout } = await createCheckout(uid, picks);
    const c = await db.checkout.findUniqueOrThrow({ where: { reference: checkout.reference } });
    await fulfilCheckout(c.id, c.totalKobo, 0, 'seed');
  }
  await db.$transaction((tx) => appendLedgerEntry(tx, { spaceId: space.id, type: 'manual_credit', direction: 'credit', amountKobo: 50_000, reference: 'SEEDCREDIT', description: 'seed' }));
  await db.notification.createMany({ data: Array.from({ length: 200 }, (_, n) => ({ userId: 'usr_dash_0', kind: 'system' as const, title: `N${n}`, detail: 'x' })) });
  await new Promise((r) => setTimeout(r, 500)); // let afterPaid side effects settle
  await db.$executeRawUnsafe('ANALYZE');
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const tok = async (u: { id: string; role: string }) => signAccessToken({ sub: u.id, role: u.role, spaceIds: [] });
  const student = await tok({ id: 'usr_dash_0', role: 'student' });
  const repTok = await tok(rep);
  const adminTok = await tok(admin);
  const s = `/v1/spaces/${space.id}`;
  const endpoints: [string, string, string][] = [
    ['student', 'GET /auth/me', student],
    ['student', 'GET /me/overview', student],
    ['student', 'GET /dues', student],
    ['student', 'GET /transactions', student],
    ['student', 'GET /notifications', student],
    ['student', 'GET /spaces', student],
    ['student', 'GET /receipts', student],
    ['rep', `GET ${s}/overview`, repTok],
    ['rep', `GET ${s}/dues`, repTok],
    ['rep', `GET ${s}/dues/${dues[0]!.id}/collections`, repTok],
    ['rep', `GET ${s}/members`, repTok],
    ['rep', `GET ${s}/payout/summary`, repTok],
    ['rep', `GET ${s}/payout/dues`, repTok],
    ['rep', `GET ${s}/ledger`, repTok],
    ['rep', `GET ${s}/payouts`, repTok],
    ['admin', 'GET /admin/overview', adminTok],
    ['admin', 'GET /admin/spaces', adminTok],
    ['admin', 'GET /admin/users', adminTok],
    ['admin', 'GET /admin/checkouts', adminTok],
    ['admin', 'GET /admin/transactions', adminTok],
  ];

  // LT_DUMP=file: write every endpoint's response (ids, references and
  // timestamps normalised) to compare two revisions for identical output.
  if (process.env.LT_DUMP) {
    const VOLATILE = /(^id$|Id$|^reference$|^number$|^receiptNumber$|At$|^accountNumber$|^joinCode$|^token$)/;
    const norm = (v: unknown, k = ''): unknown => {
      if (Array.isArray(v)) return v.map((x) => norm(x));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([kk, vv]) => [kk, norm(vv, kk)]));
      if (typeof v === 'string' && (VOLATILE.test(k) || /^\d{4}-\d{2}-\d{2}T/.test(v))) return '<volatile>';
      if (typeof v === 'string') return v.replace(new RegExp(space.id, 'g'), '<space>').replace(/c[a-z0-9]{24}/g, '<cuid>');
      return v;
    };
    const dump: Record<string, unknown> = {};
    for (const [, ep, token] of endpoints) {
      const res = await realFetch(`${base}/v1${ep.slice(4).replace(/^\/v1/, '')}`, { headers: { Authorization: `Bearer ${token}` } });
      dump[ep.replace(s, '/spaces/:id').replace(dues[0]!.id, ':dueId')] = { status: res.status, body: norm(await res.json()) };
    }
    writeFileSync(process.env.LT_DUMP, JSON.stringify(dump, null, 2));
  }

  type Row = { who: string; endpoint: string; status: number; statements: number; ms: Record<number, number> };
  const rows: Row[] = endpoints.map(([who, ep]) => ({ who, endpoint: ep.replace(s, '/spaces/:id').replace(dues[0]!.id, ':dueId'), status: 0, statements: 0, ms: {} }));
  for (const rtt of RTTS) {
    oneWayDelayMs = rtt / 2;
    for (const [i, [, ep, token]] of endpoints.entries()) {
      const url = `${base}/v1${ep.slice(4).replace(/^\/v1/, '')}`;
      const times: number[] = [];
      for (let r = 0; r < RUNS + 1; r++) {
        statements = 0;
        const t = performance.now();
        const res = await realFetch(url, { headers: { Authorization: `Bearer ${token}` } });
        await res.arrayBuffer();
        if (r > 0) times.push(performance.now() - t); // first run warms the pool
        rows[i]!.status = res.status;
        rows[i]!.statements = statements;
      }
      times.sort((a, b) => a - b);
      rows[i]!.ms[rtt] = times[Math.floor(times.length / 2)]!;
    }
  }

  const head = ['who', 'endpoint', 'status', 'SQL', ...RTTS.map((r) => `${r}ms RTT`), RTTS.length > 1 ? 'round trips' : ''];
  console.log(head.join('\t'));
  for (const r of rows) {
    const hi = RTTS[RTTS.length - 1]!;
    const trips = RTTS.length > 1 && hi > 0 ? ((r.ms[hi]! - r.ms[RTTS[0]!]!) / (hi - RTTS[0]!)).toFixed(1) : '';
    console.log([r.who, r.endpoint, r.status, r.statements, ...RTTS.map((x) => r.ms[x]!.toFixed(0)), trips].join('\t'));
  }
  if (process.env.LT_JSON) writeFileSync(process.env.LT_JSON, JSON.stringify(rows, null, 2));

  server.close();
  proxy.close();
  await db.$disconnect();
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
