import type OpenAI from 'openai';
import { env } from '../config/env';
import { DUE_TYPES } from '../lib/dueTypes';
import { nairaToKobo, formatNaira, checkoutFee } from '../lib/money';
import type { BankCard } from '../lib/banks';
import { apiCall } from './api';
import { resolveDueDate } from './dates';
import type { RepContext } from './identity';

/**
 * The agent's tools. Each is a thin wrapper over a Duevy REST endpoint, called
 * as the linked rep (see api.ts). Together they cover the rep's whole surface:
 * dues (create/edit/publish/close/delete/remind), collections/reporting,
 * payouts & beneficiaries, withdrawals, polls (create/publish/close/results),
 * the circle (members, reps, join code, audit log), KYC and settings.
 *
 * Confirmation gate: anything that creates, moves money, or is destructive
 * takes `confirmed`. Called without it, the tool does NOT act — it returns a
 * summary and asks the agent to confirm with the rep first. This enforces the
 * checklist's "the rep must confirm the summary before it is saved" and the
 * withdrawal PIN step regardless of what the model does on its own.
 */

/**
 * A due whose summary has been shown and is awaiting the rep's confirmation.
 * Remembered so that if the rep approves but the model fails to issue the
 * confirmed `create_due` call (it sometimes narrates success instead), the agent
 * can create the due deterministically rather than fabricate it.
 */
export interface PendingCreate {
  spaceId: string;
  body: Record<string, unknown>;
  title: string;
  willPublish: boolean;
  at: number;
}

export interface ToolContext {
  rep: RepContext;
  token: string;
  getActiveSpaceId(): string | null;
  setActiveSpaceId(id: string): void;
  /** Remember (or clear, with null) the due awaiting confirmation. Optional so
   *  lightweight test contexts need not provide it. */
  setPendingCreate?(pending: PendingCreate | null): void;
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

/**
 * Create a due that the rep already confirmed, by POSTing a remembered
 * `PendingCreate`. Used by the agent's fallback when the rep approves but the
 * model doesn't actually issue the confirmed create_due call. Returns the real
 * pay link (never a fabricated one), or an error.
 */
export async function runPendingCreate(
  token: string,
  pending: PendingCreate,
): Promise<{ created: true; title: string; published: boolean; payLink: string | null } | { error: string }> {
  const res = await apiCall({ method: 'POST', path: `/spaces/${pending.spaceId}/dues`, token, body: pending.body });
  if (!res.ok) return { error: res.error ?? 'The due could not be created.' };
  const due = res.data as { id?: string };
  return { created: true, title: pending.title, published: pending.willPublish, payLink: due.id ? payLink(due.id) : null };
}

/** Common short names reps use that don't substring-match the official bank name. */
const BANK_ALIASES: Record<string, string> = {
  gtb: 'guaranty trust',
  gtbank: 'guaranty trust',
  uba: 'united bank for africa',
  fcmb: 'first city monument',
  firstbank: 'first bank',
  stanbic: 'stanbic ibtc',
  zenith: 'zenith bank',
  access: 'access bank',
  opay: 'opay',
  palmpay: 'palmpay',
  kuda: 'kuda',
  moniepoint: 'moniepoint',
  wema: 'wema bank',
  polaris: 'polaris bank',
  sterling: 'sterling bank',
  fidelity: 'fidelity bank',
  union: 'union bank',
};

type BankResolved = { bankCode: string } | { error: string; banks: { code: string; name: string }[] };

/**
 * Resolve a bank to its provider code. Reps say bank NAMES ("palmpay", "gtb",
 * "opay"), not codes, so the agent should never have to know codes: pass a
 * numeric code straight through, otherwise match the name against the live bank
 * list (with a few common aliases). On ambiguity, return the candidates so the
 * agent can ask which one.
 */
async function resolveBankCode(args: Record<string, unknown>, ctx: ToolContext): Promise<BankResolved> {
  const code = str(args.bank_code);
  // A bare numeric code is used as-is (don't treat it as a name to look up).
  if (code && /^\d{3,6}$/.test(code)) return { bankCode: code };

  // The name may arrive in bank_name, or the model may have put it in bank_code.
  const query = str(args.bank_name) ?? code;
  if (!query) return { error: 'Tell me the bank (its name is fine, e.g. "PalmPay").', banks: [] };

  const res = await apiCall<{ code: string; name: string }[]>({ method: 'GET', path: '/banks', token: ctx.token });
  if (!res.ok || !Array.isArray(res.data)) return { error: 'Could not fetch the bank list to resolve that bank. Try again.', banks: [] };
  const banks = res.data;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = norm(BANK_ALIASES[norm(query)] ?? query);

  const exact = banks.find((b) => norm(b.name) === q);
  if (exact) return { bankCode: exact.code };
  const matches = banks.filter((b) => norm(b.name).includes(q));
  if (matches.length === 1) return { bankCode: matches[0]!.code };
  if (matches.length > 1) return { error: `More than one bank matches "${query}". Which one?`, banks: matches.slice(0, 8).map((b) => ({ code: b.code, name: b.name })) };
  return { error: `No Nigerian bank matches "${query}". Ask the rep to confirm the bank name.`, banks: [] };
}

const GUEST_FIELD_TYPES = ['text', 'textarea', 'number', 'email', 'phone', 'select'] as const;
type GuestFieldOut = { id: string; label: string; type: (typeof GUEST_FIELD_TYPES)[number]; required: boolean; options?: string[] };

/** A URL/id-safe slug for a form field, derived from its label. */
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'field'
  );
}

/**
 * Turn the model's `fields` argument into the due's guest-form fields (the form
 * builder: `dues.guestFields`). This is how "ask for their level and age"
 * becomes real questions on the public pay form — NOT a note. Ids are derived
 * from labels (unique, matric is reserved as a core field). A `select` without
 * ≥2 options falls back to text. Returns null when there's nothing usable.
 */
function buildGuestFields(raw: unknown): GuestFieldOut[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: GuestFieldOut[] = [];
  const used = new Set<string>(['matric']);
  for (const item of raw.slice(0, 10)) {
    const f = (item ?? {}) as Record<string, unknown>;
    const label = str(f.label);
    if (!label) continue;
    const base = slugify(label);
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}_${n}`.slice(0, 40);
    used.add(id);
    const typeRaw = str(f.type)?.toLowerCase();
    let type: GuestFieldOut['type'] = (GUEST_FIELD_TYPES as readonly string[]).includes(typeRaw ?? '') ? (typeRaw as GuestFieldOut['type']) : 'text';
    const options = Array.isArray(f.options)
      ? f.options.map((o) => str(o)).filter((o): o is string => !!o).slice(0, 20)
      : undefined;
    if (type === 'select' && (!options || options.length < 2)) type = 'text';
    out.push({ id, label, type, required: boolArg(f.required), ...(type === 'select' ? { options } : {}) });
  }
  return out.length ? out : null;
}

type PollNominee = { name: string };
type PollCategoryOut = { title: string; nominees: PollNominee[] };

/**
 * Turn the model's `categories` argument into a poll's categories + nominees.
 * Each category needs a title and at least TWO nominees (the API rejects fewer),
 * so categories that don't clear that bar are dropped. Nominees may arrive as
 * bare strings ("Ada") or objects ({ name: "Ada" }). Returns null when nothing
 * usable remains.
 */
function buildPollCategories(raw: unknown): PollCategoryOut[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PollCategoryOut[] = [];
  for (const item of raw.slice(0, 20)) {
    const c = (item ?? {}) as Record<string, unknown>;
    const title = str(c.title);
    if (!title) continue;
    const nomineesRaw = Array.isArray(c.nominees) ? c.nominees : [];
    const nominees: PollNominee[] = [];
    for (const n of nomineesRaw.slice(0, 50)) {
      const name = typeof n === 'string' ? str(n) : str((n as Record<string, unknown>)?.name);
      if (name) nominees.push({ name });
    }
    if (nominees.length < 2) continue; // a category is only valid with ≥2 nominees
    out.push({ title, nominees });
  }
  return out.length ? out : null;
}

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
      'Create (and by default publish) a due for the space. Amount is in NAIRA. Call first WITHOUT confirmed to get the summary (face, 1.5% student fee, total, extra questions, pay link) to read back to the rep; only call again with confirmed:true once they approve. Publishing is the DEFAULT: a confirmed create opens the due for payment immediately and returns the pay link — there is no separate publish step. Pass publish:false ONLY when the rep explicitly asks to keep it a draft. (Publishing needs the space to have passed KYC.) When the rep wants to COLLECT extra info from payers ("ask for / collect / require X"), put those in `fields` (the form builder) — NOT in `note`.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        amount_naira: { type: 'number', description: 'The due amount in naira (e.g. 2000 for ₦2,000).' },
        due_date: { type: 'string', description: 'Deadline as YYYY-MM-DD (today or later). You may also pass an everyday phrase like "next week", "tomorrow", "in 3 days", "Friday" or "end of the month" and it will be resolved.' },
        category: { type: 'string', enum: [...DUE_TYPES] },
        note: { type: 'string', description: 'A short optional message shown to payers. NOT for questions — use `fields` to collect answers.' },
        fields: {
          type: 'array',
          description:
            'The form builder: extra questions each payer answers on the public pay form. Use this whenever the rep says "ask for / collect / require" something (e.g. level, age, hostel, phone). Use type "number" for age/quantity, "select" (with options) for a fixed list like level/department, "email"/"phone" for those, else "text". Name, email and matric number are always collected already — do not add them.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the payer sees, e.g. "Level" or "Age".' },
              type: { type: 'string', enum: [...GUEST_FIELD_TYPES] },
              required: { type: 'boolean', description: 'Must the payer answer? Default false.' },
              options: { type: 'array', items: { type: 'string' }, description: 'Only for type "select" (≥2 options), e.g. ["100","200","300","400","500"].' },
            },
            required: ['label'],
          },
        },
        allow_guests: { type: 'boolean', description: 'Let non-members pay via the public link. Default true.' },
        publish: { type: 'boolean', description: 'Open the due for payment immediately. Default TRUE. Set false only if the rep explicitly wants to keep it as a draft.' },
        confirmed: { type: 'boolean', description: 'Only true after the rep has approved the summary.' },
      },
      required: ['title', 'amount_naira', 'due_date', 'category'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const title = str(args.title);
      const amountNaira = numArg(args.amount_naira);
      const dueDate = resolveDueDate(str(args.due_date));
      const category = str(args.category);
      if (!title || amountNaira === undefined || !category) return { error: 'title, amount_naira and category are required.' };
      if (!dueDate) return { error: `I couldn't read "${str(args.due_date) ?? ''}" as a date. Give a specific day (e.g. "next Friday", "in 2 weeks", or a date).` };
      const faceKobo = nairaToKobo(amountNaira);
      const feeKobo = checkoutFee(faceKobo);
      const guestFields = buildGuestFields(args.fields);
      const summary = {
        title,
        amount: formatNaira(faceKobo),
        studentFee: formatNaira(feeKobo),
        studentPays: formatNaira(faceKobo + feeKobo),
        dueDate,
        category,
        // The extra questions payers will answer on the form (the form builder).
        formQuestions: guestFields
          ? guestFields.map((f) => ({ label: f.label, type: f.type, required: f.required, ...(f.options ? { options: f.options } : {}) }))
          : [],
        note: str(args.note) ?? null,
        allowGuests: args.allow_guests === undefined ? true : boolArg(args.allow_guests),
        // Publishing is the default — there's no separate draft step. Only keep
        // it a draft when the rep explicitly passes publish:false.
        willPublish: args.publish === undefined ? true : boolArg(args.publish),
      };
      // Built once so the confirmation step can REMEMBER the exact payload and
      // the agent can create the due deterministically if the model later fails
      // to issue the confirmed call itself.
      const body = {
        title,
        amount: faceKobo,
        dueDate,
        category,
        note: str(args.note),
        ...(guestFields ? { guestFields } : {}),
        allowGuests: summary.allowGuests,
        publish: summary.willPublish,
      };
      if (!boolArg(args.confirmed)) {
        ctx.setPendingCreate?.({ spaceId: s.spaceId, body, title, willPublish: summary.willPublish, at: Date.now() });
        return { needsConfirmation: true, summary, instruction: 'Read this summary to the rep (including the extra questions the form will ask) and ask them to confirm before saving.' };
      }
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/dues`, token: ctx.token, body });
      if (!res.ok) return { error: res.error };
      ctx.setPendingCreate?.(null); // created — nothing is pending any more
      const due = res.data as { id?: string };
      const link = due.id ? payLink(due.id) : null;
      // Return a LEAN result (no raw kobo amounts, and NO due id) so the model has
      // nothing to accidentally paste as the link or build a fake URL from. The
      // ONLY link material it gets is the ready-made payLink string.
      return {
        created: true,
        title,
        published: summary.willPublish,
        totalStudentPays: summary.studentPays,
        payLink: link,
        instruction:
          'Saved. Tell the rep it is live (if published) and share the payLink EXACTLY as given below, verbatim. Do NOT build your own URL, do NOT change its host or path, and NEVER present an amount or id as the link.',
      };
    },
  },
  {
    name: 'publish_due',
    description: 'Publish an EXISTING draft due (created in an earlier turn) so students can pay it. Requires the space to have passed KYC. Do NOT use this for a due you just created with create_due — that already publishes. Only pass a due_id you got from a tool; never invent one.',
    parameters: { type: 'object', properties: { due_id: { type: 'string' } }, required: ['due_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const dueId = str(args.due_id);
      // Guard against a hallucinated id (e.g. "due_123"): verify it's a real due
      // in this space before publishing, and hand back the real list if not.
      const listRes = await apiCall<{ id: string; title: string; status?: string }[]>({ method: 'GET', path: `/spaces/${s.spaceId}/dues`, token: ctx.token });
      if (listRes.ok) {
        const list = Array.isArray(listRes.data) ? listRes.data : [];
        if (!list.some((d) => d.id === dueId)) {
          return { error: 'No due with that id in this space — do not guess an id. If you just created a due, it is already published; otherwise pick one of these by its exact id.', dues: list.map((d) => ({ id: d.id, title: d.title, status: d.status })) };
        }
      }
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/dues/${dueId}/publish`, token: ctx.token });
      return res.ok ? { published: res.data, payLink: payLink(dueId!) } : { error: res.error };
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
    name: 'edit_due',
    description:
      'Edit an existing due that is NOT closed — change its title, amount, deadline, category, note, or guest access. Amount is in NAIRA and CANNOT change once anyone has paid. Pass only the fields you want to change. Call first WITHOUT confirmed to show the rep what will change, then again with confirmed:true once they approve. Use the exact due_id from a tool; never invent one.',
    parameters: {
      type: 'object',
      properties: {
        due_id: { type: 'string' },
        title: { type: 'string' },
        amount_naira: { type: 'number', description: 'New amount in naira. Rejected if payments already exist.' },
        due_date: { type: 'string', description: 'New deadline — a date or an everyday phrase like "next Friday" / "in 2 weeks"; resolved for you.' },
        category: { type: 'string', enum: [...DUE_TYPES] },
        note: { type: 'string', description: 'Short message shown to payers (pass an empty string to clear it).' },
        allow_guests: { type: 'boolean', description: 'Whether non-members can pay via the public link.' },
        confirmed: { type: 'boolean' },
      },
      required: ['due_id'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const dueId = str(args.due_id);
      if (!dueId) return { error: 'due_id is required.' };
      // Guard against a made-up id: confirm the due exists in this space first.
      const listRes = await apiCall<{ id: string; title: string; status?: string }[]>({ method: 'GET', path: `/spaces/${s.spaceId}/dues`, token: ctx.token });
      if (listRes.ok) {
        const list = Array.isArray(listRes.data) ? listRes.data : [];
        if (!list.some((d) => d.id === dueId)) {
          return { error: 'No due with that id in this space — do not guess an id. Pick one of these by its exact id.', dues: list.map((d) => ({ id: d.id, title: d.title, status: d.status })) };
        }
      }
      const body: Record<string, unknown> = {};
      const changes: Record<string, unknown> = {};
      if (str(args.title)) { body.title = str(args.title); changes.title = body.title; }
      const amt = numArg(args.amount_naira);
      if (amt !== undefined) { body.amount = nairaToKobo(amt); changes.amount = formatNaira(nairaToKobo(amt)); }
      if (args.due_date !== undefined) {
        const d = resolveDueDate(str(args.due_date));
        if (!d) return { error: `I couldn't read "${str(args.due_date) ?? ''}" as a date. Give a specific day (e.g. "next Friday", "in 2 weeks", or a date).` };
        body.dueDate = d; changes.dueDate = d;
      }
      if (str(args.category)) { body.category = str(args.category); changes.category = body.category; }
      if (args.note !== undefined) { body.note = str(args.note) ?? ''; changes.note = body.note; }
      if (args.allow_guests !== undefined) { body.allowGuests = boolArg(args.allow_guests); changes.allowGuests = body.allowGuests; }
      if (Object.keys(body).length === 0) return { error: 'Nothing to change — tell me what to update (title, amount, deadline, category, note, or guest access).' };
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, changes, instruction: 'Read these changes back to the rep and get a clear yes before calling again with confirmed:true.' };
      const res = await apiCall({ method: 'PATCH', path: `/spaces/${s.spaceId}/dues/${dueId}`, token: ctx.token, body });
      return res.ok ? { updated: res.data } : { error: res.error };
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
    description:
      'List Nigerian banks (with codes) for choosing a payout destination. The UI renders the full list as selectable cards with logos, so after calling this just invite the rep to pick one — do NOT re-list every bank in your text reply.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const res = await apiCall<BankCard[]>({ method: 'GET', path: `/banks`, token: ctx.token });
      if (!res.ok) return { error: res.error };
      const banks = Array.isArray(res.data) ? res.data : [];
      // `ui` is captured by the agent loop and returned to the frontend as a card
      // list; it is stripped from what the model sees to keep context lean.
      return {
        count: banks.length,
        banks: banks.map((b) => ({ name: b.name, code: b.code })),
        ui: { kind: 'banks', items: banks },
      };
    },
  },
  {
    name: 'lookup_account',
    description: 'Name-enquiry: resolve the account holder name for a bank + 10-digit account number before saving/paying it. Pass the bank by NAME (bank_name, e.g. "PalmPay") — you do NOT need the numeric code; it is resolved for you.',
    parameters: {
      type: 'object',
      properties: {
        bank_name: { type: 'string', description: 'The bank name as the rep said it (e.g. "PalmPay", "GTB", "OPay"). Preferred.' },
        bank_code: { type: 'string', description: 'Numeric bank code, only if you already have it.' },
        account_number: { type: 'string', description: '10-digit NUBAN' },
      },
      required: ['account_number'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const bank = await resolveBankCode(args, ctx);
      if ('error' in bank) return bank;
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/payout/beneficiaries/lookup`, token: ctx.token, body: { bankCode: bank.bankCode, accountNumber: str(args.account_number) } });
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
    description: 'Save a payout destination (lead rep only). Pass the bank by NAME (bank_name) — the code is resolved for you. Call lookup_account first; call without confirmed to confirm the resolved name with the rep.',
    parameters: {
      type: 'object',
      properties: {
        bank_name: { type: 'string', description: 'The bank name as the rep said it (e.g. "PalmPay", "GTB"). Preferred.' },
        bank_code: { type: 'string', description: 'Numeric bank code, only if you already have it.' },
        account_number: { type: 'string' },
        label: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['account_number'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const bank = await resolveBankCode(args, ctx);
      if ('error' in bank) return bank;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Resolve the name with lookup_account and confirm it with the rep before saving.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/payout/beneficiaries`, token: ctx.token, body: { bankCode: bank.bankCode, accountNumber: str(args.account_number), label: str(args.label) } });
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

  // --- Polls (voting / awards) -------------------------------------------
  {
    name: 'list_polls',
    description: 'List the polls / voting campaigns this space has created, with vote counts. Optional status filter. (Polls must be enabled for the space; if not, the tool says so.)',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'active', 'closed'] } } },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/polls`, token: ctx.token, query: { status: str(args.status) } });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'create_poll',
    description:
      'Create a poll / awards-style vote for the space. A poll has one or more categories, each with AT LEAST TWO nominees. By default it is PUBLISHED immediately (set publish:false to keep a draft). If paid:true, amount_per_vote_naira (in NAIRA) is required. Call first WITHOUT confirmed to read the summary (categories + nominees) back to the rep; only call again with confirmed:true once they approve.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        deadline: { type: 'string', description: 'When voting closes — a date or an everyday phrase; resolved for you. Must be in the future.' },
        description: { type: 'string' },
        members_only: { type: 'boolean', description: 'Only space members may vote. Default false (anyone with the link).' },
        paid: { type: 'boolean', description: 'Charge per vote. Default false.' },
        amount_per_vote_naira: { type: 'number', description: 'Price per vote in naira. Required when paid:true.' },
        categories: {
          type: 'array',
          description: 'The award categories. Each needs a title and at least two nominees.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              nominees: { type: 'array', items: { type: 'string' }, description: 'Nominee names — at least two.' },
            },
            required: ['title', 'nominees'],
          },
        },
        publish: { type: 'boolean', description: 'Open for voting immediately. Default TRUE; set false only to keep a draft.' },
        confirmed: { type: 'boolean' },
      },
      required: ['title', 'deadline', 'categories'],
    },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const title = str(args.title);
      const deadline = resolveDueDate(str(args.deadline));
      if (!title) return { error: 'A poll title is required.' };
      if (!deadline) return { error: `I couldn't read "${str(args.deadline) ?? ''}" as a date. Give a specific closing day.` };
      const paid = boolArg(args.paid);
      const amountPerVoteNaira = numArg(args.amount_per_vote_naira);
      if (paid && (amountPerVoteNaira === undefined || amountPerVoteNaira <= 0)) return { error: 'For a paid poll, tell me the price per vote (in naira).' };
      const categories = buildPollCategories(args.categories);
      if (!categories) return { error: 'A poll needs at least one category, each with at least two nominees. Give me the categories and their nominees.' };
      const membersOnly = boolArg(args.members_only);
      const willPublish = args.publish === undefined ? true : boolArg(args.publish);
      const summary = {
        title,
        deadline,
        membersOnly,
        paid,
        ...(paid ? { amountPerVote: formatNaira(nairaToKobo(amountPerVoteNaira!)) } : {}),
        categories: categories.map((c) => ({ title: c.title, nominees: c.nominees.map((n) => n.name) })),
        willPublish,
      };
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, summary, instruction: 'Read this poll summary back to the rep (categories and nominees, deadline, members-only/paid) and get a clear yes before calling again with confirmed:true.' };
      const res = await apiCall({
        method: 'POST',
        path: `/spaces/${s.spaceId}/polls`,
        token: ctx.token,
        body: {
          title,
          description: str(args.description),
          deadline,
          membersOnly,
          paid,
          ...(paid ? { amountPerVote: nairaToKobo(amountPerVoteNaira!) } : {}),
          categories: categories.map((c) => ({ title: c.title, nominees: c.nominees.map((n) => ({ name: n.name })) })),
          publish: willPublish,
        },
      });
      return res.ok ? { created: res.data } : { error: res.error };
    },
  },
  {
    name: 'publish_poll',
    description: 'Publish an existing DRAFT poll so voting opens. Use the exact poll_id from list_polls; never invent one. Call without confirmed to confirm first.',
    parameters: { type: 'object', properties: { poll_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['poll_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep that they want to publish this poll.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/polls/${str(args.poll_id)}/publish`, token: ctx.token, body: {} });
      return res.ok ? { published: res.data } : { error: res.error };
    },
  },
  {
    name: 'close_poll',
    description: 'Close a poll so it stops accepting votes. Use the exact poll_id from list_polls. Call without confirmed to confirm first.',
    parameters: { type: 'object', properties: { poll_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['poll_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep that they want to close this poll.' };
      const res = await apiCall({ method: 'POST', path: `/spaces/${s.spaceId}/polls/${str(args.poll_id)}/close`, token: ctx.token, body: {} });
      return res.ok ? { closed: res.data } : { error: res.error };
    },
  },
  {
    name: 'poll_results',
    description: 'The current results / standings for a poll — nominees and their vote tallies (and revenue for a paid poll). Use the exact poll_id from list_polls.',
    parameters: { type: 'object', properties: { poll_id: { type: 'string' } }, required: ['poll_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/polls/${str(args.poll_id)}/results`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },

  // --- Circle admin (members, reps, join code, audit) --------------------
  {
    name: 'audit_log',
    description: "The space's recent activity log (who did what, when) — rep changes, join-code rotations, poll and payout events.",
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const res = await apiCall({ method: 'GET', path: `/spaces/${s.spaceId}/audit-log`, token: ctx.token });
      return res.ok ? res.data : { error: res.error };
    },
  },
  {
    name: 'regenerate_join_code',
    description: "Rotate the space's join code. The OLD code stops working immediately, so warn the rep. Call without confirmed to confirm first; on success returns the new code to share.",
    parameters: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Warn the rep the current join code will stop working, and confirm before rotating it.' };
      const res = await apiCall<{ code?: string }>({ method: 'POST', path: `/spaces/${s.spaceId}/join-code/regenerate`, token: ctx.token, body: {} });
      return res.ok ? { joinCode: res.data?.code ?? null } : { error: res.error };
    },
  },
  {
    name: 'remove_member',
    description: 'Remove a member from the space (lead rep only). Pass the exact user_id from list_members — never invent one. If they are also a rep, remove the rep role first. Call without confirmed to confirm first.',
    parameters: { type: 'object', properties: { user_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['user_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const uid = str(args.user_id);
      if (!uid) return { error: 'user_id is required — get it from list_members.' };
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep which member to remove (by name) before calling again with confirmed:true.' };
      const res = await apiCall({ method: 'DELETE', path: `/spaces/${s.spaceId}/members/${uid}`, token: ctx.token });
      return res.ok ? { removed: true } : { error: res.error };
    },
  },
  {
    name: 'remove_rep',
    description: 'Remove a co-rep (revoke their rep role) — lead rep only. Pass the exact user_id from list_reps; never invent one. You cannot remove the sole lead rep. Call without confirmed to confirm first.',
    parameters: { type: 'object', properties: { user_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['user_id'] },
    async run(args, ctx) {
      const s = resolveSpace(ctx);
      if ('error' in s) return s;
      const uid = str(args.user_id);
      if (!uid) return { error: 'user_id is required — get it from list_reps.' };
      if (!boolArg(args.confirmed)) return { needsConfirmation: true, instruction: 'Confirm with the rep which co-rep to remove (by name) before calling again with confirmed:true.' };
      const res = await apiCall({ method: 'DELETE', path: `/spaces/${s.spaceId}/reps/${uid}`, token: ctx.token });
      return res.ok ? { removed: true } : { error: res.error };
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
