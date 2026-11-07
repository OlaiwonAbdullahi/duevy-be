/**
 * Steady traffic through Caddy while scripts/deploy.sh restarts the replicas
 * one at a time (deploy rehearsal: deploy/rehearsal/compose.yml). Passes only
 * if not a single request fails during the deploy.
 *
 *   k6 run -e DURATION=4m load-tests/rolling-deploy.js
 *
 * Also checks a rate limit is shared by both replicas (Redis): join-code
 * lookups are 10 a minute per user; with round-robin over two replicas, a
 * per-process limit would let ~20 through.
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const FIX = JSON.parse(open('./.rehearsal.json'));
const lookupsAllowed = new Counter('shared_limit_lookups_allowed');

export const options = {
  scenarios: {
    traffic: { executor: 'constant-arrival-rate', exec: 'traffic', rate: 40, timeUnit: '1s', duration: __ENV.DURATION || '4m', preAllocatedVUs: 40, maxVUs: 200 },
    sharedLimit: { executor: 'shared-iterations', exec: 'sharedLimit', vus: 1, iterations: 1, startTime: '5s' },
  },
  thresholds: {
    'http_req_failed{scenario:traffic}': ['rate==0'],
    'checks{scenario:traffic}': ['rate==1'],
    shared_limit_lookups_allowed: ['count==10'],
  },
};

function tokenFor(s) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => encoding.b64encode(JSON.stringify(o), 'rawurl');
  const unsigned = `${b64({ alg: 'HS256' })}.${b64({ sub: s.id, role: 'student', spaceIds: [s.spaceId], iat: now, exp: now + 3600 })}`;
  return `${unsigned}.${crypto.hmac('sha256', FIX.jwtSecret, unsigned, 'base64rawurl')}`;
}
function uuidv4() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function traffic() {
  const n = exec.scenario.iterationInTest;
  // Writes rotate through every student (one checkout each per ~25s), so the
  // real 10/min-per-user checkout limit is never what's being measured.
  const s = FIX.students[(n % 5 === 0 ? n / 5 : n) % FIX.students.length];
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(s)}`, 'X-Forwarded-For': `10.1.${(n >> 8) & 255}.${n & 255}` };
  if (n % 5 === 0) {
    // A write: open (or reopen) this student's checkout.
    const r = http.post(`${BASE}/v1/dues/pay`, JSON.stringify({ dueIds: [FIX.dueId] }), { headers: Object.assign({ 'Idempotency-Key': uuidv4() }, h) });
    if (!check(r, { 'checkout ok': (x) => x.status === 200 || x.status === 201 })) console.warn(`checkout failed: ${r.status} ${r.error || ''} ${String(r.body).slice(0, 120)}`);
  } else {
    const r = http.get(`${BASE}/v1/dues`, { headers: h });
    if (!check(r, { 'dues ok': (x) => x.status === 200 })) console.warn(`read failed: ${r.status} ${r.error || ''}`);
  }
}

export function sharedLimit() {
  // A user that the traffic scenario never uses.
  const s = { id: `limit_probe_${Date.now()}`, spaceId: FIX.students[0].spaceId };
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(s)}` };
  const statuses = [];
  for (let i = 0; i < 20; i++) {
    const r = http.post(`${BASE}/v1/spaces/lookup`, JSON.stringify({ code: FIX.joinCode }), { headers: h, tags: { probe: 'limit' }, responseCallback: http.expectedStatuses(200, 429) });
    statuses.push(r.status);
    if (r.status === 200) lookupsAllowed.add(1);
  }
  console.log(`shared limit probe: ${statuses.join(',')}`);
  sleep(1);
}
