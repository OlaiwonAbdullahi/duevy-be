import { z } from 'zod';

/**
 * Guest form builder — the extra questions a rep asks guests on a due's
 * public pay link (`dues.guestFields`), on top of the name and email every
 * guest checkout needs. `null` keeps the original form (an optional matric
 * number); `[]` asks nothing extra.
 *
 * Answers are stored on the checkout (`checkouts.guestAnswers`) with each
 * field's label copied in, so renaming or removing a field later doesn't
 * blank out what earlier guests said.
 */

export const GUEST_FIELD_TYPES = ['text', 'textarea', 'number', 'email', 'phone', 'select'] as const;
export const MAX_GUEST_FIELDS = 10;
const MAX_ANSWER_LENGTH = 500;

export const guestFieldSchema = z
  .object({
    id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(GUEST_FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options?.length ?? 0) >= 2, {
    message: 'a dropdown needs at least two options',
    path: ['options'],
  })
  .transform((f) => (f.type === 'select' ? f : { ...f, options: undefined }));

export const guestFieldsSchema = z
  .array(guestFieldSchema)
  .max(MAX_GUEST_FIELDS)
  .refine((fields) => new Set(fields.map((f) => f.id)).size === fields.length, 'field ids must be unique')
  .nullable();

export type GuestField = z.output<typeof guestFieldSchema>;
export type GuestAnswer = { fieldId: string; label: string; value: string };

/** A due's stored fields, or `null` for the original form. */
export function readGuestFields(raw: unknown): GuestField[] | null {
  const parsed = guestFieldsSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Check a guest's answers against the due's fields. Unknown keys are ignored
 * and blank optional answers dropped. Returns the answers to store, or the
 * per-field issues in the `VALIDATION_ERROR` shape.
 */
export function checkGuestAnswers(
  fields: GuestField[],
  input: Record<string, string> | undefined,
): { answers: GuestAnswer[] } | { issues: Array<{ field: string; issue: string }> } {
  const answers: GuestAnswer[] = [];
  const issues: Array<{ field: string; issue: string }> = [];

  for (const f of fields) {
    const value = (input?.[f.id] ?? '').trim();
    const field = `answers.${f.id}`;
    if (!value) {
      if (f.required) issues.push({ field, issue: `${f.label} is required` });
      continue;
    }
    if (value.length > MAX_ANSWER_LENGTH) issues.push({ field, issue: `must be ${MAX_ANSWER_LENGTH} characters or fewer` });
    else if (f.type === 'email' && !EMAIL_RE.test(value)) issues.push({ field, issue: 'must be a valid email' });
    else if (f.type === 'phone' && !PHONE_RE.test(value)) issues.push({ field, issue: 'must be a valid phone number' });
    else if (f.type === 'number' && !NUMBER_RE.test(value)) issues.push({ field, issue: 'must be a number' });
    else if (f.type === 'select' && !f.options?.includes(value)) issues.push({ field, issue: 'must be one of the options' });
    else answers.push({ fieldId: f.id, label: f.label, value });
  }

  return issues.length ? { issues } : { answers };
}

/** A checkout's stored answers. */
export function readGuestAnswers(raw: unknown): GuestAnswer[] {
  return Array.isArray(raw) ? (raw as GuestAnswer[]) : [];
}
