import { Router, type Request, type Response } from 'express';
import { ok } from '../lib/response';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';
import { db } from '../config/db';

export const statusRouter = Router();

interface ServiceStatus {
  name: string;
  status: 'operational' | 'degraded' | 'down';
  latencyMs?: number;
  checkedAt: string;
}

function result(name: string, status: ServiceStatus['status'], latencyMs: number): ServiceStatus {
  return { name, status, latencyMs, checkedAt: new Date().toISOString() };
}

async function probeDatabase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
    ]);
    const ms = Date.now() - start;
    return result('Database', ms > 2000 ? 'degraded' : 'operational', ms);
  } catch {
    return result('Database', 'down', Date.now() - start);
  }
}

async function probeCollections(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await Promise.race([
      getPaymentProvider().getCollectionStatus('0000000000', { from: new Date(), to: new Date() }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const ms = Date.now() - start;
    return result('Payments', ms > 4000 ? 'degraded' : 'operational', ms);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = (err as Error).message ?? '';
    if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      return result('Payments', 'down', ms);
    }
    return result('Payments', ms > 4000 ? 'degraded' : 'operational', ms);
  }
}

async function probeWithdrawals(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await Promise.race([
      getPaymentProvider().resolveAccount('000013', '0000000000'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const ms = Date.now() - start;
    return result('Withdrawals', ms > 4000 ? 'degraded' : 'operational', ms);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = (err as Error).message ?? '';
    if (msg.includes('not') || msg.includes('422')) {
      return result('Withdrawals', ms > 4000 ? 'degraded' : 'operational', ms);
    }
    return result('Withdrawals', 'down', ms);
  }
}

// GET /v1/public/status — live probe
statusRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const [database, payments, withdrawals] = await Promise.all([
    probeDatabase(),
    probeCollections(),
    probeWithdrawals(),
  ]);

  const services = [database, payments, withdrawals];
  const overall = services.some((s) => s.status === 'down')
    ? 'down'
    : services.some((s) => s.status === 'degraded')
      ? 'degraded'
      : 'operational';

  logger.debug({ overall, services }, 'status check');
  ok(res, { overall, services, checkedAt: new Date().toISOString() });
});

// GET /v1/public/status/history?days=90 — daily uptime percentages
statusRouter.get('/status/history', async (req: Request, res: Response): Promise<void> => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db.$queryRaw<
    { day: string; service: string; total: bigint; operational: bigint; degraded: bigint; down: bigint }[]
  >`
    SELECT
      TO_CHAR("checkedAt" AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
      service,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE status = 'operational')::bigint AS operational,
      COUNT(*) FILTER (WHERE status = 'degraded')::bigint AS degraded,
      COUNT(*) FILTER (WHERE status = 'down')::bigint AS down
    FROM status_checks
    WHERE "checkedAt" >= ${since}
    GROUP BY day, service
    ORDER BY day ASC, service ASC
  `;

  const history: Record<string, { day: string; services: Record<string, { uptime: number; status: string }> }> = {};

  for (const row of rows) {
    if (!history[row.day]) history[row.day] = { day: row.day, services: {} };
    const total = Number(row.total);
    const down = Number(row.down);
    const degraded = Number(row.degraded);
    const uptime = total > 0 ? Math.round(((total - down) / total) * 10000) / 100 : 100;
    const status = down > 0 ? 'down' : degraded > 0 ? 'degraded' : 'operational';
    history[row.day].services[row.service] = { uptime, status };
  }

  ok(res, { days: Object.values(history), since: since.toISOString() });
});
