import { logger } from '../lib/logger';
import { checkPaymentMilestone } from '../services/milestones.service';

/** Checks for a new payments milestone every few minutes (milestones.service.ts). */
let running: Promise<unknown> | null = null;

export function startMilestoneJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    if (running) return;
    running = checkPaymentMilestone()
      .catch((err) => logger.error({ err: (err as Error).message }, 'milestone check failed'))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
}
