import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { assistantLimiter } from '../middleware/rateLimiter';
import { ok, errors, fail } from '../lib/response';
import { classify, execute, formatResponse, confirmJoinDepartment } from '../services/assistant.service';
import { type ConversationTurn } from '../types/assistant';

export const assistantRouter = Router();
assistantRouter.use(authenticate);
assistantRouter.use(assistantLimiter);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.sub as string;
}

// How many prior turns to feed back to Gemma as context (§ conversation state).
const HISTORY_TURNS = 5;

async function loadConversation(userId: string, conversationId: string | undefined) {
  if (conversationId) {
    const existing = await db.assistantConversation.findFirst({ where: { id: conversationId, userId } });
    if (existing) return existing;
  }
  return db.assistantConversation.create({ data: { userId } });
}

// ---------------------------------------------------------------------------
// POST /assistant/message — classify + validate + (read-only) execute
// ---------------------------------------------------------------------------
const messageSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1).max(1000),
});

assistantRouter.post('/message', validate(messageSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = uid(req);
  const { conversationId, message } = req.body as z.infer<typeof messageSchema>;

  const conversation = await loadConversation(userId, conversationId);

  const priorMessages = await db.assistantMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TURNS,
  });
  const history: ConversationTurn[] = priorMessages
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  const classification = await classify(message, history);
  const handlerResult = await execute(userId, classification);
  const response = formatResponse(conversation.id, classification, handlerResult);

  // Persisted for multi-turn clarification context and for later fine-tuning
  // evaluation (intent + confidence logged on every request, §ANM).
  await db.$transaction([
    db.assistantMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: message },
    }),
    db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: response.reply,
        intent: handlerResult.intent,
        params: classification.params ?? undefined,
        confidence: classification.confidence,
      },
    }),
  ]);

  ok(res, response);
});

// ---------------------------------------------------------------------------
// POST /assistant/confirm — executes join_department only after an explicit
// frontend button tap. pay_dues never executes here — the frontend opens the
// real payment modal from the `action` in the /message response and charges
// through the existing POST /dues/:dueId/pay endpoint (§ safety rules).
// ---------------------------------------------------------------------------
const confirmSchema = z.object({
  conversationId: z.string(),
  spaceId: z.string(),
  inviteCode: z.string(),
});

assistantRouter.post('/confirm', validate(confirmSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = uid(req);
  const { conversationId, spaceId, inviteCode } = req.body as z.infer<typeof confirmSchema>;

  const conversation = await db.assistantConversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) {
    errors.notFound(res, 'Conversation not found');
    return;
  }

  const result = await confirmJoinDepartment(userId, spaceId, inviteCode);

  if (result.status === 'invalid_code') {
    fail(res, 422, 'JOIN_CODE_INVALID', 'That join code is no longer valid');
    return;
  }
  if (result.status === 'already_member') {
    ok(res, { status: 'already_member', spaceName: result.spaceName });
    return;
  }
  ok(res, { status: 'joined', spaceName: result.spaceName, joinedAt: result.joinedAt.toISOString() }, 201);
});
