# Duevy AI Assistant — Current Architecture

This documents the AI assistant as it exists in `src/ai/*`. It is the baseline the
rest of `ai-engineering/` builds on.

## Overview

The assistant turns a rep's natural-language message into actions on their
space(s). It is a **tool-calling agent over Duevy's own public REST API**: every
tool is a thin wrapper that calls the same endpoints the dashboard uses, carrying
a short-lived JWT minted for the linked rep. The model plans and confirms; the
backend enforces the real rules (auth, KYC, PIN, idempotency, confirm-before-save).

Two channels share one agent core:

- **Web chat** — `src/routes/ai.ts`
- **WhatsApp bot** — `src/channels/whatsapp/*` (Baileys)

Both call `handleMessage(userId, text)` in `src/ai/agent.ts`.

## Request → response loop (`src/ai/agent.ts`)

`handleMessage` ([agent.ts:73](../../src/ai/agent.ts#L73)):

1. `loadRepContext(userId)` → rep + the spaces they rep, or bail with a friendly
   "no active rep account" message.
2. `mintToken(rep)` → a scoped access token for the REST calls.
3. Build/fetch the per-rep **in-memory session**: `history`, `activeSpaceId`,
   `updatedAt`. TTL is 30 min (`SESSION_TTL_MS`); history is capped at
   `MAX_HISTORY = 16` user/assistant turns.
4. Inject "today" via `todayContext()` (Africa/Lagos civil date + weekday) so the
   prompt and the deterministic resolver agree.
5. Compose messages: `[system prompt, ...history, user text]`.
6. Run the NIM chat-completions loop, up to `MAX_TOOL_ROUNDS = 6`:
   - `tool_choice: 'auto'`, `temperature: 0.2`.
   - If the model returns no tool calls → that message is the final reply.
   - Otherwise execute each tool call, push a `tool` message with the JSON result,
     and loop.
7. Persist **only the clean user/assistant turn** to history (tool traffic is not
   stored), so the stored transcript is always valid. Save `activeSpaceId`.

```
Rep ──text──► handleMessage
                │ loadRepContext + mintToken
                │ getSession (in-memory, per rep)
                ▼
         ┌──────────────────────────────┐
         │  system prompt + history + msg│
         └──────────────┬───────────────┘
                        ▼
           ┌──────────────────────────┐   up to 6 rounds
           │  NIM chat.completions     │◄───────────────┐
           │  (tool_choice: auto)      │                │
           └───────────┬──────────────┘                │
             tool_calls?│                               │
                 yes    ▼                               │
        ┌───────────────────────────┐   tool result    │
        │ findTool → tool.run(args) │──── JSON ─────────┘
        │  → apiCall (REST, as rep) │
        └───────────────────────────┘
                 no  │ (final text)
                     ▼
        persist clean turn ──► reply to rep
```

## Identity & tokens (`src/ai/identity.ts`)

- `loadRepContext(userId)` ([identity.ts:25](../../src/ai/identity.ts#L25)) reads the
  user, filters out suspended/deactivated accounts and archived spaces, and returns
  `{ userId, name, role, spaces[] }`.
- `mintToken(ctx)` ([identity.ts:53](../../src/ai/identity.ts#L53)) signs an access
  token whose claims include `spaceIds` — so the agent can never touch a space the
  rep doesn't rep. **Authorization is scoped at the token, enforced at the backend.**
- WhatsApp linking: `createLinkCode` / `consumeLinkCode` bind an E.164 number to an
  account via a one-time 6-digit code (in-memory, 10-min TTL).

## Tool layer (`src/ai/tools.ts`, `src/ai/api.ts`)

25 tools, each shaped `{ name, description, parameters, run(args, ctx) }`, exposed
to the model via `toolSpecs()`. They cover the rep's whole surface: dues,
reporting/collections, payouts & beneficiaries, team, KYC, settings.

Key invariants:

- **Same API as the dashboard.** `apiCall` ([api.ts:36](../../src/ai/api.ts#L36))
  hits `"/v1" + path` with the rep's bearer token, through the exact same
  `requireSpaceRep` auth, zod validation, KYC gates, idempotency and confirmation
  logic as the UI. The chat can never do more than the rep could do by hand.
- **Confirmation gate.** Every mutating tool (`create_due`, `close_due`,
  `delete_due`, `add_beneficiary`, `request_withdrawal`, `update_space`, …) takes a
  `confirmed` flag. Called without it, the tool does **not** act — it returns a
  summary and asks the agent to read it back first. Withdrawals additionally require
  the PIN when the space uses PIN mode, and send an `Idempotency-Key`.
- **Active-space resolution.** `resolveSpace(ctx)` ([tools.ts](../../src/ai/tools.ts))
  returns the active space, auto-selects it when the rep has exactly one, or returns
  an error listing the spaces so the model can ask + call `set_active_space`.
- **Money** is centralised in `src/lib/money.ts` (naira ↔ kobo, checkout fee); the
  prompt tells the model tool values are kobo and rep inputs are naira.

## Deterministic date layer (`src/ai/dates.ts`)

Relative date expressions ("next Friday", "same day next week", "end of the month")
are resolved **in code**, never by the LLM. `resolve(input, { now, tz })` returns
`{ iso, matched, confidence, reason? }`; `resolveDueDate()` is the string-or-null
wrapper used by `create_due`. Default timezone is `Africa/Lagos`, resolved through
`Intl` so a different account timezone can be plugged in. The model's only job is to
pass the rep's phrase through; the calendar arithmetic is deterministic and unit
tested (`src/ai/dates.test.ts`, anchored at 2026-11-14).

## State & scope notes

- Sessions are **in-memory, single-instance** (demo scope). See
  [limitations.md](./limitations.md).
- Conversation memory = capped transcript + `activeSpaceId`. There is no structured
  cross-turn slot-filling yet.
