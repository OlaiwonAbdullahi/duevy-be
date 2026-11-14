# AI assistant

A chat assistant that lets a rep do **everything they can do on the dashboard**
in natural language — on the web and over WhatsApp. Built on **NVIDIA NIM**
(`nvidia/nemotron-3.5-super-vl-120b-a12b`, OpenAI-compatible — `meta/llama-3.3-70b-instruct`
was retired by NVIDIA on 2026-08-26). Any current tool-calling model on
build.nvidia.com works; set `AI_MODEL`.

Code: `src/ai/` — `nim.ts` (client), `identity.ts` (who the rep is + token +
WhatsApp linking), `api.ts` (internal REST client), `tools.ts` (the rep's
actions as tools), `agent.ts` (the loop). HTTP surface: `src/routes/ai.ts`.

## Key design: tools are thin wrappers over the REST API

Each tool calls Duevy's **own public REST API**, server-side, carrying a
short-lived JWT minted for the linked rep. So every action goes through the same
auth (`requireSpaceRep`), zod validation, KYC gates, idempotency and
confirmation logic as the dashboard. The chat can never do more than the rep
could in the UI, and the dashboard keeps working if chat is down.

## Confirmation gate

Anything that creates, moves money or is destructive takes a `confirmed` flag.
Called without it, the tool does **not** act — it returns a summary and asks the
agent to confirm with the rep first (checklist: "the rep must confirm the summary
before it is saved"). Withdrawals also require the rep's 4-digit PIN. This is
enforced in the tool, not left to the model.

## What it can do

Dues (list/create/edit/publish/close/delete/remind, pay links), reporting
("who hasn't paid?", "how much have we collected?", collection rosters, space
overview), payouts (summary, quote, request + beneficiaries, lookup, banks),
team (members/reps, add co-rep), KYC status, space settings. See the tool list
in `src/ai/tools.ts`.

## Enable

```
AI_ENABLED=true
NVIDIA_API_KEY=nvapi-...          # from build.nvidia.com
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
AI_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
```

## Endpoints (authenticated)

- `POST /v1/ai/chat` `{ "message": "..." }` → `{ "reply": "..." }`
- `POST /v1/ai/reset` — clear the conversation context
- `POST /v1/ai/link/whatsapp` → a one-time code to link a WhatsApp number

Example:

```
curl -X POST https://<api>/v1/ai/chat \
  -H "Authorization: Bearer <rep access token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"create a ₦2000 departmental due for this week"}'
```

## Notes & limits

- Conversation state is per-rep and in-memory (single-instance demo scope). Move
  it to Redis for multi-instance.
- The agent calls the API over loopback (`INTERNAL_API_BASE_URL`, default this
  process); those calls share the server's IP for rate limiting.
- If a rep leads several spaces, the agent asks which one, then pins it for the
  conversation (`set_active_space`).
