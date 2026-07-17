import { db } from '../config/db';
import { classifyIntent } from '../lib/llm';
import { computeCharge, formatNaira } from '../lib/money';
import {
  type Intent,
  type ClassificationResult,
  type ConversationTurn,
  type AssistantMessageResponse,
  type AssistantAction,
  type QuickReply,
  type HandlerResult,
  type PayDuesResult,
  type JoinDepartmentResult,
  type CheckBalanceResult,
  type ViewHistoryResult,
  type ContactRepResult,
  type DueOption,
} from '../types/assistant';

// A model can't be trusted to self-report confidence honestly; below this we
// treat the turn as low-confidence and fall back to the static help message.
const CONFIDENCE_FLOOR = 0.35;

// Matches invite codes like "CSSA-7F2K" (see lib/joincode.ts's generator).
// Checked before any LLM call — cheaper and more reliable than asking Gemma
// to extract something a regex already gets right.
const INVITE_CODE_REGEX = /\b([A-Z0-9]{2,6})-([A-Z0-9]{4})\b/i;

const HELP_REPLY =
  "I can help you pay dues, join a department, check your balance, view your payment history, or find your department rep's contact. What would you like to do?";

// ---------------------------------------------------------------------------
// 1. Intent classification (regex short-circuit, then Gemma)
// ---------------------------------------------------------------------------
export async function classify(message: string, history: ConversationTurn[]): Promise<ClassificationResult> {
  const codeMatch = message.match(INVITE_CODE_REGEX);
  if (codeMatch) {
    return {
      intent: 'join_department',
      params: { inviteCode: codeMatch[0].toUpperCase(), dueTitle: null, spaceName: null, limit: null },
      needs_clarification: false,
      clarification_question: null,
      confidence: 1,
      source: 'regex',
    };
  }

  const turns: ConversationTurn[] = [...history, { role: 'user', content: message }];
  return classifyIntent(turns);
}

// ---------------------------------------------------------------------------
// 2. Validation + execution — deterministic, DB-backed handlers
// ---------------------------------------------------------------------------
function toDueOption(due: {
  id: string;
  title: string;
  amount: number;
  dueDate: Date;
  spaceId: string;
  space: { name: string };
}): DueOption {
  const charge = computeCharge(due.amount);
  return {
    dueId: due.id,
    title: due.title,
    amount: due.amount,
    payableAmount: charge.totalCharged,
    spaceId: due.spaceId,
    spaceName: due.space.name,
    dueDate: due.dueDate.toISOString().slice(0, 10),
  };
}

async function unpaidDuesFor(userId: string, dueTitle: string | null) {
  const memberships = await db.spaceMembership.findMany({ where: { userId }, select: { spaceId: true } });
  const spaceIds = memberships.map((m) => m.spaceId);
  if (spaceIds.length === 0) return [];

  const dues = await db.due.findMany({
    where: {
      spaceId: { in: spaceIds },
      status: 'active',
      ...(dueTitle ? { title: { contains: dueTitle, mode: 'insensitive' } } : {}),
    },
    include: { space: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  });
  if (dues.length === 0) return [];

  const payments = await db.duePayment.findMany({
    where: { userId, dueId: { in: dues.map((d) => d.id) } },
    select: { dueId: true },
  });
  const paidIds = new Set(payments.map((p) => p.dueId));
  return dues.filter((d) => !paidIds.has(d.id));
}

async function handlePayDues(userId: string, dueTitle: string | null): Promise<PayDuesResult> {
  const matches = await unpaidDuesFor(userId, dueTitle);

  if (matches.length === 0) {
    return dueTitle
      ? { status: 'needs_clarification', reason: 'not_found', options: await unpaidDuesFor(userId, null).then((all) => all.slice(0, 5).map(toDueOption)) }
      : { status: 'needs_clarification', reason: 'no_active_dues' };
  }
  if (matches.length === 1) {
    return { status: 'ready', due: toDueOption(matches[0]) };
  }
  return { status: 'needs_clarification', reason: 'ambiguous', options: matches.slice(0, 5).map(toDueOption) };
}

async function handleJoinDepartment(userId: string, inviteCode: string | null): Promise<JoinDepartmentResult> {
  if (!inviteCode) return { status: 'invalid_code' };
  const code = inviteCode.trim().toUpperCase();

  const space = await db.space.findFirst({
    where: { joinCode: code, isArchived: false },
    include: { _count: { select: { memberships: true } } },
  });
  if (!space) return { status: 'invalid_code' };

  const existing = await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId, spaceId: space.id } } });
  if (existing) return { status: 'already_member', spaceId: space.id, spaceName: space.name };

  return {
    status: 'ready',
    spaceId: space.id,
    spaceName: space.name,
    inviteCode: space.joinCode,
    memberCount: space._count.memberships,
  };
}

async function handleCheckBalance(userId: string): Promise<CheckBalanceResult> {
  const [user, dues] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { walletBalance: true } }),
    unpaidDuesFor(userId, null),
  ]);

  const duesOwed = dues.map((d) => {
    const charge = computeCharge(d.amount);
    return {
      dueId: d.id,
      title: d.title,
      amount: d.amount,
      payableAmount: charge.totalCharged,
      spaceName: d.space.name,
      dueDate: d.dueDate.toISOString().slice(0, 10),
    };
  });

  return {
    walletBalance: user?.walletBalance ?? 0,
    duesOwed,
    totalOwed: duesOwed.reduce((sum, d) => sum + d.payableAmount, 0),
  };
}

async function handleViewHistory(userId: string, limit: number | null): Promise<ViewHistoryResult> {
  const take = Math.min(Math.max(limit ?? 10, 1), 10);
  const transactions = await db.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return {
    transactions: transactions.map((t) => ({
      id: t.id,
      title: t.title,
      amount: t.amount,
      method: t.method,
      status: t.status,
      reference: t.reference,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

async function handleContactRep(userId: string, spaceName: string | null): Promise<ContactRepResult> {
  const memberships = await db.spaceMembership.findMany({
    where: { userId },
    include: { space: { select: { id: true, name: true } } },
  });
  if (memberships.length === 0) return { status: 'no_department' };

  const targets = spaceName
    ? memberships.filter((m) => m.space.name.toLowerCase().includes(spaceName.toLowerCase()))
    : memberships;

  if (targets.length === 0) return { status: 'not_found', spaceName: spaceName ?? '' };

  const reps = await db.spaceRep.findMany({
    where: { spaceId: { in: targets.map((m) => m.space.id) } },
    include: { user: { select: { name: true, email: true, phone: true } }, space: { select: { name: true } } },
  });
  if (reps.length === 0) return { status: 'not_found', spaceName: spaceName ?? targets[0].space.name };

  return {
    status: 'found',
    reps: reps.map((r) => ({
      name: r.user.name,
      email: r.user.email,
      phone: r.user.phone,
      role: r.role,
      spaceName: r.space.name,
    })),
  };
}

/** Executes join_department once the frontend has forwarded the user's explicit confirmation tap (§ safety rules). */
export async function confirmJoinDepartment(userId: string, spaceId: string, inviteCode: string) {
  const space = await db.space.findUnique({ where: { id: spaceId } });
  if (!space || space.isArchived || space.joinCode.toUpperCase() !== inviteCode.trim().toUpperCase()) {
    return { status: 'invalid_code' as const };
  }

  const existing = await db.spaceMembership.findUnique({ where: { userId_spaceId: { userId, spaceId } } });
  if (existing) return { status: 'already_member' as const, spaceName: space.name };

  const membership = await db.spaceMembership.create({ data: { userId, spaceId, kind: 'member' } });
  return { status: 'joined' as const, spaceName: space.name, joinedAt: membership.joinedAt };
}

const DISPATCH: Record<Exclude<Intent, 'unknown'>, (userId: string, classification: ClassificationResult) => Promise<HandlerResult>> = {
  pay_dues: async (userId, c) => ({ intent: 'pay_dues', result: await handlePayDues(userId, c.params?.dueTitle ?? null) }),
  join_department: async (userId, c) => ({ intent: 'join_department', result: await handleJoinDepartment(userId, c.params?.inviteCode ?? null) }),
  check_balance: async (userId) => ({ intent: 'check_balance', result: await handleCheckBalance(userId) }),
  view_history: async (userId, c) => ({ intent: 'view_history', result: await handleViewHistory(userId, c.params?.limit ?? null) }),
  contact_rep: async (userId, c) => ({ intent: 'contact_rep', result: await handleContactRep(userId, c.params?.spaceName ?? null) }),
};

export async function execute(userId: string, classification: ClassificationResult): Promise<HandlerResult> {
  if (classification.intent === 'unknown' || classification.confidence < CONFIDENCE_FLOOR) {
    return { intent: 'unknown', result: null };
  }
  return DISPATCH[classification.intent](userId, classification);
}

// ---------------------------------------------------------------------------
// 3. Response formatting — template strings only, no LLM (§ money-safety)
// ---------------------------------------------------------------------------
function formatPayDues(result: PayDuesResult): { reply: string; quickReplies: QuickReply[]; action: AssistantAction | null } {
  if (result.status === 'ready') {
    const { due } = result;
    return {
      reply: `Ready to pay "${due.title}" (${formatNaira(due.payableAmount)}) to ${due.spaceName}? Tap below to continue.`,
      quickReplies: [{ label: 'Pay now', value: 'pay now' }],
      action: { type: 'open_payment_modal', dueId: due.dueId },
    };
  }
  if (result.reason === 'no_active_dues') {
    return { reply: "You don't have any unpaid dues right now.", quickReplies: [], action: null };
  }
  const list = result.options.map((o) => `${o.title} — ${formatNaira(o.payableAmount)} (${o.spaceName})`).join('\n');
  return {
    reply:
      result.reason === 'not_found'
        ? `I couldn't find a due matching that. Here's what you currently owe:\n${list}`
        : `I found a few dues that could match — which one did you mean?\n${list}`,
    quickReplies: result.options.map((o) => ({ label: o.title, value: o.title })),
    action: null,
  };
}

function formatJoinDepartment(result: JoinDepartmentResult): { reply: string; quickReplies: QuickReply[]; action: AssistantAction | null } {
  if (result.status === 'invalid_code') {
    return { reply: "That invite code doesn't look right — double-check it with your department rep and try again.", quickReplies: [], action: null };
  }
  if (result.status === 'already_member') {
    return { reply: `You're already a member of ${result.spaceName}.`, quickReplies: [], action: null };
  }
  return {
    reply: `Found it — ${result.spaceName} (${result.memberCount} member${result.memberCount === 1 ? '' : 's'}). Join now?`,
    quickReplies: [{ label: 'Yes, join', value: 'yes' }],
    action: { type: 'confirm_join_department', spaceId: result.spaceId, inviteCode: result.inviteCode },
  };
}

function formatCheckBalance(result: CheckBalanceResult): { reply: string; quickReplies: QuickReply[]; action: AssistantAction | null } {
  const base = `Your wallet balance is ${formatNaira(result.walletBalance)}.`;
  if (result.duesOwed.length === 0) {
    return { reply: `${base} You have no outstanding dues.`, quickReplies: [], action: null };
  }
  const list = result.duesOwed.map((d) => `${d.title} — ${formatNaira(d.payableAmount)} (${d.spaceName})`).join('\n');
  return {
    reply: `${base} You owe ${formatNaira(result.totalOwed)} across ${result.duesOwed.length} due(s):\n${list}`,
    quickReplies: [],
    action: null,
  };
}

function formatViewHistory(result: ViewHistoryResult): { reply: string; quickReplies: QuickReply[]; action: AssistantAction | null } {
  if (result.transactions.length === 0) {
    return { reply: "You don't have any transactions yet.", quickReplies: [], action: null };
  }
  const list = result.transactions
    .map((t) => `${t.createdAt.slice(0, 10)} — ${t.title}: ${formatNaira(Math.abs(t.amount))} (${t.status})`)
    .join('\n');
  return { reply: `Here's your recent activity:\n${list}`, quickReplies: [], action: null };
}

function formatContactRep(result: ContactRepResult): { reply: string; quickReplies: QuickReply[]; action: AssistantAction | null } {
  if (result.status === 'no_department') {
    return { reply: "You're not a member of any department yet — join one first with an invite code.", quickReplies: [], action: null };
  }
  if (result.status === 'not_found') {
    return { reply: `I couldn't find a department called "${result.spaceName}" among your spaces.`, quickReplies: [], action: null };
  }
  const list = result.reps.map((r) => `${r.name} (${r.role}, ${r.spaceName}) — ${r.email}${r.phone ? `, ${r.phone}` : ''}`).join('\n');
  return { reply: `Here's who to reach out to:\n${list}`, quickReplies: [], action: null };
}

export function formatResponse(conversationId: string, classification: ClassificationResult, handlerResult: HandlerResult): AssistantMessageResponse {
  if (handlerResult.intent === 'unknown') {
    return {
      conversationId,
      intent: 'unknown',
      confidence: classification.confidence,
      needsClarification: false,
      reply: HELP_REPLY,
      quickReplies: [],
      action: null,
    };
  }

  const formatted =
    handlerResult.intent === 'pay_dues'
      ? formatPayDues(handlerResult.result)
      : handlerResult.intent === 'join_department'
        ? formatJoinDepartment(handlerResult.result)
        : handlerResult.intent === 'check_balance'
          ? formatCheckBalance(handlerResult.result)
          : handlerResult.intent === 'view_history'
            ? formatViewHistory(handlerResult.result)
            : formatContactRep(handlerResult.result);

  return {
    conversationId,
    intent: handlerResult.intent,
    confidence: classification.confidence,
    needsClarification: formatted.action === null && formatted.quickReplies.length > 0,
    ...formatted,
  };
}
