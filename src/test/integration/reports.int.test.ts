import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../config/db';
import { createCheckout, findCheckoutId, fulfilCheckout } from '../../services/checkout.service';
import { appendLedgerEntry } from '../../services/ledger.service';
import { lagosDate, lagosDayEnd, lagosDayStart } from '../../services/reports.service';
import { installFakeProvider, makeSpace, startHttp, stopHttp, tokenFor } from './fixtures';

/**
 * Admin reports are built from the 9jaPay-era records — checkouts, space
 * ledgers, payouts, sweeps and direct deposits — in naira, over whole Lagos days.
 */

let token: string;
let base = '';
beforeAll(async () => {
  installFakeProvider();
  base = await startHttp();
  const admin = await db.user.create({
    data: { name: 'Admin', email: `admin_${Date.now()}_${Math.random()}@test.duevy`, role: 'admin', adminSubRole: 'super_admin' },
  });
  await db.adminPermission.create({ data: { userId: admin.id, userManagement: true, payouts: true, disputes: true, overrides: true } });
  token = await tokenFor(admin);
});
afterAll(stopHttp);

const today = () => lagosDate(new Date());

async function post(body: Record<string, unknown>) {
  const res = await fetch(`${base}/v1/admin/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function download(id: string) {
  const res = await fetch(`${base}/v1/admin/reports/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) };
}

/** CSV → rows of cells (simple: no quoted commas in the cells we assert on). */
function rowsOf(csv: string) {
  return csv.replace(/^﻿/, '').split('\r\n').map((l) => l.split(','));
}
const find = (rows: string[][], label: string) => rows.find((r) => r[0]?.replace(/^"|"$/g, '') === label);

/** A space with one ₦5,000 student payment (+ fee), a ₦2,500 direct deposit and a paid-out ₦1,000 withdrawal. */
async function seeded() {
  const s = await makeSpace({ dues: [500_000] });
  const { checkout } = await createCheckout(s.students[0]!.id, [s.dues[0]!.id]);
  await fulfilCheckout(await findCheckoutId(checkout.reference, null), checkout.amount, 0, 'test');

  const deposit = await db.directDeposit.create({
    data: { spaceId: s.space.id, providerTransactionId: `dd_${Date.now()}_${Math.random()}`, amountKobo: 250_000, senderName: 'Alumni', receivedAt: new Date() },
  });
  await db.$transaction((tx) =>
    appendLedgerEntry(tx, { spaceId: s.space.id, type: 'direct_deposit', direction: 'credit', amountKobo: 250_000, reference: deposit.providerTransactionId, description: 'Direct deposit', directDepositId: deposit.id }),
  );

  const ref = `WDRPT${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const payout = await db.payout.create({
    data: { spaceId: s.space.id, amount: 100_000, feeKobo: 5_375, netKobo: 94_625, reference: ref, status: 'success', settledAt: new Date(), accountMasked: 'GTBank •••• 6789', requestedById: s.rep.id },
  });
  await db.$transaction(async (tx) => {
    await appendLedgerEntry(tx, { spaceId: s.space.id, payoutId: payout.id, type: 'payout', direction: 'debit', amountKobo: 94_625, reference: ref, description: 'Withdrawal' });
    await appendLedgerEntry(tx, { spaceId: s.space.id, payoutId: payout.id, type: 'payout_fee', direction: 'debit', amountKobo: 5_375, reference: ref, description: 'Withdrawal fee' });
  });
  await db.sweep.create({
    data: { spaceId: s.space.id, amountKobo: 500_000, feeKobo: 5_000, reference: `SWPRPT${Date.now()}${Math.floor(Math.random() * 1e6)}`, status: 'succeeded', trigger: 'daily', settledAt: new Date() },
  });
  return { ...s, checkout };
}

describe('Lagos day bounds', () => {
  it('covers whole Lagos days', () => {
    expect(lagosDayStart('2026-11-01').toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(lagosDayEnd('2026-11-30').toISOString()).toBe('2026-11-30T22:59:59.999Z');
    expect(lagosDate(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
  });
});

describe('POST /admin/reports', () => {
  it('returns the inclusive dates and space, and refuses an unknown space', async () => {
    const s = await makeSpace();
    const res = await post({ scope: 'space_collection', format: 'csv', from: '2026-11-01', to: '2026-11-30', spaceId: s.space.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ from: '2026-11-01', to: '2026-11-30', spaceId: s.space.id, spaceName: s.space.name, status: 'ready' });

    const bad = await post({ scope: 'space_collection', format: 'csv', from: '2026-11-01', to: '2026-11-30', spaceId: 'nope' });
    expect(bad.status).toBe(400);
    expect((await post({ scope: 'full_ledger', format: 'csv', from: '2026-11-30', to: '2026-11-01' })).status).toBe(400);
    expect((await post({ scope: 'full_ledger', format: 'csv', from: '2025-01-01', to: '2026-11-01' })).status).toBe(400);
  });
});

describe('report contents', () => {
  it('financial summary: 9jaPay money in naira, for one space, including today', async () => {
    const s = await seeded();
    const created = await post({ scope: 'financial_summary', format: 'csv', from: today(), to: today(), spaceId: s.space.id });
    const file = await download(created.body.data.id);
    expect(file.status).toBe(200);
    expect(file.disposition).toContain(`duevy-financial-summary-${today()}-to-${today()}.csv`);
    const rows = rowsOf(file.buf.toString('utf8'));
    const fee = s.checkout.amount - 500_000;

    expect(find(rows, 'Payments received from students and guests')?.slice(1)).toEqual(['1', (s.checkout.amount / 100).toFixed(2)]);
    expect(find(rows, '  of which dues credited to spaces')?.[2]).toBe('5000.00');
    expect(find(rows, '  of which Duevy processing fees')?.[2]).toBe((fee / 100).toFixed(2));
    expect(find(rows, 'Direct deposits into space accounts')?.slice(1)).toEqual(['1', '2500.00']);
    expect(find(rows, 'Withdrawals paid out (gross from space balances)')?.slice(1)).toEqual(['1', '1000.00']);
    expect(find(rows, '  sent to reps’ banks')?.[2]).toBe('946.25');
    expect(find(rows, 'Sweeps into space accounts')?.slice(1)).toEqual(['1', '5000.00']);
    expect(find(rows, '9jaPay sweep charges (Duevy cost)')?.[2]).toBe('50.00');
    // 5,000 + 2,500 − 1,000
    expect(find(rows, 'Owed to this space at end of period')?.[2]).toBe('6500.00');
  });

  it("leaves out what happened outside the range", async () => {
    const s = await seeded();
    const created = await post({ scope: 'financial_summary', format: 'csv', from: '2020-01-01', to: '2020-01-31', spaceId: s.space.id });
    const rows = rowsOf((await download(created.body.data.id)).buf.toString('utf8'));
    expect(find(rows, 'Payments received from students and guests')?.slice(1)).toEqual(['0', '0.00']);
  });

  it('per-space collection', async () => {
    const s = await seeded();
    const created = await post({ scope: 'space_collection', format: 'csv', from: today(), to: today(), spaceId: s.space.id });
    const rows = rowsOf((await download(created.body.data.id)).buf.toString('utf8'));
    const row = find(rows, s.space.name)!;
    // Space, Code, Account, Members, Payments, Collected, Deposits, Withdrawals, Withdrawn, Balance
    expect(row.slice(3)).toEqual(['2', '1', '5000.00', '2500.00', '1', '1000.00', '6500.00']);
  });

  it('per-rep performance', async () => {
    const s = await seeded();
    const created = await post({ scope: 'rep_performance', format: 'csv', from: today(), to: today(), spaceId: s.space.id });
    const rows = rowsOf((await download(created.body.data.id)).buf.toString('utf8'));
    const row = find(rows, 'Ada Obi')!;
    // Rep, Email, Space, Role, Members, Paid, Share, Collected, Withdrawals, Withdrawn
    expect(row.slice(3)).toEqual(['Lead', '2', '1', '50%', '5000.00', '1', '1000.00']);
  });

  it('space ledger lists every balance movement with the payer', async () => {
    const s = await seeded();
    const created = await post({ scope: 'full_ledger', format: 'csv', from: today(), to: today(), spaceId: s.space.id });
    const text = (await download(created.body.data.id)).buf.toString('utf8');
    expect(text).toContain('Dues payment');
    expect(text).toContain(s.students[0]!.email);
    expect(text).toContain('Direct deposit');
    expect(text).toContain('Withdrawal fee');
    const totals = rowsOf(text).find((r) => r[0]?.startsWith('Total ('))!;
    expect(totals.slice(4, 6)).toEqual(['7500.00', '1000.00']);
  });

  it('renders a PDF', async () => {
    const s = await seeded();
    const created = await post({ scope: 'full_ledger', format: 'pdf', from: today(), to: today(), spaceId: s.space.id });
    const file = await download(created.body.data.id);
    expect(file.type).toBe('application/pdf');
    expect(file.buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
