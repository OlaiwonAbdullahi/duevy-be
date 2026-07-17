# Duey — AI Chat Assistant API Guide

Duey is Duevy's in-app chat assistant. Students and reps type natural-language requests ("pay my handout fee", "join CSSA with code CSSA-7F2K") and Duey routes them to real backend actions — pay dues, join a department, check balance, view history, or find a rep's contact.

**This is not a general chatbot.** The LLM (Gemma) only classifies intent and extracts parameters into strict JSON — it never generates the chat reply text, never touches the database, and never moves money. A deterministic validation layer checks the LLM's proposed intent against real DB state before anything happens, and a template-string formatter builds the reply the user sees. See [src/services/assistant.service.ts](../src/services/assistant.service.ts) for the full pipeline.

For general API conventions (response envelope, auth, headers), see [FRONTEND_API_GUIDE.md](./FRONTEND_API_GUIDE.md#1-core-concepts) — everything there applies here too.

---

## 1. How It Works

1. **Classify** — the message is checked against an invite-code regex first (cheap, deterministic). If it matches, the request short-circuits straight to `join_department` and Gemma is never called. Otherwise, the message plus the last 5 conversation turns are sent to Gemma with a system prompt listing the supported intents and a strict JSON output schema. The response is Zod-validated; malformed or unparseable output is discarded and treated as `unknown` — it never reaches a handler.
2. **Validate + execute** — the classified intent + extracted params are checked against real data (does this due exist? is this invite code active? is the user already a member?). Nothing here trusts the LLM's params blindly — due names, amounts, and invite codes are all re-looked-up in Postgres.
3. **Format** — the DB-backed result is turned into chat bubble text and quick-reply buttons using plain template strings. No second LLM call — this avoids latency and hallucination risk on money-related confirmations.

**Money and department-membership actions require a second, explicit step.** Duey never charges a card/wallet or creates a space membership directly from a chat message — see §4 (Confirmation Flow) below.

---

## 2. Supported Intents

| Intent | What it does | Executes immediately from `/message`? |
| --- | --- | --- |
| `pay_dues` | Finds the named (or only) unpaid due and returns a payment-intent object | No — frontend opens the payment modal, user pays via the existing `POST /dues/{dueId}/pay` |
| `join_department` | Validates an invite code and previews the department | No — requires `POST /assistant/confirm` |
| `check_balance` | Wallet balance + itemized unpaid dues | Yes (read-only) |
| `view_history` | Last 5–10 transactions | Yes (read-only) |
| `contact_rep` | Department rep's name/email/phone | Yes (read-only) |
| `unknown` | Anything else, or low classifier confidence | Returns a static help message |

---

## 3. POST /assistant/message

**Flow:** Called on every chat turn. Pass the `conversationId` you got back on the previous turn to keep multi-turn context (e.g. Duey asks "which due item?", the next message "handout fee" is answered using the last 5 turns as context). Omit `conversationId` on the first message of a new chat — one is created and returned.

**Payload**
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `message` | string | ✅ | 1–1000 chars |
| `conversationId` | string | ❌ | omit to start a new conversation |

```json
{
  "conversationId": "cnv_9f2k3a1x",
  "message": "pay my handout fee"
}
```

**Response `200`**
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "pay_dues",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "Ready to pay \"Handout Fee\" (₦5,150.00) to Economics Student Association? Tap below to continue.",
    "quickReplies": [{ "label": "Pay now", "value": "pay now" }],
    "action": { "type": "open_payment_modal", "dueId": "due_7h2m9k" }
  }
}
```

### Field notes
- **`confidence`** — `1` for the invite-code regex short-circuit, `0.7` for a Gemma-classified turn, `0` for anything that fell back to `unknown`. Logged on every request (with `intent`) as the `AssistantMessage` row for later fine-tuning evaluation — not used for anything yet beyond that.
- **`needsClarification`** — `true` when Duey is presenting real options (e.g. multiple dues match "fee") rather than a ready-to-act result. The options themselves are always real DB rows (title + amount), never LLM-generated text.
- **`quickReplies`** — buttons the frontend should render. Tapping one re-sends its `value` as the next `message` (e.g. tapping a due's title re-runs classification with that exact name, which then resolves unambiguously).
- **`action`** — `null` unless the intent is ready to act:
  - `{ "type": "open_payment_modal", "dueId": "..." }` — open the existing payment modal for this due. **Duey does not charge anything itself.**
  - `{ "type": "confirm_join_department", "spaceId": "...", "inviteCode": "..." }` — show a "Join {space}?" confirmation; the tap should call `POST /assistant/confirm` (§4), not the join mutation directly.

### Example — ambiguous due name
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "pay_dues",
    "confidence": 0.7,
    "needsClarification": true,
    "reply": "I found a few dues that could match — which one did you mean?\nHandout Fee — ₦5,150.00 (CSSA)\nDinner Levy — ₦10,300.00 (CSSA)",
    "quickReplies": [
      { "label": "Handout Fee", "value": "Handout Fee" },
      { "label": "Dinner Levy", "value": "Dinner Levy" }
    ],
    "action": null
  }
}
```

### Example — check balance (no LLM call for the result formatting; Gemma is only used to classify the intent)
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "check_balance",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "Your wallet balance is ₦12,000.00. You owe ₦5,150.00 across 1 due(s):\nHandout Fee — ₦5,150.00 (CSSA)",
    "quickReplies": [],
    "action": null
  }
}
```

### Example — invite code short-circuit (no LLM call at all)
Sending `"join CSSA-7F2K"` matches the invite-code regex before Gemma is ever invoked:
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "join_department",
    "confidence": 1,
    "needsClarification": false,
    "reply": "Found it — Computer Science Student Association (240 members). Join now?",
    "quickReplies": [{ "label": "Yes, join", "value": "yes" }],
    "action": { "type": "confirm_join_department", "spaceId": "spc_4k2m1x", "inviteCode": "CSSA-7F2K" }
  }
}
```

### Example — unknown / low confidence
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "unknown",
    "confidence": 0,
    "needsClarification": false,
    "reply": "I can help you pay dues, join a department, check your balance, view your payment history, or find your department rep's contact. What would you like to do?",
    "quickReplies": [],
    "action": null
  }
}
```

Errors: `429 RATE_LIMITED` if the caller exceeds 20 messages/minute. `400 VALIDATION_ERROR` if `message` is empty or over 1000 chars.

---

## 4. POST /assistant/confirm

**Flow:** Called when the user taps the "Yes, join" quick-reply / button shown after a `join_department` result from `/message`. This is the explicit human-confirmation step the safety rules require — Duey never creates a space membership straight from the LLM's classification. Re-validates the invite code server-side (it may have changed between the two calls) before mutating.

`pay_dues` has no equivalent `/confirm` call — the frontend opens the payment modal directly from the `action.dueId` in the `/message` response and charges through the existing `POST /dues/{dueId}/pay`, which already requires an `Idempotency-Key` and is the single source of truth for money movement.

**Payload**
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `conversationId` | string | ✅ | must belong to the caller |
| `spaceId` | string | ✅ | from the preceding `action.spaceId` |
| `inviteCode` | string | ✅ | from the preceding `action.inviteCode` |

```json
{
  "conversationId": "cnv_9f2k3a1x",
  "spaceId": "spc_4k2m1x",
  "inviteCode": "CSSA-7F2K"
}
```

**Response `201`**
```json
{
  "success": true,
  "data": {
    "status": "joined",
    "spaceName": "Computer Science Student Association",
    "joinedAt": "2026-07-17T10:15:00.000Z"
  }
}
```

**Response `200` — already a member** (not an error; the code was valid, there's just nothing to do)
```json
{
  "success": true,
  "data": {
    "status": "already_member",
    "spaceName": "Computer Science Student Association"
  }
}
```

**Response `404`** — `conversationId` doesn't belong to the caller.
**Response `422 JOIN_CODE_INVALID`** — the code is no longer valid (space archived, code changed, etc. since `/message` returned the preview).

---

## 5. Conversation State

`conversationId` scopes a running chat so multi-turn clarification works (Duey asks "which due item?" → user replies "handout fee" → the follow-up is classified using the last 5 turns as context, not just the bare word "handout fee"). Conversations and their messages live in Postgres (`assistant_conversations` / `assistant_messages`) — there's no client-side history to manage beyond holding onto the `conversationId` string between calls.

Start a new conversation any time by omitting `conversationId` — useful for a "new chat" button in the UI.
