/**
 * Deterministic date-resolution benchmark — RUNNABLE in the dev env (no GPU,
 * no model). It exercises src/ai/dates.ts, the layer that must be correct
 * regardless of the LLM, against a fixed "now" so every expectation is an
 * independently-calculated calendar date.
 *
 * Includes the engineering-brief regression (anchor 2026-11-14 Africa/Lagos,
 * "same day next week" → 2026-11-21) plus the required variations, and asserts
 * the agent would NOT ask for YYYY-MM-DD (resolvable phrases never come back
 * low-confidence).
 *
 * Run:  npx tsx ai-engineering/evaluation/eval_dates.ts
 * Exits non-zero if accuracy on the required cases is < 100%.
 */
import { resolve } from '../../src/ai/dates';

const NOW = new Date('2026-11-14T12:00:00Z'); // Saturday, the brief's anchor
const TZ = 'Africa/Lagos';

interface Case {
  expr: string;
  expect: string | null; // ISO, or null when clarification is the correct move
  note?: string;
}

// Required cases — these MUST pass (the brief's regression + variations).
const REQUIRED: Case[] = [
  { expr: 'same day next week', expect: '2026-11-21' },
  { expr: 'next week', expect: '2026-11-21' },
  { expr: 'a week from today', expect: '2026-11-21' },
  { expr: 'seven days from now', expect: '2026-11-21' },
  { expr: 'by next Saturday', expect: '2026-11-21' },
  { expr: 'move it to next Friday', expect: '2026-11-20' },
  { expr: 'this Friday', expect: '2026-11-20' },
  { expr: 'today', expect: '2026-11-14' },
  { expr: 'tomorrow', expect: '2026-11-15' },
  { expr: 'in 3 days', expect: '2026-11-17' },
  { expr: 'in two weeks', expect: '2026-11-28' },
  { expr: 'in 48 hours', expect: '2026-11-16' },
  { expr: 'end of the month', expect: '2026-11-30' },
  { expr: 'beginning of next month', expect: '2026-12-01' },
  { expr: 'next semester', expect: null, note: 'ambiguous → ask, do not guess' },
];

function run(cases: Case[], label: string): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  console.log(`\n${label} (now=${NOW.toISOString().slice(0, 10)} ${TZ})`);
  for (const c of cases) {
    const r = resolve(c.expr, { now: NOW, tz: TZ });
    const ok = r.iso === c.expect;
    // A resolvable phrase must never come back low-confidence (would trigger a
    // "give me YYYY-MM-DD" style question).
    const badClarify = c.expect !== null && r.confidence === 'low';
    const good = ok && !badClarify;
    if (good) pass++;
    else fail++;
    const mark = good ? '✓' : '✗';
    console.log(
      `  ${mark} ${JSON.stringify(c.expr).padEnd(26)} → ${String(r.iso).padEnd(12)} ` +
        `expected ${String(c.expect)}${c.note ? `  (${c.note})` : ''}`,
    );
  }
  console.log(`  ${pass}/${cases.length} passed`);
  return { pass, fail };
}

const req = run(REQUIRED, 'REQUIRED date cases');

console.log(`\nRESULT  required: ${req.pass}/${REQUIRED.length}`);
if (req.fail > 0) {
  console.error('FAIL — deterministic date layer regressed.');
  process.exit(1);
}
console.log('OK — deterministic date layer correct.');
