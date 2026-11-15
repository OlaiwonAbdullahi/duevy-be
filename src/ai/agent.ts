import type OpenAI from 'openai';
import { getNim, AI_MODEL } from './nim';
import { toolSpecs, findTool, type ToolContext } from './tools';
import { todayContext } from './dates';
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

function systemPrompt(rep: RepContext, todayLagos: string, weekday: string): string {
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
    `Today is ${weekday}, ${todayLagos} (Africa/Lagos time).`,
    '',
    'Rules:',
    '- Use the tools for every fact and action. NEVER invent balances, counts, names or statuses — read them from a tool.',
    `- DATES: understand everyday/relative dates yourself and pass them to tools as YYYY-MM-DD. NEVER ask the rep to type a date in YYYY-MM-DD. Relative to today (${todayLagos}): "today"=${todayLagos}, "tomorrow"=+1 day, "next week"/"same day next week"/"in a week"=+7 days, "in N days"=+N days, "this Friday"/"next Friday"=the next upcoming Friday, "end of the month"=the last day of this month, "end of the week"=the coming Sunday. If a date is truly ambiguous, pick the most sensible one and say which date you used — do not refuse or keep asking.`,
    '- MONEY UNITS: numeric money fields returned by tools are in KOBO (minor units); 100 kobo = ₦1. Divide by 100 to show naira. Examples: a tool value of 500000 is ₦5,000.00; 150000 is ₦1,500.00; 507500 is ₦5,075.00. Values ALREADY written with a ₦ sign (e.g. from create_due or quotes) are naira — show them as-is, do not convert again.',
    '- Amounts the rep types are in naira.',
    '- If they rep more than one space and none is active, ask which space, then call set_active_space.',
    '- Before creating a due, moving money, or anything destructive, call the tool WITHOUT confirmed to get a summary, read it back, and only proceed with confirmed:true once they clearly say yes.',
    '- SUMMARY FORMAT: when you read a due summary back for confirmation, lay the details out as a short bulleted list (one detail per line, each starting with "- "), not a single run-on sentence. Cover title, amount, student fee, total student pays, due date, category, and any extra questions. Example:\n  - Title: CSC305 manual\n  - Amount: ₦4,000.00\n  - Student fee: ₦60.00\n  - Total student pays: ₦4,060.00\n  - Due date: 2026-11-22\n  - Extra questions: Age\n  Then ask for a plain yes/no to save it.',
    '- DUE TITLE: use the name the rep gives in their message — take it directly whether they phrase it as "call it X", "make it X", "named X", or just drop a clear name/code like "CSC305 manual", "202 manual", "SUG levy". Do NOT ask again for a title that is already in their message. ONLY ask "what should the title be?" when the message truly has no name — e.g. "create a ₦2000 due for Friday" with no label at all. Never invent a generic title like "Departmental Due".',
    '- FORM BUILDER: when the rep says "ask for / collect / require" something from payers (e.g. "ask for their level and age"), pass those as create_due `fields` — one field per item (label + a sensible type: number for age, select with options for level, etc.). Do NOT put requested questions in the `note`; the note is only a short message. Mention the questions in the summary you read back.',
    '- Withdrawals: always show the quote and destination and get a clear yes; if the space uses a PIN, ask for the 4-digit PIN and pass it.',
    '- When you create or publish a due, give them the public pay link to share. ALWAYS paste the exact `payLink` URL string the tool returned, character for character, in full and as plain text. NEVER shorten it, swap its host, replace the id with x\'s or dots, write a placeholder like "[Link to pay]" or "[Link]", or wrap it in markdown link syntax. The rep copies the raw URL, so the literal tool-returned URL must appear verbatim in your reply. If a tool did not return a payLink, call get_pay_link before answering; never guess or fabricate a link.',
    '- Keep replies short and clear — they may be reading on WhatsApp. Use plain language, no markdown tables, and no markdown link syntax — write raw URLs.',
    '- If a tool returns an error, explain it simply and suggest the fix.',
  ].join('\n');
}

/**
 * Force the real pay link into the model's reply. LLMs sometimes write a
 * placeholder ("[Link to pay]"), mask the id ("/pay/due_xxxxxxxx"), or swap the
 * host — all of which hand the rep a dead link. When a tool produced the real
 * `payLink` this turn, we (1) replace bracket/parenthetical placeholders and any
 * markdown link, (2) rewrite any .../pay/<id> URL to the real one, and (3) if the
 * reply mentions a link but has none, append it.
 */
export function repairPayLink(text: string, realLink: string | null): string {
  if (!realLink) return text;
  let out = text;

  // Markdown links [label](href) → the real URL as plain text.
  out = out.replace(/\[[^\]]*\]\((https?:\/\/[^)]*\/pay\/[^)\s]*|[^)]*)\)/gi, realLink);

  // Bare placeholder tokens like [Link to pay], [Link], [pay link].
  out = out.replace(/\[[^\]]*(?:link|pay)[^\]]*\]/gi, realLink);

  // Any pay-style URL (wrong host or masked id) → the real URL.
  out = out.replace(/https?:\/\/[^\s)]+\/pay\/[^\s)]+/gi, realLink);

  // If the model mentions a link but none ended up in the text, append it.
  if (!out.includes(realLink) && /\blink\b/i.test(out)) {
    out = `${out.trimEnd()}\n${realLink}`;
  }
  return out;
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

  // Civil date in the rep's timezone (Africa/Lagos), so "today" in the prompt and
  // the deterministic resolver in dates.ts always agree.
  const { iso: todayLagos, weekday } = todayContext();

  const messages: Msg[] = [{ role: 'system', content: systemPrompt(rep, todayLagos, weekday) }, ...session.history, { role: 'user', content: text }];
  const nim = getNim();

  let finalText = '';
  // The real pay link produced by a tool this turn (create_due / publish_due /
  // get_pay_link). We use it to repair the model's final reply if it parrots a
  // placeholder or hallucinates a wrong host/id instead of the actual URL.
  let realPayLink: string | null = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await nim.chat.completions.create({
      model: AI_MODEL,
      messages,
      tools: toolSpecs(),
      tool_choice: 'auto',
      temperature: 0.2,
      // Bound the output, but keep it high enough that a REASONING model (e.g. the
      // nemotron "super"/"lightning" tiers spend tokens on hidden reasoning) still
      // has room to produce its actual answer. A low cap truncates them to empty.
      // The fast default (bolt, non-reasoning) uses far fewer tokens anyway.
      max_tokens: 2048,
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
      if (result && typeof result === 'object' && typeof (result as { payLink?: unknown }).payLink === 'string') {
        realPayLink = (result as { payLink: string }).payLink;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  if (!finalText) finalText = "I couldn't finish that just now. Please try rephrasing, or use the dashboard.";

  // Repair the pay link: models sometimes echo a placeholder ("[Link to pay]") or
  // a hallucinated URL (wrong host, id masked as x's) instead of the real link the
  // tool returned. If we captured a real payLink this turn, force it into the reply.
  finalText = repairPayLink(finalText, realPayLink);

  // Persist only the clean turn, so stored history is always a valid transcript.
  session.history.push({ role: 'user', content: text }, { role: 'assistant', content: finalText });
  session.history = session.history.slice(-MAX_HISTORY);
  session.activeSpaceId = ctx.getActiveSpaceId();
  session.updatedAt = Date.now();

  return finalText;
}
