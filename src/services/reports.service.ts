import { Prisma, type Report } from '@prisma/client';
import { db } from '../config/db';
import { splitWithdrawalFee } from '../lib/money';

/**
 * Admin reports (§14.9), built from the records 9jaPay-era money actually
 * lands in:
 *
 *   checkouts        — what students/guests paid, Duevy's processing fee
 *   ledger_entries   — each space's balance: payments, direct deposits,
 *                      withdrawals (+ fees), reversals, manual credits
 *   payouts          — withdrawals to reps' banks, 9jaPay's charge + VAT
 *   sweeps           — business account → space account (9jaPay bills Duevy)
 *   direct_deposits  — money sent straight to a space's account
 *
 * The old `transactions` table is not used: under 9jaPay only manual credits
 * and referral rewards are written there.
 *
 * Dates are Lagos calendar days (UTC+1, no DST): `from` 00:00 to `to` 23:59:59.999.
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_LEDGER_ROWS = 50_000;

/** "2026-11-01" → 00:00 that day in Lagos, as a UTC instant. */
export function lagosDayStart(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - LAGOS_OFFSET_MS);
}

/** "2026-11-30" → 23:59:59.999 that day in Lagos. */
export function lagosDayEnd(ymd: string): Date {
  return new Date(lagosDayStart(ymd).getTime() + DAY_MS - 1);
}

/** A UTC instant as its Lagos calendar date, "YYYY-MM-DD". */
export function lagosDate(d: Date): string {
  return new Date(d.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** A UTC instant as Lagos "YYYY-MM-DD HH:mm". */
function lagosDateTime(d: Date): string {
  return new Date(d.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// The table every report renders to (CSV and PDF)
// ---------------------------------------------------------------------------

export type CellKind = 'text' | 'money' | 'count' | 'percent';
export type Cell = string | number | null;

export interface ReportTable {
  title: string;
  /** Lines under the title: range, filter, notes. */
  subtitle: string[];
  columns: { label: string; kind?: CellKind }[];
  rows: Cell[][];
  /** Optional closing row (e.g. totals), rendered bold. */
  totals?: Cell[];
}

export const SCOPE_TITLES: Record<Report['scope'], string> = {
  financial_summary: 'Financial summary',
  space_collection: 'Per-space collection',
  rep_performance: 'Per-rep performance',
  full_ledger: 'Space ledger',
};

/** Kobo → naira as a plain number (CSV keeps it numeric for spreadsheets). */
const naira = (kobo: number | bigint | null | undefined) => Math.round(Number(kobo ?? 0)) / 100;

export function formatCell(value: Cell, kind: CellKind = 'text', forPdf = false): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (kind === 'money') {
      const fixed = value.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return forPdf ? `₦${fixed}` : value.toFixed(2);
    }
    if (kind === 'percent') return `${Math.round(value * 100)}%`;
    return forPdf ? value.toLocaleString('en-NG') : String(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Range = { gte: Date; lte: Date };

export async function buildReport(report: Pick<Report, 'scope' | 'fromDate' | 'toDate' | 'spaceId'>): Promise<ReportTable> {
  const range: Range = { gte: report.fromDate, lte: report.toDate };
  const space = report.spaceId
    ? await db.space.findUnique({ where: { id: report.spaceId }, select: { id: true, name: true, short: true } })
    : null;
  const subtitle = [
    `${lagosDate(report.fromDate)} to ${lagosDate(report.toDate)} (Lagos time)`,
    space ? `Space: ${space.name} (${space.short})` : 'All spaces',
    'Amounts in naira (NGN).',
  ];
  const ctx = { range, spaceId: report.spaceId ?? null, subtitle };
  switch (report.scope) {
    case 'financial_summary':
      return financialSummary(ctx);
    case 'space_collection':
      return spaceCollection(ctx);
    case 'rep_performance':
      return repPerformance(ctx);
    case 'full_ledger':
      return spaceLedger(ctx);
  }
}

interface Ctx {
  range: Range;
  spaceId: string | null;
  subtitle: string[];
}

async function financialSummary({ range, spaceId, subtitle }: Ctx): Promise<ReportTable> {
  const bySpace = spaceId ? { spaceId } : {};
  const [paid, flagged, deposits, manual, refunds, paidOut, failed, sweeps, balanceAgg] = await Promise.all([
    db.checkout.aggregate({ where: { ...bySpace, status: 'paid', paidAt: range }, _count: { _all: true }, _sum: { totalKobo: true, faceKobo: true, feeKobo: true, overpaidKobo: true } }),
    db.checkout.count({ where: { ...bySpace, needsReview: true, createdAt: range } }),
    db.directDeposit.aggregate({ where: { ...bySpace, receivedAt: range }, _count: { _all: true }, _sum: { amountKobo: true } }),
    db.ledgerEntry.aggregate({ where: { ...bySpace, type: 'manual_credit', createdAt: range }, _count: { _all: true }, _sum: { amountKobo: true } }),
    db.ledgerEntry.aggregate({ where: { ...bySpace, type: 'refund', createdAt: range }, _count: { _all: true }, _sum: { amountKobo: true } }),
    db.payout.findMany({ where: { ...bySpace, status: 'success', settledAt: range }, select: { amount: true, feeKobo: true, netKobo: true, provider: true, duevyFeeKobo: true, anchorFeeKobo: true, stampDutyKobo: true, netSentKobo: true } }),
    db.payout.aggregate({
      where: { ...bySpace, OR: [{ status: 'failed', failedAt: range }, { status: 'reversed', reversedAt: range }] },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.sweep.aggregate({ where: { ...bySpace, status: 'succeeded', settledAt: range }, _count: { _all: true }, _sum: { amountKobo: true, feeKobo: true } }),
    db.ledgerEntry.groupBy({ by: ['direction'], where: { ...bySpace, createdAt: { lte: range.lte } }, _sum: { amountKobo: true } }),
  ]);

  let gross = 0;
  let net = 0;
  let charge = 0;
  let vat = 0;
  for (const p of paidOut) {
    const legacy = p.provider === 'anchor';
    const fee = legacy ? p.duevyFeeKobo + p.anchorFeeKobo + p.stampDutyKobo : p.feeKobo;
    const split = legacy ? { chargeKobo: fee, vatKobo: 0 } : splitWithdrawalFee(fee);
    gross += p.amount;
    net += legacy ? p.netSentKobo : p.netKobo;
    charge += split.chargeKobo;
    vat += split.vatKobo;
  }
  const credits = balanceAgg.find((g) => g.direction === 'credit')?._sum.amountKobo ?? 0;
  const debits = balanceAgg.find((g) => g.direction === 'debit')?._sum.amountKobo ?? 0;
  const processingFees = paid._sum.feeKobo ?? 0;
  const sweepCharges = sweeps._sum.feeKobo ?? 0;

  const section = (label: string): Cell[] => [label, null, null];
  return {
    title: SCOPE_TITLES.financial_summary,
    subtitle,
    columns: [{ label: 'Metric' }, { label: 'Count', kind: 'count' }, { label: 'Amount (NGN)', kind: 'money' }],
    rows: [
      section('MONEY IN'),
      ['Payments received from students and guests', paid._count._all, naira(paid._sum.totalKobo)],
      ['  of which dues credited to spaces', null, naira(paid._sum.faceKobo)],
      ['  of which Duevy processing fees', null, naira(processingFees)],
      ['  overpayments flagged for refund', null, naira(paid._sum.overpaidKobo)],
      ['Direct deposits into space accounts', deposits._count._all, naira(deposits._sum.amountKobo)],
      ['Manual credits by admins', manual._count._all, naira(manual._sum.amountKobo)],
      ['Payments flagged for review (created in period)', flagged, null],
      section('MONEY OUT'),
      ['Withdrawals paid out (gross from space balances)', paidOut.length, naira(gross)],
      ['  sent to reps’ banks', null, naira(net)],
      ['  9jaPay transfer charges', null, naira(charge)],
      ['  VAT on transfer charges', null, naira(vat)],
      ['Withdrawals failed or reversed (balance restored)', failed._count._all, naira(failed._sum.amount)],
      ['Refunds', refunds._count._all, naira(refunds._sum.amountKobo)],
      section('SETTLEMENT'),
      ['Sweeps into space accounts', sweeps._count._all, naira(sweeps._sum.amountKobo)],
      ['9jaPay sweep charges (Duevy cost)', null, naira(sweepCharges)],
      section('DUEVY'),
      ['Net revenue (processing fees - sweep charges)', null, naira(processingFees - sweepCharges)],
      [`Owed to ${spaceId ? 'this space' : 'spaces'} at end of period`, null, naira(Math.max(0, credits - debits))],
    ],
  };
}

async function spaceCollection({ range, spaceId, subtitle }: Ctx): Promise<ReportTable> {
  const spaceFilter = spaceId ? Prisma.sql`AND s."id" = ${spaceId}` : Prisma.empty;
  const rows = await db.$queryRaw<
    {
      name: string;
      short: string;
      account: string | null;
      archived: boolean;
      members: number;
      payments: number;
      collected: bigint;
      deposits: bigint;
      withdrawals: number;
      withdrawn: bigint;
      balance: bigint;
    }[]
  >`
    SELECT s."name", s."short", s."walletAccountNumber" AS account, s."isArchived" AS archived,
      (SELECT COUNT(*)::int FROM "space_memberships" m WHERE m."spaceId" = s."id") AS members,
      (SELECT COUNT(*)::int FROM "checkouts" c WHERE c."spaceId" = s."id" AND c."status" = 'paid' AND c."paidAt" BETWEEN ${range.gte} AND ${range.lte}) AS payments,
      (SELECT COALESCE(SUM(c."faceKobo"), 0)::bigint FROM "checkouts" c WHERE c."spaceId" = s."id" AND c."status" = 'paid' AND c."paidAt" BETWEEN ${range.gte} AND ${range.lte}) AS collected,
      (SELECT COALESCE(SUM(d."amountKobo"), 0)::bigint FROM "direct_deposits" d WHERE d."spaceId" = s."id" AND d."receivedAt" BETWEEN ${range.gte} AND ${range.lte}) AS deposits,
      (SELECT COUNT(*)::int FROM "payouts" p WHERE p."spaceId" = s."id" AND p."status" = 'success' AND p."settledAt" BETWEEN ${range.gte} AND ${range.lte}) AS withdrawals,
      (SELECT COALESCE(SUM(p."amount"), 0)::bigint FROM "payouts" p WHERE p."spaceId" = s."id" AND p."status" = 'success' AND p."settledAt" BETWEEN ${range.gte} AND ${range.lte}) AS withdrawn,
      (SELECT COALESCE(SUM(CASE WHEN le."direction" = 'credit' THEN le."amountKobo" ELSE -le."amountKobo" END), 0)::bigint
         FROM "ledger_entries" le WHERE le."spaceId" = s."id" AND le."createdAt" <= ${range.lte}) AS balance
    FROM "spaces" s
    WHERE TRUE ${spaceFilter}
    ORDER BY collected DESC, s."name" ASC`;

  // Archived spaces with nothing in the period are noise.
  const shown = rows.filter((r) => !r.archived || r.payments > 0 || Number(r.deposits) > 0 || r.withdrawals > 0 || Number(r.balance) !== 0);
  const total = (f: (r: (typeof rows)[number]) => number) => shown.reduce((s, r) => s + f(r), 0);
  return {
    title: SCOPE_TITLES.space_collection,
    subtitle,
    columns: [
      { label: 'Space' },
      { label: 'Code' },
      { label: '9jaPay account' },
      { label: 'Members', kind: 'count' },
      { label: 'Payments', kind: 'count' },
      { label: 'Dues collected (NGN)', kind: 'money' },
      { label: 'Direct deposits (NGN)', kind: 'money' },
      { label: 'Withdrawals', kind: 'count' },
      { label: 'Withdrawn (NGN)', kind: 'money' },
      { label: 'Balance at end (NGN)', kind: 'money' },
    ],
    rows: shown.map((r) => [
      r.archived ? `${r.name} (archived)` : r.name,
      r.short,
      r.account ?? 'none',
      r.members,
      r.payments,
      naira(r.collected),
      naira(r.deposits),
      r.withdrawals,
      naira(r.withdrawn),
      naira(Math.max(0, Number(r.balance))),
    ]),
    totals:
      shown.length > 1
        ? [
            `Total (${shown.length} spaces)`,
            null,
            null,
            total((r) => r.members),
            total((r) => r.payments),
            naira(total((r) => Number(r.collected))),
            naira(total((r) => Number(r.deposits))),
            total((r) => r.withdrawals),
            naira(total((r) => Number(r.withdrawn))),
            naira(total((r) => Math.max(0, Number(r.balance)))),
          ]
        : undefined,
  };
}

async function repPerformance({ range, spaceId, subtitle }: Ctx): Promise<ReportTable> {
  const spaceFilter = spaceId ? Prisma.sql`AND sr."spaceId" = ${spaceId}` : Prisma.empty;
  const rows = await db.$queryRaw<
    {
      rep: string;
      email: string;
      space: string;
      role: string;
      suspended: boolean;
      members: number;
      payers: number;
      collected: bigint;
      withdrawals: number;
      withdrawn: bigint;
    }[]
  >`
    SELECT u."name" AS rep, u."email", s."name" AS space, sr."role"::text AS role, u."isSuspended" AS suspended,
      (SELECT COUNT(*)::int FROM "space_memberships" m WHERE m."spaceId" = s."id") AS members,
      (SELECT COUNT(DISTINCT c."userId")::int FROM "checkouts" c WHERE c."spaceId" = s."id" AND c."status" = 'paid' AND c."paidAt" BETWEEN ${range.gte} AND ${range.lte}) AS payers,
      (SELECT COALESCE(SUM(c."faceKobo"), 0)::bigint FROM "checkouts" c WHERE c."spaceId" = s."id" AND c."status" = 'paid' AND c."paidAt" BETWEEN ${range.gte} AND ${range.lte}) AS collected,
      (SELECT COUNT(*)::int FROM "payouts" p WHERE p."spaceId" = s."id" AND p."requestedById" = u."id" AND p."status" = 'success' AND p."settledAt" BETWEEN ${range.gte} AND ${range.lte}) AS withdrawals,
      (SELECT COALESCE(SUM(p."amount"), 0)::bigint FROM "payouts" p WHERE p."spaceId" = s."id" AND p."requestedById" = u."id" AND p."status" = 'success' AND p."settledAt" BETWEEN ${range.gte} AND ${range.lte}) AS withdrawn
    FROM "space_reps" sr
    JOIN "users" u ON u."id" = sr."userId"
    JOIN "spaces" s ON s."id" = sr."spaceId"
    WHERE s."isArchived" = FALSE ${spaceFilter}
    ORDER BY collected DESC, s."name" ASC, sr."role" ASC, u."name" ASC`;

  return {
    title: SCOPE_TITLES.rep_performance,
    subtitle: [...subtitle, 'Payers and collected are the whole space’s; withdrawals are the ones each rep made.'],
    columns: [
      { label: 'Rep' },
      { label: 'Email' },
      { label: 'Space' },
      { label: 'Role' },
      { label: 'Members', kind: 'count' },
      { label: 'Members who paid', kind: 'count' },
      { label: 'Payer share', kind: 'percent' },
      { label: 'Collected (NGN)', kind: 'money' },
      { label: 'Withdrawals made', kind: 'count' },
      { label: 'Withdrawn (NGN)', kind: 'money' },
    ],
    rows: rows.map((r) => [
      r.suspended ? `${r.rep} (suspended)` : r.rep,
      r.email,
      r.space,
      r.role === 'lead' ? 'Lead' : 'Co-rep',
      r.members,
      r.payers,
      r.members > 0 ? Math.min(1, r.payers / r.members) : 0,
      naira(r.collected),
      r.withdrawals,
      naira(r.withdrawn),
    ]),
  };
}

const LEDGER_TYPE_LABELS: Record<string, string> = {
  due_payment: 'Dues payment',
  refund: 'Refund',
  payout: 'Withdrawal',
  payout_fee: 'Withdrawal fee',
  payout_reversal: 'Withdrawal restored',
  manual_credit: 'Manual credit',
  direct_deposit: 'Direct deposit',
};

async function spaceLedger({ range, spaceId, subtitle }: Ctx): Promise<ReportTable> {
  const where: Prisma.LedgerEntryWhereInput = { createdAt: range, ...(spaceId ? { spaceId } : {}) };
  const [total, entries] = await Promise.all([
    db.ledgerEntry.count({ where }),
    db.ledgerEntry.findMany({
      where,
      select: {
        createdAt: true,
        type: true,
        direction: true,
        amountKobo: true,
        reference: true,
        description: true,
        space: { select: { name: true } },
        duePayment: { select: { user: { select: { name: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_LEDGER_ROWS,
    }),
  ]);
  let credits = 0;
  let debits = 0;
  for (const e of entries) {
    if (e.direction === 'credit') credits += e.amountKobo;
    else debits += e.amountKobo;
  }
  return {
    title: SCOPE_TITLES.full_ledger,
    subtitle: [
      ...subtitle,
      'Every movement on space balances. Sweeps are not listed: they move money between 9jaPay accounts, not on or off a balance.',
      ...(total > entries.length ? [`Showing the first ${entries.length.toLocaleString('en-NG')} of ${total.toLocaleString('en-NG')} entries. Narrow the range for the rest.`] : []),
    ],
    columns: [
      { label: 'Date (Lagos)' },
      { label: 'Space' },
      { label: 'Type' },
      { label: 'Payer' },
      { label: 'In (NGN)', kind: 'money' },
      { label: 'Out (NGN)', kind: 'money' },
      { label: 'Reference' },
      { label: 'Description' },
    ],
    rows: entries.map((e) => [
      lagosDateTime(e.createdAt),
      e.space.name,
      LEDGER_TYPE_LABELS[e.type] ?? e.type,
      e.duePayment ? `${e.duePayment.user.name} <${e.duePayment.user.email}>` : null,
      e.direction === 'credit' ? naira(e.amountKobo) : null,
      e.direction === 'debit' ? naira(e.amountKobo) : null,
      e.reference,
      e.description,
    ]),
    totals: [`Total (${entries.length} entries)`, null, null, null, naira(credits), naira(debits), null, null],
  };
}
