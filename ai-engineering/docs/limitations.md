# Known Limitations & Design Choices

Honest list of where the assistant makes a deliberate call, and where it is
genuinely limited today.

## Date semantics (deliberate choices in `src/ai/dates.ts`)

- **"next &lt;weekday&gt;" resolves to the coming occurrence, not the week after.**
  In Nigerian usage "next Friday" overwhelmingly means the nearest upcoming Friday,
  so `resolve('next friday')` and `resolve('this friday')` both return the next
  Friday on the calendar. This is intentional and documented in the code.
- **Academic periods are not guessed.** "next semester", "next session", "next term"
  return `confidence: 'low'` with a clarification reason instead of a date, because
  these vary by school. The agent should ask for a specific date rather than invent
  one.
- **"this weekend" edge case.** When today is already Saturday/Sunday, "this weekend"
  resolves to the *coming* Saturday (med confidence) rather than today. Rare for a
  due deadline; flagged as medium confidence so it can be surfaced if needed.
- Unparseable phrases return `iso: null` with a reason, and `create_due` turns that
  into a short "give me a specific day" message rather than failing silently.

## State & scaling

- **Sessions are in-memory and single-instance.** `src/ai/agent.ts` keeps sessions
  in a process-local `Map`. They are **lost on restart** and are **not shared across
  instances**, so the agent is not horizontally scalable as-is. Moving to a shared
  store (e.g. Redis) is required before running more than one instance.
- **Conversation memory is a capped transcript + active space.** History is capped
  at `MAX_HISTORY = 16` turns with a 30-min TTL. There is **no structured cross-turn
  slot-filling** yet — e.g. collecting amount, then date, then compulsory-flag into
  a persisted task object. Multi-turn works through the transcript, which is adequate
  for short flows but can drop detail in long ones.
- WhatsApp link codes are likewise in-memory and single-instance.

## Model behaviour

- **The model can still mis-select a tool or an argument.** We do not rely on the
  model for correctness. The real safety net is: the `confirmed` gate on every
  mutating tool (nothing is saved until the rep approves the read-back summary), the
  scoped JWT (`spaceIds`), and full backend zod/KYC/auth validation on every call.
  A wrong tool call surfaces as an error or a confirmation prompt, not a bad write.
- Amount and money formatting depend on the prompt's kobo/naira rules; values are
  centralised in `src/lib/money.ts`, but display correctness still passes through the
  model's wording.

## Fine-tuning

- **Fine-tuning cannot run in the dev environment** — it needs 8× 80 GB GPUs (LoRA)
  or 4 nodes (full SFT); see [model-compatibility.md](./model-compatibility.md).
- **Serving a fine-tuned model requires self-hosting a NIM container.** The hosted
  `integrate.api.nvidia.com` endpoint does not accept custom adapters.
- Any accuracy improvement from fine-tuning is **to be measured** against the base
  model using the harness in [`../evaluation`](../evaluation); do not assume a gain
  without a measured result.
