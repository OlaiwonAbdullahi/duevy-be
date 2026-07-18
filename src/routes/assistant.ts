import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { validate } from '../middleware/validate';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { assistantLimiter } from '../middleware/rateLimiter';
import { ok, errors, fail } from '../lib/response';
import { classify, execute, formatResponse, confirmJoinDepartment, confirmCreateDue } from '../services/assistant.service';
import { type ConversationTurn, DUE_CATEGORIES } from '../types/assistant';

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
// POST /assistant/confirm — executes join_department or create_due only after
// an explicit frontend button tap. pay_dues and fund_wallet never execute here
// — the frontend opens the real payment/top-up modal from the `action` in the
// /message response and charges through the existing dues/wallet endpoints
// (§ safety rules).
// ---------------------------------------------------------------------------
const confirmSchema = z
  .object({
    conversationId: z.string(),
    spaceId: z.string(),
    // join_department
    inviteCode: z.string().optional(),
    // create_due
    title: z.string().min(3).max(120).optional(),
    amount: z.number().int().positive().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    category: z.enum(DUE_CATEGORIES).optional(),
  })
  .refine((d) => !!d.inviteCode || (!!d.title && !!d.amount && !!d.dueDate && !!d.category), {
    message: 'either inviteCode, or title+amount+dueDate+category, must be provided',
  });

assistantRouter.post('/confirm', validate(confirmSchema), async (req: Request, res: Response): Promise<void> => {
  const userId = uid(req);
  const body = req.body as z.infer<typeof confirmSchema>;

  const conversation = await db.assistantConversation.findFirst({ where: { id: body.conversationId, userId } });
  if (!conversation) {
    errors.notFound(res, 'Conversation not found');
    return;
  }

  if (body.inviteCode) {
    const result = await confirmJoinDepartment(userId, body.spaceId, body.inviteCode);

    if (result.status === 'invalid_code') {
      fail(res, 422, 'JOIN_CODE_INVALID', 'That join code is no longer valid');
      return;
    }
    if (result.status === 'already_member') {
      ok(res, { status: 'already_member', spaceName: result.spaceName });
      return;
    }
    ok(res, { status: 'joined', spaceName: result.spaceName, joinedAt: result.joinedAt.toISOString() }, 201);
    return;
  }

  const result = await confirmCreateDue(userId, body.spaceId, {
    title: body.title as string,
    amountKobo: body.amount as number,
    dueDate: body.dueDate as string,
    category: body.category as (typeof DUE_CATEGORIES)[number],
  });

  if (result.status === 'not_rep') {
    errors.forbidden(res, 'You are not a rep of this space');
    return;
  }
  ok(res, { status: 'created', dueId: result.dueId, title: result.title, spaceName: result.spaceName }, 201);
});
