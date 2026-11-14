# WhatsApp bot

Exposes the AI assistant (`docs/AI.md`) over WhatsApp, so a rep can create a
collection, see who hasn't paid, check the balance and withdraw — all from chat
(checklist: "A representative can create a collection on WhatsApp and must
confirm the summary before it is saved").

Code: `src/channels/whatsapp/` — `baileys.ts` (the socket, behind a
`MessagingChannel` interface) and `handler.ts` (inbound message → account link
or agent). Started from `src/server.ts` when `WHATSAPP_ENABLED=true`.

## Transport: Baileys (unofficial)

Baileys connects as a WhatsApp Web client over WebSocket (no browser). It is an
**unofficial** library: automated use can violate WhatsApp's ToS and risks a
ban. Fine for a hackathon demo number — do **not** use a personal or important
number, and for production move to the official **WhatsApp Cloud API** (the
`MessagingChannel` interface is there so only `baileys.ts` is replaced).

## Enable

```
AI_ENABLED=true            # the bot needs the assistant
WHATSAPP_ENABLED=true
WHATSAPP_AUTH_DIR=./.whatsapp-auth   # keep out of git; persists the session
NVIDIA_API_KEY=...         # see docs/AI.md
```

On first start a **QR code is printed to the server logs**. Open WhatsApp on the
demo phone → Linked devices → Link a device → scan it. The session is saved under
`WHATSAPP_AUTH_DIR`, so you only scan once. (If it logs out, delete that folder
and restart to re-link.)

## Linking a rep's number

A WhatsApp number must be bound to a Duevy account before it can act:

1. Rep signs in to the dashboard → `POST /v1/ai/link/whatsapp` → a 6-digit code.
2. Rep messages the bot: `link 123456`.
3. The bot binds the number to their account (`users.whatsappNumber`). Done once.

An unlinked number gets instructions automatically. One number → one account.

## Notes

- Groups, status and broadcasts are ignored; direct chats only.
- Conversation state is shared with the web chat (per-rep, in-memory).
- The bot runs in the API process alongside the workers (`RUN_WORKERS`). Give it
  a persistent `WHATSAPP_AUTH_DIR` on a volume so restarts don't need re-linking.
