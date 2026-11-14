/**
 * Deterministic date resolution for the Duevy agent.
 *
 * The model's job is to pass along the rep's *date expression* ("next Friday",
 * "end of the month", "same day next week"). The resolution of that expression
 * into a real calendar date is done HERE, in code, against the current date in
 * the rep's timezone — never by the LLM, which must not do calendar arithmetic
 * (the prompt's "Never train the model to memorize fixed calendar dates").
 *
 * Default timezone is Africa/Lagos (Nigerian users). Lagos is UTC+1 all year
 * (no DST), but we resolve the civil date through Intl so a different account
 * timezone can be plugged in without changing the logic.
 *
 * All returned dates are `YYYY-MM-DD` (date-only); dues are deadlines, not
 * timestamps. `resolve()` returns a small structured result so callers (and the
 * eval harness) can see which expression matched and how confident we are.
 */

export const DEFAULT_TZ = 'Africa/Lagos';

export interface DateResolution {
  /** Resolved calendar date as YYYY-MM-DD, or null if the phrase can't be resolved. */
  iso: string | null;
  /** The normalized expression we matched (for logging / eval), e.g. "+7d", "next-weekday:friday". */
  matched: string;
  /**
   * low  → we couldn't resolve it and the caller should ask a short question.
   * med  → resolved, but the phrase is genuinely ambiguous (we picked the sensible reading).
   * high → unambiguous.
   */
  confidence: 'high' | 'med' | 'low';
  /** When confidence is low, a short, human reason the caller can surface. */
  reason?: string;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Spelled-out small numbers Nigerians use in dates ("in two weeks", "seven days from now"). */
const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, sixty: 60,
};

/** Parse a count that may be digits ("3") or a word ("three", "a"). */
function count(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const t = token.trim().toLowerCase();
  if (/^\d{1,4}$/.test(t)) return Number(t);
  return WORD_NUMBERS[t];
}

// --- civil-date helpers (timezone-correct, DST-agnostic) -------------------

/** The civil Y/M/D "now" in `tz`, as a UTC-midnight anchor we can do day math on. */
function civilToday(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
/** Add calendar months, clamping the day (Jan 31 + 1mo → Feb 28/29). */
function addMonths(base: Date, months: number): Date {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
function endOfMonth(base: Date): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
}
function firstOfNextMonth(base: Date): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
}
/** Next occurrence of `targetDow` strictly after today; if today is it, +7. */
function nextWeekday(today: Date, targetDow: number): Date {
  const delta = (targetDow - today.getUTCDay() + 7) % 7 || 7;
  return addDays(today, delta);
}

/** The civil date + weekday name in `tz`, for injecting "today" into the prompt. */
export function todayContext(opts: { now?: Date; tz?: string } = {}): { iso: string; weekday: string } {
  const tz = opts.tz ?? DEFAULT_TZ;
  const d = civilToday(opts.now ?? new Date(), tz);
  return { iso: iso(d), weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]! };
}

const ok = (d: Date, matched: string, confidence: 'high' | 'med' = 'high'): DateResolution => ({
  iso: iso(d),
  matched,
  confidence,
});

/**
 * Resolve an everyday date expression to a calendar date.
 *
 * @param input  The rep's phrase, or an already-resolved YYYY-MM-DD.
 * @param opts.now  Override "now" (for tests / eval). Defaults to the real clock.
 * @param opts.tz   The rep's timezone. Defaults to Africa/Lagos.
 */
export function resolve(
  input: string | undefined | null,
  opts: { now?: Date; tz?: string } = {},
): DateResolution {
  const tz = opts.tz ?? DEFAULT_TZ;
  const now = opts.now ?? new Date();
  if (!input || !input.trim()) {
    return { iso: null, matched: 'empty', confidence: 'low', reason: 'No date was given.' };
  }

  const raw = input.trim();
  // Already a calendar date → pass through unchanged.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      return { iso: null, matched: 'bad-iso', confidence: 'low', reason: `"${raw}" is not a real date.` };
    }
    return { iso: raw, matched: 'iso', confidence: 'high' };
  }

  const s = raw.toLowerCase().replace(/\s+/g, ' ');
  const today = civilToday(now, tz);

  // Order matters below: multi-word relative phrases ("a week from today") are
  // matched BEFORE the bare "today"/"tomorrow" anchors, so a phrase that merely
  // contains "today" isn't short-circuited into meaning today.

  // --- "day after tomorrow" / "the day after tomorrow" ---
  if (/\b(day after tomorrow|overmorrow)\b/.test(s)) return ok(addDays(today, 2), '+2d');

  // --- "in N hours" → round to days (dues are date-only). "in 48 hours" = +2d ---
  const hours = s.match(/\bin\s+(\d{1,3}|[a-z]+)\s*(?:hours?|hrs?|hr)\b/);
  if (hours) {
    const n = count(hours[1]);
    if (n !== undefined) return ok(addDays(today, Math.max(1, Math.round(n / 24))), `+${Math.round(n / 24)}d(hours)`);
  }

  // --- "in N days/weeks/months", "N days from now", "N weeks from today" ---
  const inN = s.match(/\b(?:in|after)\s+(\d{1,3}|[a-z]+)\s*(day|week|month)s?\b/);
  const fromNow = s.match(/\b(\d{1,3}|[a-z]+)\s*(day|week|month)s?\s+(?:from\s+(?:now|today)|time|later|out)\b/);
  const rel = inN ?? fromNow;
  if (rel) {
    const n = count(rel[1]);
    if (n !== undefined) {
      if (rel[2] === 'day') return ok(addDays(today, n), `+${n}d`);
      if (rel[2] === 'week') return ok(addDays(today, n * 7), `+${n * 7}d`);
      return ok(addMonths(today, n), `+${n}mo`);
    }
  }

  // --- week-granularity phrases that mean "seven days from today" ---
  // "next week", "same day next week", "a week from today", "in a week", "one week", "week today".
  if (/\b(same day next week|next week|a week from (now|today)|in a week|one week|a week('?s)? time|week today|7 days? (from (now|today)|time))\b/.test(s)) {
    return ok(addDays(today, 7), '+7d');
  }

  // --- bare single-day anchors (after the multi-word phrases above) ---
  if (/\btoday\b|\brite now\b|\bright now\b|\bnow now\b/.test(s)) return ok(today, 'today');
  if (/\btomorrow\b|\btomoro\b|\btmrw\b|\b2 days time\b/.test(s)) {
    return ok(addDays(today, /2 days time/.test(s) ? 2 : 1), /2 days time/.test(s) ? '+2d' : '+1d');
  }

  // --- month boundaries ---
  if (/\b(end of (the |this )?month|month('?s)? end|by month end|last day of (the |this )?month)\b/.test(s)) {
    return ok(endOfMonth(today), 'end-of-month');
  }
  if (/\b(beginning|start|first|1st) of (the )?(next|coming|following) month\b/.test(s) || /\bnext month('?s)? (start|beginning)\b/.test(s)) {
    return ok(firstOfNextMonth(today), 'first-of-next-month');
  }
  // "next month" / "in a month" → same civil day, next month.
  if (/\b(next month|in a month|a month from (now|today)|one month)\b/.test(s)) {
    return ok(addMonths(today, 1), '+1mo');
  }

  // --- week boundaries ---
  if (/\b(this weekend|by (the )?weekend|the weekend)\b/.test(s)) {
    return ok(nextWeekday(today, 6), 'this-weekend', 'med'); // coming Saturday
  }
  if (/\b(end of (the |this )?week|end of week|by (the )?end of (the )?week)\b/.test(s)) {
    return ok(nextWeekday(today, 0), 'end-of-week', 'med'); // coming Sunday
  }

  // --- weekday names: "friday", "this friday", "next friday", "by monday", "come tuesday" ---
  const wdIndex = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(s));
  if (wdIndex >= 0) {
    // Both "this X" and "next X" resolve to the next upcoming X. In Nigerian usage
    // "next friday" overwhelmingly means the coming Friday, not the one after.
    // (Documented in ai-engineering/docs/limitations.md.)
    const target = nextWeekday(today, wdIndex);
    const isNext = /\bnext\b/.test(s);
    return ok(target, `${isNext ? 'next' : 'this'}-weekday:${WEEKDAYS[wdIndex]}`, 'high');
  }

  // --- things we deliberately DON'T guess: ask instead ---
  if (/\b(next semester|next session|next term|next year|end of semester|end of session)\b/.test(s)) {
    return {
      iso: null,
      matched: 'needs-clarification:academic',
      confidence: 'low',
      reason: 'Academic periods (semester/session/term) vary by school — ask for a specific date.',
    };
  }

  return {
    iso: null,
    matched: 'unparsed',
    confidence: 'low',
    reason: `Couldn't read "${raw}" as a date.`,
  };
}

/**
 * Back-compat convenience used by tools.ts: returns just the ISO string, or null.
 * New code should prefer `resolve()` for the confidence/reason.
 */
export function resolveDueDate(input: string | undefined, opts: { now?: Date; tz?: string } = {}): string | null {
  return resolve(input, opts).iso;
}
