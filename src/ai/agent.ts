import type OpenAI from 'openai';
import { getNim, AI_MODEL } from './nim';
import { toolSpecs, findTool, type ToolContext } from './tools';
import { loadRepContext, mintToken, type RepContext } from './identity';
import { logger } from '../lib/logger';

/**
 * The Duevy rep assistant. Turns a rep's natural-language message into actions
 * on their space(s), using the tools in tools.ts — each of which calls the same
 * REST API the dashboard uses, as the rep. The model plans and confirms; the
 * tools enforce the real rules (auth, KYC, PIN, idempotency, confirm-before-save).
 *
 * Shared by the web chat (routes/ai.ts) and the WhatsApp bot
 * (channels/whatsapp). Conversation state is per-rep and in-memory
 * (single-instance demo scope); only clean user/assistant turns are kept, so
 * the stored history is always a valid transcript.
 */

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface Session {
  history: Msg[];
  activeSpaceId: string | null;
  updatedAt: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY = 16; // last N user/assistant messages
const MAX_TOOL_ROUNDS = 6;

function getSession(userId: string): Session {
  const now = Date.now();
  const existing = sessions.get(userId);
  if (existing && now - existing.updatedAt < SESSION_TTL_MS) return existing;
  const fresh: Session = { history: [], activeSpaceId: null, updatedAt: now };
  sessions.set(userId, fresh);
  return fresh;
}

export function resetSession(userId: string): void {
  sessions.delete(userId);
}

function systemPrompt(rep: RepContext): string {
  const spaceList = rep.spaces.length
    ? rep.spaces.map((s) => `- ${s.name} (${s.short}), you are ${s.repRole} rep, id: ${s.id}`).join('\n')
    : '(none yet)';
  return [
    `You are Duevy's assistant for ${rep.name}, a student representative who collects dues for their department/association in Nigeria.`,
    `You help them do everything they could do on the Duevy dashboard, through chat.`,
    '',
    'The spaces they rep:',
    spaceList,
    '',
    'Rules:',
    '- Use the tools for every fact and action. NEVER invent balances, counts, names or statuses — read them from a tool.',
    '- MONEY UNITS: numeric money fields returned by tools are in KOBO (minor units); 100 kobo = ₦1. Divide by 100 to show naira. Examples: a tool value of 500000 is ₦5,000.00; 150000 is ₦1,500.00; 507500 is ₦5,075.00. Values ALREADY written with a ₦ sign (e.g. from create_due or quotes) are naira — show them as-is, do not convert again.',
    '- Amounts the rep types are in naira.',
    '- If they rep more than one space and none is active, ask which space, then call set_active_space.',
    '- Before creating a due, moving money, or anything destructive, call the tool WITHOUT confirmed to get a summary, read it back, and only proceed with confirmed:true once they clearly say yes.',
    '- Withdrawals: always show the quote and destination and get a clear yes; if the space uses a PIN, ask for the 4-digit PIN and pass it.',
    '- When you create or publish a due, give them the public pay link to share.',
    '- Keep replies short and clear — they may be reading on WhatsApp. Use plain language, no markdown tables.',
    '- If a tool returns an error, explain it simply and suggest the fix.',
  ].join('\n');
}

/** Run one rep message to a final text reply. */
export async function handleMessage(userId: string, text: string): Promise<string> {
  const rep = await loadRepContext(userId);
  if (!rep) return "I couldn't find an active Duevy rep account for you. If you just became a rep, sign in to the dashboard first.";

  const token = await mintToken(rep);
  const session = getSession(userId);
  const ctx: ToolContext = {
    rep,
    token,
    getActiveSpaceId: () => session.activeSpaceId ?? (rep.spaces.length === 1 ? rep.spaces[0]!.id : null),
    setActiveSpaceId: (id) => {
      session.activeSpaceId = id;
    },
  };

  const messages: Msg[] = [{ role: 'system', content: systemPrompt(rep) }, ...session.history, { role: 'user', content: text }];
  const nim = getNim();

  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await nim.chat.completions.create({
      model: AI_MODEL,
      messages,
      tools: toolSpecs(),
      tool_choice: 'auto',
      temperature: 0.2,
    });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content ?? '';
      break;
    }

    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      const tool = findTool(call.function.name);
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool ${call.function.name}` };
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        try {
          result = await tool.run(args, ctx);
        } catch (err) {
          logger.warn({ tool: call.function.name, err: (err as Error).message }, 'ai tool failed');
          result = { error: (err as Error).message };
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  if (!finalText) finalText = "I couldn't finish that just now. Please try rephrasing, or use the dashboard.";

  // Persist only the clean turn, so stored history is always a valid transcript.
  session.history.push({ role: 'user', content: text }, { role: 'assistant', content: finalText });
  session.history = session.history.slice(-MAX_HISTORY);
  session.activeSpaceId = ctx.getActiveSpaceId();
  session.updatedAt = Date.now();

  return finalText;
}
