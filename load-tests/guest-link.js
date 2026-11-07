/**
 * A rep shares a due's guest pay link in a class group chat; the class opens
 * it at once from one campus network (one public IP behind NAT). Measures how
 * long the pay page's data takes to load for each student, and how many are
 * turned away by the rate limit.
 *
 *   npm run loadtest:server
 *   k6 run load-tests/guest-link.js        # -e STUDENTS=300 -e SECONDS=60
 */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3100';
const STUDENTS = Number(__ENV.STUDENTS || 300);
const SECONDS = Number(__ENV.SECONDS || 60);
const due = new SharedArray('due', () => [JSON.parse(open('./.fixtures.json')).students[0].dueIds[0]]);

const blocked = new Rate('blocked_by_rate_limit');
const loadMs = new Trend('page_data_ms', true);

export const options = {
  scenarios: {
    class_opens_link: { executor: 'constant-arrival-rate', rate: STUDENTS, timeUnit: `${SECONDS}s`, duration: `${SECONDS}s`, preAllocatedVUs: 50, maxVUs: 300 },
  },
  thresholds: { blocked_by_rate_limit: ['rate<0.01'], page_data_ms: ['p(95)<300'] },
};

http.setResponseCallback(http.expectedStatuses(200));

export default function () {
  // Every student behind the same campus NAT address.
  const r = http.get(`${BASE}/v1/public/dues/${due[0]}`, { headers: { 'X-Forwarded-For': '102.89.10.20' } });
  blocked.add(r.status === 429);
  if (r.status === 200) loadMs.add(r.timings.duration);
  check(r, { 'pay page loads': (x) => x.status === 200 });
}
