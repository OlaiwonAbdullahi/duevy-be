import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { ok, fail } from '../lib/response';
import { env } from '../config/env';
import { handleMessage, resetSession } from '../ai/agent';
import { createLinkCode } from '../ai/identity';

/**
 * AI assistant — the same agent that drives the WhatsApp bot, over HTTP, so the
 * web dashboard has the chat too. Authenticated; every action the agent takes
 * runs as this user through the normal REST API (see src/ai/).
 *
 * Mounted at /ai.
 */
export const aiRouter = Router();

aiRouter.use(authenticate);
aiRouter.use((_req: Request, res: Response, next) => {
  if (!env.AI_ENABLED) {
    fail(res, 503, 'AI_DISABLED', 'The AI assistant is not enabled on this server.');
    return;
  }
  next();
});

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

const chatSchema = z.object({ message: z.string().trim().min(1).max(2000) });

// POST /ai/chat — one turn of conversation.
aiRouter.post('/chat', validate(chatSchema), async (req: Request, res: Response): Promise<void> => {
  const { message } = req.body as z.infer<typeof chatSchema>;
  const reply = await handleMessage(uid(req), message);
  ok(res, { reply });
});

// POST /ai/reset — clear the conversation context.
aiRouter.post('/reset', (req: Request, res: Response): void => {
  resetSession(uid(req));
  ok(res, { reset: true });
});

// POST /ai/link/whatsapp — get a one-time code to link your WhatsApp number.
aiRouter.post('/link/whatsapp', (req: Request, res: Response): void => {
  const { code, expiresInMinutes } = createLinkCode(uid(req));
  ok(res, {
    code,
    expiresInMinutes,
    instruction: `Send "link ${code}" to the Duevy WhatsApp bot within ${expiresInMinutes} minutes to connect your number.`,
  });
});
