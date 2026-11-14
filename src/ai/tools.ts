import type OpenAI from 'openai';
import { env } from '../config/env';
import { DUE_TYPES } from '../lib/dueTypes';
import { nairaToKobo, formatNaira, checkoutFee } from '../lib/money';
import { apiCall } from './api';
import type { RepContext } from './identity';

/**
 * The agent's tools. Each is a thin wrapper over a Duevy REST endpoint, called
 * as the linked rep (see api.ts). Together they cover the rep's whole surface:
 * dues, collections/reporting, payouts & beneficiaries, team, KYC, settings.
 *
 * Confirmation gate: anything that creates, moves money, or is destructive
 * takes `confirmed`. Called without it, the tool does NOT act — it returns a
 * summary and asks the agent to confirm with the rep first. This enforces the
 * checklist's "the rep must confirm the summary before it is saved" and the
 * withdrawal PIN step regardless of what the model does on its own.
 */

export interface ToolContext {
  rep: RepContext;
  token: string;
  getActiveSpaceId(): string | null;
  setActiveSpaceId(id: string): void;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

// --- helpers --------------------------------------------------------------

type SpaceResolved = { spaceId: string } | { error: string; spaces: { id: string; name: string }[] };

/** The space the agent is acting on: the active one, or the only one, else ask. */
function resolveSpace(ctx: ToolContext): SpaceResolved {
  const active = ctx.getActiveSpaceId();
  if (active && ctx.rep.spaces.some((s) => s.id === active)) return { spaceId: active };
  if (ctx.rep.spaces.length === 1) {
    ctx.setActiveSpaceId(ctx.rep.spaces[0]!.id);
    return { spaceId: ctx.rep.spaces[0]!.id };
  }
  if (ctx.rep.spaces.length === 0) {
    return { error: 'You are not a rep of any space, so there is nothing to manage here.', spaces: [] };
  }
  return {
    error: 'You rep more than one space. Ask which one, then call set_active_space.',
    spaces: ctx.rep.spaces.map((s) => ({ id: s.id, name: s.name })),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const numArg = (v: unknown): number | undefined => (typeof v === 'number' && !Number.isNaN(v) ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const boolArg = (v: unknown): boolean => v === true || v === 'true';

const payLink = (dueId: string) => `${env.FRONTEND_URL}/pay/${dueId}`;

// --- tools ----------------------------------------------------------------

export const tools: AgentTool[] = [
  {
    name: 'get_my_spaces',
    description: "List the spaces (departments/associations) the rep manages and which one is currently active.",
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return { spaces: ctx.rep.spaces, activeSpaceId: ctx.getActiveSpaceId() };
    },
  },
  {
    name: 'set_active_space',
    description: 'Choose which space the rep is working on for the rest of the conversation. Needed when they rep more than one.',
    parameters: {
      type: 'object',
      properties: { spaceId: { type: 'string', description: 'The id of the space to make active.' } },
      required: ['spaceId'],
    },
    async run(args, ctx) {
      const spaceId = str(args.spaceId);
      const space = ctx.rep.spaces.find((s) => s.id === spaceId);
      if (!space) return { error: 'That is not one of your spaces.', spaces: ctx.rep.spaces };
      ctx.setActiveSpaceId(space.id);
      return { activeSpaceId: space.id, name: space.name };
    },
  },

  // --- Dues ---------------------------------------------------------------
  {
    name: 'list_dues',
    description: 'List the dues this space has raised, with paid/unpaid counts. Optional status filter.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'active', 'closed'] } },
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/dues`, token: ctx.token, query: { status: str(args.status) } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'create_due',
    description:
      'Create a due for the space. Amount is in NAIRA. Call first WITHOUT confirmed to get the summary (face, 1.5% student fee, total, pay link) to read back to the rep; only call again with confirmed:true once they approve. Set publish:true to open it for payment immediately (needs the space to have passed KYC).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        amount_naira: { type: 'number', description: 'The due amount in naira (e.g. 2000 for ₦2,000).' },
        due_date: { type: 'string', description: 'Deadline, YYYY-MM-DD, today or later.' },
        category: { type: 'string', enum: [...DUE_TYPES] },
        note: { type: 'string' },
        allow_guests: { type: 'boolean', description: 'Let non-members pay via the public link. Default true.' },
        publish: { type: 'boolean', description: 'Publish immediately. Default false (saved as draft).' },
        confirmed: { type: 'boolean', description: 'Only true after the rep has approved the summary.' },
      },
      required: ['title', 'amount_naira', 'due_date', 'category'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const title = str(args.title);
      const amountNaira = numArg(args.amount_naira);
      const dueDate = str(args.due_date);
      const category = str(args.category);
      if (!title || amountNaira === undefined || !dueDate || !category) return { error: 'title, amount_naira, due_date and category are all required.' };
      const faceKobo = nairaToKobo(amountNaira);
      const feeKobo = checkoutFee(faceKobo);
      const summary = {
        title,
        amount: formatNaira(faceKobo),
        studentFee: formatNaira(feeKobo),
        studentPays: formatNaira(faceKobo + feeKobo),
        dueDate,
        category,
        allowGuests: args.allow_guests === undefined ? true : boolArg(args.allow_guests),
        willPublish: boolArg(args.publish),
      };
      if (!boolArg(args.confirmed)) {
        return { needsConfirmation: true, summary, instruction: 'Read this summary to the rep and ask them to confirm before saving.' };
      }
      const res = await apiCall({
        method: 'POST',
        path: `/spaces/${s.spaceId}/dues`,
        token: ctx.token,
        body: {
          title,
          amount: faceKobo,
          dueDate,
          category,
          note: str(args.note),
          allowGuests: summary.allowGuests,
          publish: summary.willPublish,
        },
      });
      if (!res.ok) return { error: res.error };
      const due = res.data as { id?: string };
      return { created: res.data, payLink: due.id ? payLink(due.id) : null };
    },
  },
  {
    name: 'publish_due',
    description: 'Publish a draft due so students can pay it. Requires the space to have passed KYC.',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}/publish`, token: ctx.token });
      return res.ok ? { published: res.data, payLink: payLink(str(args.due_id)!) } : { error: res.error };
    },
  },
  {
    name: 'close_due',
    description: 'Close a due so it stops accepting payments. Call without confirmed to confirm first.',
    parameters: {
      type: 'object',
      properties: { due_id: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['due_id'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep that they want to close this due.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}/close`, token: ctx.token });
      return res.ok ? { closed: res.data } : { error: res.error };
    },
  },
  {
    name: 'delete_due',
    description: 'Delete a DRAFT due (only drafts can be deleted). Call without confirmed to confirm first.',
    parameters: {
      type: 'object',
      properties: { due_id: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['due_id'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep before deleting the draft.' };
      const res = await apiCall({ method: 'DELETE', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}`, token: ctx.token });
      return res.ok ? { deleted: true } : { error: res.error };
    },
  },
  {
    name: 'remind_unpaid',
    description: 'Send a reminder notification to members who have not yet paid a due. One blast per due per 24h.',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}/remind`, token: ctx.token, body: {} });
      return res.ok ? { reminded: res.data } : { error: res.error };
    },
  },
  {
    name: 'get_pay_link',
    description: 'Get the public payment link for a due, to share with students. The due must exist in the space.',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const dueId = str(args.due_id);
      // Verify the id against the space's dues so we never emit a link to a
      // non-existent due (the model can garble a long id).
      const res = await apiCall<{ id: string; title: string }[]>({ method: 'GET', path: `/spaces/${s.spaceId}/dues`, token: ctx.token });
      if (!res.ok) return { error: res.error };
      const list = Array.isArray(res.data) ? res.data : [];
      const found = list.find((d) => d.id === dueId);
      if (!found) {
        return { error: 'No due with that id in this space. Pick one of these and use its exact id.', dues: list.map((d) => ({ id: d.id, title: d.title })) };
      }
      return { title: found.title, payLink: payLink(found.id) };
    },
  },

  // --- Reporting ----------------------------------------------------------
  {
    name: 'who_hasnt_paid',
    description: 'List the members who have NOT paid a given due, with the totals (how many unpaid, how much outstanding).',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}/collections`, token: ctx.token, query: { status: 'unpaid' } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'collection_summary',
    description: 'The paid/unpaid roster and money totals for a due (collected, fees, net, expected, collection rate).',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/dues/${str(args.due_id)}/collections`, token: ctx.token, query: { status: 'all' } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'space_overview',
    description: "The space's dashboard totals: how much collected overall, outstanding, unpaid count, collection rate, active dues, newest members.",
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/overview`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },

  // --- Payouts & beneficiaries -------------------------------------------
  {
    name: 'payout_summary',
    description: "The space's withdrawable balance, funds split, KYC state, withdrawal security (PIN/multisig), and fee bands.",
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/payout/summary`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'list_banks',
    description: 'List Nigerian banks (with codes) for choosing a payout destination.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const res = await apiCall({ method: 'GET', path: `/banks`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'lookup_account',
    description: 'Name-enquiry: resolve the account holder name for a bank code + account number before saving/paying it.',
    parameters: {
      type: 'object',
      properties: { bank_code: { type: 'string' }, account_number: { type: 'string', description: '10-digit NUBAN' } },
      required: ['bank_code', 'account_number'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/payout/beneficiaries/lookup`, token: ctx.token, body: { bankCode: str(args.bank_code), accountNumber: str(args.account_number) } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'list_beneficiaries',
    description: 'List the payout destinations saved on the space.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/payout/beneficiaries`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'add_beneficiary',
    description: 'Save a payout destination (lead rep only). Call lookup_account first; call without confirmed to confirm the resolved name with the rep.',
    parameters: {
      type: 'object',
      properties: {
        bank_code: { type: 'string' },
        account_number: { type: 'string' },
        label: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['bank_code', 'account_number'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Resolve the name with lookup_account and confirm it with the rep before saving.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/payout/beneficiaries`, token: ctx.token, body: { bankCode: str(args.bank_code), accountNumber: str(args.account_number), label: str(args.label) } });
      return res.ok ? { saved: res.data } : { error: res.error };
    },
  },
  {
    name: 'quote_withdrawal',
    description: 'Show the fee breakdown for withdrawing an amount (in NAIRA) before the rep confirms.',
    parameters: { type: 'object', properties: { amount_naira: { type: 'number' } }, required: ['amount_naira'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const amount = numArg(args.amount_naira);
      if (amount === undefined) return { error: 'amount_naira is required.' };
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/payout/quote`, token: ctx.token, query: { amount: nairaToKobo(amount) } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'request_withdrawal',
    description:
      'Request a withdrawal to a saved beneficiary. Amount is in NAIRA. ALWAYS call quote_withdrawal and confirm the amount + destination with the rep first. If the space uses a PIN, you must pass the rep\'s 4-digit pin. Call without confirmed to re-confirm; the tool will not send money without confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        amount_naira: { type: 'number' },
        beneficiary_id: { type: 'string', description: 'A saved beneficiary id (preferred).' },
        pin: { type: 'string', description: "The rep's 4-digit withdrawal PIN, if the space uses PIN mode." },
        due_id: { type: 'string', description: 'Withdraw from a specific due only (optional).' },
        note: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['amount_naira', 'beneficiary_id'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const amount = numArg(args.amount_naira);
      if (amount === undefined) return { error: 'amount_naira is required.' };
      if (!boolArg(args.confirmed)) {
        return { needsConfirmation: true, amount: formatNaira(nairaToKobo(amount)), instruction: 'Confirm the amount and destination with the rep, and collect their PIN if the space uses one, before calling again with confirmed:true.' };
      }
      const res = await apiCall({
        method: 'POST',
        path: `/spaces/${s.spaceId}/payout/request`,
        token: ctx.token,
        idempotent: true,
        body: {
          amount: nairaToKobo(amount),
          beneficiaryId: str(args.beneficiary_id),
          pin: str(args.pin),
          dueId: str(args.due_id),
          note: str(args.note),
        },
      });
      return res.ok ? { payout: res.data } : { error: res.error };
    },
  },
  {
    name: 'list_payouts',
    description: 'List the space\'s withdrawals and their statuses.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/payouts`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },

  // --- Team ---------------------------------------------------------------
  {
    name: 'list_members',
    description: 'List the members of the space.',
    parameters: { type: 'object', properties: { q: { type: 'string', description: 'Optional search by name/matric/email.' } } },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/members`, token: ctx.token, query: { q: str(args.q) } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'list_reps',
    description: 'List the reps (lead and co-reps) of the space.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/reps`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'add_corep',
    description: 'Add a co-rep by email (lead rep only). Call without confirmed to confirm with the rep first.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['email'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm the email with the rep before adding a co-rep.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/reps`, token: ctx.token, body: { email: str(args.email) } });
      return res.ok ? { added: res.data } : { error: res.error };
    },
  },

  // --- KYC & settings -----------------------------------------------------
  {
    name: 'kyc_status',
    description: "The space's verification (KYC) status and what, if anything, is still needed before it can collect.",
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/payout/kyc-status`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'update_space',
    description: 'Update the space profile (name, about, faculty) — lead rep only. Call without confirmed to confirm the changes first.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        about: { type: 'string' },
        faculty: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const body: Record<string, unknown> = {};
      if (str(args.name)) body.name = str(args.name);
      if (str(args.about)) body.about = str(args.about);
      if (str(args.faculty)) body.faculty = str(args.faculty);
      if (Object.keys(body).length === 0) return { error: 'Nothing to update.' };
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, changes: body, instruction: 'Confirm these changes with the rep first.' };
      const res = await apiCall({ method: 'PATCH', path: `/spaces/${s.spaceId}`, token: ctx.token, body });
      return res.ok ? { updated: res.data } : { error: res.error };
    },
  },
];

const byName = new Map(tools.map((t) => [t.name, t]));
export function findTool(name: string): AgentTool | undefined {
  return byName.get(name);
}

/** The tool definitions in the shape the model expects. */
export function toolSpecs(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
