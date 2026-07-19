import { z } from 'zod';

// ---------------------------------------------------------------------------
// Intents Duey can classify a message into.
// ---------------------------------------------------------------------------
export const INTENTS = [
  'pay_dues',
  'join_department',
  'check_balance',
  'view_history',
  'contact_rep',
  'fund_wallet',
  'create_due',
  'rep_summary',
  'unknown',
] as const;

export type Intent = (typeof INTENTS)[number];

// Must stay in sync with Prisma's DueCategory enum and repDues.ts's categoryField.
export const DUE_CATEGORIES = ['levy', 'dinner', 'handout', 'welfare', 'sport'] as const;
export type DueCategory = (typeof DUE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// The strict JSON shape Gemma must return. Validated before anything downstream
// touches it — malformed output is rejected and treated as `unknown` (§ safety).
// ---------------------------------------------------------------------------
export const classificationParamsSchema = z
  .object({
    dueTitle: z.string().nullable().optional(),
    inviteCode: z.string().nullable().optional(),
    spaceName: z.string().nullable().optional(),
    limit: z.number().int().positive().nullable().optional(),
    // fund_wallet — amount as the user stated it, in naira (not kobo).
    amount: z.number().positive().nullable().optional(),
    // create_due (rep-only; enforced by the handler, not the model) — dueDate
    // must be resolved to YYYY-MM-DD using the current date given in the prompt.
    dueDate: z.string().nullable().optional(),
    category: z.enum(DUE_CATEGORIES).nullable().optional(),
  })
  .nullable();

export const classificationSchema = z.object({
  intent: z.enum(INTENTS),
  params: classificationParamsSchema,
  needs_clarification: z.boolean(),
  clarification_question: z.string().nullable(),
});

export type Classification = z.infer<typeof classificationSchema>;

export interface ClassificationResult extends Classification {
  /** 1.0 for the deterministic invite-code short-circuit, otherwise the model's self-reported confidence (defaults to 0.5 when the model omits one). */
  confidence: number;
  /** true when the regex pre-check matched and the LLM was never called. */
  source: 'regex' | 'llm' | 'fallback';
}

// ---------------------------------------------------------------------------
// Per-intent params, after validation against real DB state.
// ---------------------------------------------------------------------------
export interface PayDuesParams {
  dueTitle: string | null;
  spaceId: string | null;
}

export interface JoinDepartmentParams {
  inviteCode: string;
}

export interface ContactRepParams {
  spaceName: string | null;
}

export interface ViewHistoryParams {
  limit: number | null;
}

export interface FundWalletParams {
  amount: number | null; // naira, as stated by the user
}

export interface CreateDueParams {
  spaceName: string | null;
  title: string | null;
  amount: number | null; // naira, as stated by the user
  dueDate: string | null;
  category: DueCategory | null;
}

// ---------------------------------------------------------------------------
// Structured handler results — deterministic, DB-backed, no LLM text.
// ---------------------------------------------------------------------------
export interface DueOption {
  dueId: string;
  title: string;
  amount: number;
  payableAmount: number;
  spaceId: string;
  spaceName: string;
  dueDate: string;
}

export type PayDuesResult =
  | { status: 'needs_clarification'; reason: 'no_active_dues' }
  | { status: 'needs_clarification'; reason: 'ambiguous' | 'not_found'; options: DueOption[] }
  | { status: 'ready'; due: DueOption };

export type JoinDepartmentResult =
  | { status: 'missing_code' }
  | { status: 'invalid_code' }
  | { status: 'already_member'; spaceId: string; spaceName: string }
  | { status: 'ready'; spaceId: string; spaceName: string; inviteCode: string; memberCount: number };

export interface CheckBalanceResult {
  walletBalance: number;
  duesOwed: Array<{ dueId: string; title: string; amount: number; payableAmount: number; spaceName: string; dueDate: string }>;
  totalOwed: number;
}

export interface HistoryItem {
  id: string;
  title: string;
  amount: number;
  method: string;
  status: string;
  reference: string;
  createdAt: string;
}

export interface ViewHistoryResult {
  transactions: HistoryItem[];
}

export type ContactRepResult =
  | { status: 'no_department' }
  | { status: 'not_found'; spaceName: string }
  | { status: 'found'; reps: Array<{ name: string; email: string; phone: string | null; role: string; spaceName: string }> };

export type FundWalletResult =
  | { status: 'needs_amount' }
  | { status: 'invalid_amount'; minKobo: number; maxKobo: number }
  | { status: 'ready'; amountKobo: number };

export interface CreateDueDraft {
  title: string;
  amountKobo: number;
  dueDate: string; // YYYY-MM-DD
  category: DueCategory;
}

export type CreateDueResult =
  | { status: 'not_rep' }
  | { status: 'needs_space'; spaces: Array<{ spaceId: string; spaceName: string }> }
  | { status: 'invalid_date' }
  | {
      status: 'needs_fields';
      spaceId: string;
      spaceName: string;
      missing: string[];
      known: { title: string | null; amount: number | null; dueDate: string | null; category: DueCategory | null };
    }
  | { status: 'ready'; spaceId: string; spaceName: string; draft: CreateDueDraft };

export type RepSummaryResult =
  | { status: 'not_rep' }
  | {
      status: 'ok';
      spaces: Array<{
        spaceId: string;
        spaceName: string;
        dueCount: number;
        totalCollected: number; // kobo, gross paid by students
        totalNet: number; // kobo, net to space after fees
        payoutLifetime: number; // kobo, completed payouts to date
      }>;
    };

export type HandlerResult =
  | { intent: 'pay_dues'; result: PayDuesResult }
  | { intent: 'join_department'; result: JoinDepartmentResult }
  | { intent: 'check_balance'; result: CheckBalanceResult }
  | { intent: 'view_history'; result: ViewHistoryResult }
  | { intent: 'contact_rep'; result: ContactRepResult }
  | { intent: 'fund_wallet'; result: FundWalletResult }
  | { intent: 'create_due'; result: CreateDueResult }
  | { intent: 'rep_summary'; result: RepSummaryResult }
  | { intent: 'unknown'; result: null };

// ---------------------------------------------------------------------------
// Frontend-facing response, built by the deterministic formatting step.
// ---------------------------------------------------------------------------
export interface QuickReply {
  label: string;
  value: string;
}

export interface AssistantAction {
  type: 'open_payment_modal' | 'confirm_join_department' | 'open_topup_modal' | 'confirm_create_due';
  dueId?: string;
  spaceId?: string;
  inviteCode?: string;
  amount?: number; // kobo — open_topup_modal
  title?: string; // confirm_create_due
  dueDate?: string; // confirm_create_due
  category?: DueCategory; // confirm_create_due
}

export interface AssistantMessageResponse {
  conversationId: string;
  intent: Intent;
  confidence: number;
  needsClarification: boolean;
  reply: string;
  quickReplies: QuickReply[];
  action: AssistantAction | null;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}
