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

async function probeDatabase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
    ]);
    const latencyMs = Date.now() - start;
    return { name: 'Database', status: latencyMs > 2000 ? 'degraded' : 'operational', latencyMs, checkedAt: new Date().toISOString() };
  } catch {
    return { name: 'Database', status: 'down', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  }
}

async function probePayments(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await Promise.race([
      getPaymentProvider().listBanks(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const latencyMs = Date.now() - start;
    return { name: 'Payments', status: latencyMs > 4000 ? 'degraded' : 'operational', latencyMs, checkedAt: new Date().toISOString() };
  } catch {
    return { name: 'Payments', status: 'down', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  }
}

async function probeWithdrawals(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      getPaymentProvider().resolveAccount('000013', '0000000000'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const latencyMs = Date.now() - start;
    // resolveAccount returns null for an unknown account — that's fine, the service answered.
    return { name: 'Withdrawals', status: latencyMs > 4000 ? 'degraded' : 'operational', latencyMs, checkedAt: new Date().toISOString() };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = (err as Error).message ?? '';
    // A 422 / "not found" means the API answered — the service is up.
    if (msg.includes('not') || msg.includes('422')) {
      return { name: 'Withdrawals', status: latencyMs > 4000 ? 'degraded' : 'operational', latencyMs, checkedAt: new Date().toISOString() };
    }
    return { name: 'Withdrawals', status: 'down', latencyMs, checkedAt: new Date().toISOString() };
  }
}

// GET /v1/public/status
statusRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const [database, payments, withdrawals] = await Promise.all([
    probeDatabase(),
    probePayments(),
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
