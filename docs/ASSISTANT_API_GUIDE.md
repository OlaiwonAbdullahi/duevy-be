# Duey — AI Chat Assistant API Guide

Duey is Duevy's in-app chat assistant. Students and reps type natural-language requests ("pay my handout fee", "join CSSA with code CSSA-7F2K", "top up ₦5,000", rep: "create a handout fee due for Friday") and Duey routes them to real backend actions — pay dues, join a department, check balance, view history, find a rep's contact, fund the wallet, or (reps only) create a due and check a collections summary.

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
| `fund_wallet` | Parses a stated naira amount, validates it against top-up bounds | No — frontend opens the top-up modal, user pays via the existing `POST /wallet/top-up` |
| `create_due` (rep-only) | Extracts title/amount/date/category, resolves which of the rep's spaces it's for, asks for anything missing | No — requires `POST /assistant/confirm`; created as a **draft** (publish from the dashboard) |
| `rep_summary` (rep-only) | Per-space totals: dues raised, gross collected, net to space, lifetime payouts | Yes (read-only) |
| `unknown` | Anything else, or low classifier confidence | Returns a static help message |

Rep-only intents aren't gated by the classifier — Gemma doesn't know the caller's role. The handler checks `SpaceRep` membership itself and returns a plain "you're not a rep of any department" reply for students who try, rather than a permission error.

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

### Example — fund_wallet, amount ready
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "fund_wallet",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "Ready to fund your wallet with ₦5,000.00? Tap below to continue.",
    "quickReplies": [{ "label": "Top up now", "value": "top up now" }],
    "action": { "type": "open_topup_modal", "amount": 500000 }
  }
}
```
`amount` on the action is in kobo, ready to hand straight to the existing `POST /wallet/top-up` (which itself still requires an `Idempotency-Key` and a `method`/`cardId` choice — Duey only supplies the amount).

### Example — create_due (rep), missing fields
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "create_due",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "To create this due for Computer Science Student Association I still need: amount, due date. Let me know and I'll set it up.",
    "quickReplies": [],
    "action": null
  }
}
```
The rep's next message (e.g. "₦3,000, next Friday") is classified using the last 5 turns as context, same as the pay_dues clarification flow — Gemma resolves "next Friday" to an absolute date using today's date, which is baked into the system prompt fresh on every call (see [assistantPrompt.ts](../src/config/assistantPrompt.ts)).

### Example — create_due, ready to confirm
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "create_due",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "Create \"Handout Fee\" for Computer Science Student Association: ₦3,000.00, due 2026-07-24? It'll be saved as a draft you can publish from your dashboard.",
    "quickReplies": [{ "label": "Create due", "value": "yes" }],
    "action": {
      "type": "confirm_create_due",
      "spaceId": "spc_4k2m1x",
      "title": "Handout Fee",
      "amount": 300000,
      "dueDate": "2026-07-24",
      "category": "handout"
    }
  }
}
```

### Example — rep_summary
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "intent": "rep_summary",
    "confidence": 0.7,
    "needsClarification": false,
    "reply": "Here's your collections summary:\nComputer Science Student Association: 4 due(s), ₦412,000.00 collected, ₦400,000.00 net, ₦350,000.00 paid out",
    "quickReplies": [],
    "action": null
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
    "reply": "I can help you pay dues, join a department, check your balance, view your payment history, find your department rep's contact, or fund your wallet. Reps can also create dues and check their collections summary. What would you like to do?",
    "quickReplies": [],
    "action": null
  }
}
```

Errors: `429 RATE_LIMITED` if the caller exceeds 20 messages/minute. `400 VALIDATION_ERROR` if `message` is empty or over 1000 chars.

---

## 4. POST /assistant/confirm

**Flow:** Called when the user taps the confirm quick-reply / button shown after a `join_department` or `create_due` result from `/message`. This is the explicit human-confirmation step the safety rules require — Duey never creates a space membership or a due straight from the LLM's classification. Branches on which fields are present in the body: `inviteCode` → join a department; `title`+`amount`+`dueDate`+`category` → create a due. Both branches re-validate everything server-side (invite code still active, caller still a rep of the space) before mutating.

`pay_dues` and `fund_wallet` have no equivalent `/confirm` call — the frontend opens the payment/top-up modal directly from the `action` in the `/message` response and charges through the existing `POST /dues/{dueId}/pay` / `POST /wallet/top-up`, which already require an `Idempotency-Key` and are the single source of truth for money movement.

**Payload — join_department**
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

**Payload — create_due (rep-only)**
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `conversationId` | string | ✅ | must belong to the caller |
| `spaceId` | string | ✅ | from the preceding `action.spaceId` |
| `title` | string | ✅ | from `action.title` |
| `amount` | number | ✅ | kobo, from `action.amount` |
| `dueDate` | string | ✅ | `YYYY-MM-DD`, from `action.dueDate` |
| `category` | `"levy"` \| `"dinner"` \| `"handout"` \| `"welfare"` \| `"sport"` | ✅ | from `action.category` |

```json
{
  "conversationId": "cnv_9f2k3a1x",
  "spaceId": "spc_4k2m1x",
  "title": "Handout Fee",
  "amount": 300000,
  "dueDate": "2026-07-24",
  "category": "handout"
}
```

**Response `201`**
```json
{
  "success": true,
  "data": {
    "status": "created",
    "dueId": "due_7h2m9k",
    "title": "Handout Fee",
    "spaceName": "Computer Science Student Association"
  }
}
```
Created as a **draft** (`Due.status = 'draft'`) — same as leaving `publish: false` on the dashboard's `POST /spaces/{spaceId}/dues`. The rep still needs to hit publish from the dashboard before members can pay it; Duey doesn't auto-publish. A `403 FORBIDDEN` comes back if the caller is no longer a rep of that space by the time they confirm.

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

---

## 6. GET /assistant/conversations

**Flow:** Powers a chat-history list ("previous conversations" sidebar, ChatGPT-style) — every conversation the caller has ever had with Duey, most recently active first, with a one-line preview (the last message in that conversation, whichever side sent it). Paginated like every other list endpoint — see [FRONTEND_API_GUIDE.md §1.7](./FRONTEND_API_GUIDE.md#1-core-concepts) for the shared `page`/`perPage` query params.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "cnv_9f2k3a1x",
      "preview": "Ready to pay \"Handout Fee\" (₦5,150.00) to Economics Student Association? Tap below to continue.",
      "createdAt": "2026-07-17T10:00:00.000Z",
      "updatedAt": "2026-07-17T10:00:05.000Z"
    },
    {
      "id": "cnv_2j8h5k",
      "preview": "Your wallet balance is ₦12,000.00. You owe ₦5,150.00 across 1 due(s):\nHandout Fee — ₦5,150.00 (CSSA)",
      "createdAt": "2026-07-15T09:30:00.000Z",
      "updatedAt": "2026-07-15T09:31:00.000Z"
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 2, "totalPages": 1 }
}
```
`preview` is `null` for a conversation that was created but never actually got a message persisted (shouldn't normally happen, but the field is nullable defensively). Only the caller's own conversations are ever returned — scoped by `userId`, same as everything else in this API.

---

## 7. GET /assistant/conversations/{id}/messages

**Flow:** Called when the user taps into a conversation from the history list — returns the full transcript in chronological order so the chat UI can render it exactly as it originally happened, including which intent/confidence each of Duey's replies resolved to (useful if you ever build an internal debug view, not just the end-user chat).

**Response `200`**
```json
{
  "success": true,
  "data": {
    "conversationId": "cnv_9f2k3a1x",
    "messages": [
      { "id": "msg_1", "role": "user", "content": "pay my handout fee", "intent": null, "confidence": null, "createdAt": "2026-07-17T10:00:00.000Z" },
      { "id": "msg_2", "role": "assistant", "content": "Ready to pay \"Handout Fee\" (₦5,150.00) to Economics Student Association? Tap below to continue.", "intent": "pay_dues", "confidence": 0.7, "createdAt": "2026-07-17T10:00:01.000Z" }
    ]
  }
}
```
`intent`/`confidence` are only ever populated on `role: "assistant"` rows (the classification that produced that reply) — always `null` on `role: "user"` rows. `404` if the conversation doesn't exist or doesn't belong to the caller.
