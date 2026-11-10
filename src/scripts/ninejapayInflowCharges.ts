/**
 * Report what 9jaPay kept from students' payments: for every one-time
 * (transient) account, what arrived, what the closure transfer moved on to
 * the business account, and any other debit on it (a charge, VAT, stamp duty).
 * Reads 9jaPay only, never the database.
 *
 *   node dist/scripts/ninejapayInflowCharges.js [start YYYY-MM-DD] [end YYYY-MM-DD]
 *
 * Defaults to the last 7 days. Compare "kept" with the 1.5% Duevy charges
 * (COLLECTION_FEE_BPS) to see whether it covers 9jaPay's inflow pricing.
 */
import { env } from '../config/env';
import { NineJaPayClient } from '../providers/payment/ninejapay/client';

interface Row {
  accountNumber?: string;
  transactionType?: string;
  amount?: number | string;
  narration?: string;
  transactionDate?: string;
}

const PAGE_SIZE = 100;
const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

export async function inflowCharges(start: string, end: string, log: (line: string) => void = console.log) {
  const client = new NineJaPayClient(env.NINEJAPAY_BASE_URL, env.NINEJAPAY_API_KEY ?? '', env.NINEJAPAY_SECRET_KEY ?? '');

  const transient = new Set<string>();
  for (let page = 1; ; page++) {
    const res = await client.request<{ accountNumber: string; accountType?: string }[]>({
      method: 'GET', path: '/v1/api/virtual-accounts', op: 'report.accounts',
      query: { 'page-size': String(PAGE_SIZE), 'page-number': String(page) },
    });
    const batch = res.data ?? [];
    for (const a of batch) if (/transient/i.test(a.accountType ?? '')) transient.add(a.accountNumber);
    if (batch.length < PAGE_SIZE) break;
  }

  const byAccount = new Map<string, { received: number; moved: number; other: { narration: string; amount: number }[]; at: string }>();
  for (let page = 1; ; page++) {
    const res = await client.request<Row[]>({
      method: 'GET', path: '/v1/api/transactions', op: 'report.transactions',
      query: { 'page-size': String(PAGE_SIZE), 'page-number': String(page), 'start-date': start, 'end-date': end },
    });
    const batch = res.data ?? [];
    for (const t of batch) {
      if (!t.accountNumber || !transient.has(t.accountNumber)) continue;
      const acc = byAccount.get(t.accountNumber) ?? { received: 0, moved: 0, other: [], at: t.transactionDate ?? '' };
      const amount = Number(t.amount ?? 0);
      if ((t.transactionType ?? '').toLowerCase() === 'credit') acc.received += amount;
      else if (/VIRTUAL ACCOUNT CLOSURE/i.test(t.narration ?? '')) acc.moved += amount;
      else acc.other.push({ narration: t.narration ?? '', amount });
      byAccount.set(t.accountNumber, acc);
    }
    if (batch.length < PAGE_SIZE) break;
  }

  // A reused account number holds several payments; totals still show what was kept.
  let received = 0;
  let kept = 0;
  log(`9jaPay inflow charges, ${start} → ${end}`);
  for (const [n, a] of [...byAccount].sort((x, y) => x[1].at.localeCompare(y[1].at))) {
    if (a.received === 0) continue;
    const k = a.received - a.moved;
    received += a.received;
    kept += k;
    const extra = a.other.length ? `  other debits: ${a.other.map((o) => `${o.narration} ${naira(o.amount)}`).join('; ')}` : '';
    log(`  ${a.at.slice(0, 16)}  ••${n.slice(-4)}  received ${naira(a.received)}  moved ${naira(a.moved)}  kept ${naira(k)}${a.moved === 0 ? ' (not moved yet)' : ''}${extra}`);
  }
  log(`total: ${byAccount.size} account(s), received ${naira(received)}, kept by 9jaPay ${naira(kept)}`);
  return { received, kept };
}

if (require.main === module) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const [start = day(new Date(Date.now() - 7 * 86_400_000)), end = day(new Date(Date.now() + 86_400_000))] = process.argv.slice(2);
  inflowCharges(start, end).catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
