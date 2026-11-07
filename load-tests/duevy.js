/**
 * Duevy load test (k6). Target: scripts/loadtest/server.ts (never production:
 * it mints tokens with the load database's JWT secret and fakes 9jaPay).
 *
 *   npx tsx scripts/loadtest/server.ts
 *   k6 run load-tests/duevy.js                     # the mixed collection-day profile
 *   k6 run -e PROFILE=stress load-tests/duevy.js   # ramp until it breaks
 *
 * Traffic, all at once (as on a dues deadline day):
 *   browse   students on their dashboard: profile, dues, a page of a long
 *            transaction history, notifications
 *   login    a steady stream of password sign-ins (bcrypt cost 12)
 *   pay      checkout (opens a one-time account at the "provider"), the
 *            provider's webhook, then the pay page polling until "paid"
 *   The webhook burst is the pay scenario's own deliveries, each sent twice
 *   (9jaPay retries), so dedupe and idempotency are under load too.
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3100';
const FIX = JSON.parse(open('./.fixtures.json'));
const students = new SharedArray('students', () => FIX.students);

const timeToPaid = new Trend('time_to_paid_ms', true);
const paidCount = new Counter('payments_confirmed');
const unpaidCount = new Counter('payments_not_confirmed_in_time');

const STRESS = __ENV.PROFILE === 'stress';

export const options = {
  discardResponseBodies: false,
  scenarios: STRESS
    ? {
        browse: { executor: 'ramping-vus', exec: 'browse', startVUs: 0, stages: [{ duration: '1m', target: 200 }, { duration: '1m', target: 500 }, { duration: '1m', target: 800 }, { duration: '30s', target: 0 }] },
        pay: { executor: 'ramping-arrival-rate', exec: 'pay', startRate: 2, timeUnit: '1s', preAllocatedVUs: 100, maxVUs: 600, stages: [{ duration: '1m', target: 10 }, { duration: '1m', target: 25 }, { duration: '1m', target: 40 }, { duration: '30s', target: 0 }] },
        login: { executor: 'ramping-arrival-rate', exec: 'login', startRate: 2, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 300, stages: [{ duration: '1m', target: 10 }, { duration: '1m', target: 20 }, { duration: '1m', target: 30 }, { duration: '30s', target: 0 }] },
      }
    : {
        browse: { executor: 'ramping-vus', exec: 'browse', startVUs: 0, stages: [{ duration: '30s', target: 150 }, { duration: '2m', target: 150 }, { duration: '15s', target: 0 }] },
        pay: { executor: 'constant-arrival-rate', exec: 'pay', rate: 8, timeUnit: '1s', duration: '2m30s', preAllocatedVUs: 80, maxVUs: 300 },
        login: { executor: 'constant-arrival-rate', exec: 'login', rate: 5, timeUnit: '1s', duration: '2m30s', preAllocatedVUs: 20, maxVUs: 100 },
      },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration{kind:read}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{kind:poll}': ['p(95)<300'],
    'http_req_duration{kind:checkout}': ['p(95)<1500'], // includes a 250ms provider round trip
    'http_req_duration{kind:webhook}': ['p(95)<200'],
    'http_req_duration{kind:login}': ['p(95)<1500'],
    'time_to_paid_ms': ['p(95)<10000'],
    'payments_not_confirmed_in_time': ['count<1'],
  },
};

// Business outcomes that are not failures (a due already paid by an earlier iteration, an open overlap).
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

function b64url(s) {
  return encoding.b64encode(s, 'rawurl');
}
/** HS256 access token, as src/lib/jwt.ts signs it. */
function tokenFor(student) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256' }));
  const body = b64url(JSON.stringify({ sub: student.id, role: 'student', spaceIds: [student.spaceId], iat: now, exp: now + 3600 }));
  const sig = crypto.hmac('sha256', FIX.jwtSecret, `${head}.${body}`, 'base64rawurl');
  return `${head}.${body}.${sig}`;
}
function uuidv4() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** A distinct client address per VU, so per-IP limits see many clients as in reality. */
function clientIp() {
  const v = exec.vu.idInTest;
  return `10.${(v >> 16) & 255}.${(v >> 8) & 255}.${v & 255}`;
}
function headers(token, extra) {
  return Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp() }, token ? { Authorization: `Bearer ${token}` } : {}, extra || {});
}

export function browse() {
  const s = students[exec.vu.idInTest % students.length];
  const token = tokenFor(s);
  const h = { headers: headers(token), tags: { kind: 'read' } };
  const r = http.batch([
    ['GET', `${BASE}/v1/me/overview`, null, h],
    ['GET', `${BASE}/v1/dues`, null, h],
    ['GET', `${BASE}/v1/transactions?page=${1 + Math.floor(Math.random() * 2)}&perPage=20`, null, h],
    ['GET', `${BASE}/v1/notifications`, null, h],
  ]);
  check(r, { 'dashboard 200': (rs) => rs.every((x) => x.status === 200) });
  sleep(1 + Math.random() * 2);
}

export function login() {
  const s = students[Math.floor(Math.random() * students.length)];
  const r = http.post(`${BASE}/v1/auth/login`, JSON.stringify({ email: s.email, password: FIX.password }), { headers: headers(), tags: { kind: 'login' } });
  check(r, { 'login 200': (x) => x.status === 200 });
}

export function pay() {
  // Each iteration is a different student and due, so nobody pays twice.
  const n = exec.scenario.iterationInTest;
  const s = students[n % students.length];
  const dueId = s.dueIds[Math.floor(n / students.length) % s.dueIds.length];
  const token = tokenFor(s);

  const co = http.post(`${BASE}/v1/dues/pay`, JSON.stringify({ dueIds: [dueId] }), {
    headers: headers(token, { 'Idempotency-Key': uuidv4() }),
    tags: { kind: 'checkout' },
  });
  if (!check(co, { 'checkout opened': (x) => x.status === 201 || x.status === 200 })) return;
  const c = co.json('data');
  if (!c.bankTransfer) return;
  const started = Date.now();

  // The student transfers; 9jaPay notifies us (and retries once).
  const body = JSON.stringify({
    eventType: 'new_transaction',
    data: {
      id: `lt-${c.bankTransfer.accountNumber}-${uuidv4()}`, transactionReference: uuidv4(), accountNumber: c.bankTransfer.accountNumber,
      accountName: 'Duevy', accountRequestReference: c.reference.replace(/[^A-Za-z0-9]/g, ''), amount: c.amount,
      senderName: 'STUDENT', senderAccountNumber: '0123456789', narration: 'dues', transactionType: 'Credit', transactionDate: new Date().toISOString(),
    },
  });
  const sig = crypto.hmac('sha256', FIX.webhookSecret, body, 'base64');
  for (let i = 0; i < 2; i++) {
    const w = http.post(`${BASE}/v1/webhooks/9japay`, body, { headers: { 'Content-Type': 'application/json', Signature: sig }, tags: { kind: 'webhook' } });
    check(w, { 'webhook 200': (x) => x.status === 200 });
  }

  // The pay page polls until paid.
  for (let i = 0; i < 30; i++) {
    sleep(1);
    const st = http.get(`${BASE}/v1/payments/${c.reference}/status`, { headers: headers(token), tags: { kind: 'poll' } });
    if (st.status === 200 && st.json('data.status') === 'paid') {
      timeToPaid.add(Date.now() - started);
      paidCount.add(1);
      check(st, { 'receipt issued': (x) => !!x.json('data.receiptNumber') });
      return;
    }
  }
  unpaidCount.add(1);
}
