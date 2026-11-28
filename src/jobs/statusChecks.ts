import { db } from '../config/db';
import { logger } from '../lib/logger';
import { getPaymentProvider } from '../providers/payment';

type Status = 'operational' | 'degraded' | 'down';

interface ProbeResult {
  service: string;
  status: Status;
  latencyMs: number;
}

async function probeDatabase(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
    ]);
    const ms = Date.now() - start;
    return { service: 'database', status: ms > 2000 ? 'degraded' : 'operational', latencyMs: ms };
  } catch {
    return { service: 'database', status: 'down', latencyMs: Date.now() - start };
  }
}

async function probeCollections(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([
      getPaymentProvider().getCollectionStatus('0000000000', { from: new Date(), to: new Date() }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const ms = Date.now() - start;
    return { service: 'payments', status: ms > 4000 ? 'degraded' : 'operational', latencyMs: ms };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = (err as Error).message ?? '';
    if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      return { service: 'payments', status: 'down', latencyMs: ms };
    }
    return { service: 'payments', status: ms > 4000 ? 'degraded' : 'operational', latencyMs: ms };
  }
}

async function probeWithdrawals(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([
      getPaymentProvider().resolveAccount('000013', '0000000000'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    const ms = Date.now() - start;
    return { service: 'withdrawals', status: ms > 4000 ? 'degraded' : 'operational', latencyMs: ms };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = (err as Error).message ?? '';
    if (msg.includes('not') || msg.includes('422')) {
      return { service: 'withdrawals', status: ms > 4000 ? 'degraded' : 'operational', latencyMs: ms };
    }
    return { service: 'withdrawals', status: 'down', latencyMs: ms };
  }
}

async function runStatusCheckOnce(): Promise<void> {
  const results = await Promise.all([probeDatabase(), probeCollections(), probeWithdrawals()]);

  await db.statusCheck.createMany({
    data: results.map((r) => ({
      service: r.service,
      status: r.status,
      latencyMs: r.latencyMs,
    })),
  });

  // Prune checks older than 90 days.
  await db.statusCheck.deleteMany({
    where: { checkedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
  });

  logger.debug({ results: results.map((r) => `${r.service}=${r.status}`) }, 'status check stored');
}

let running: Promise<void> | null = null;

/** Run health probes every 5 minutes. Returns a handle for shutdown. */
export function startStatusCheckJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    if (running) return;
    running = runStatusCheckOnce()
      .catch((err) => logger.warn({ err: (err as Error).message }, 'status check job failed'))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
}
