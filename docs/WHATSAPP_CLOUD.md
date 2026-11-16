# WhatsApp via Meta Cloud API (official)

The official, ToS-compliant transport for the Duevy bot. Inbound messages arrive
as webhooks; replies go out via the Graph API. No socket, no QR, no ban risk
(unlike Baileys). The agent is unchanged — a text message or a transcribed voice
note flows into the same `handleWhatsappMessage`.

Switch transports with `WHATSAPP_PROVIDER` (`baileys` | `cloud`).

## 1. Fill the env (`.env`)

```
WHATSAPP_ENABLED=true
WHATSAPP_PROVIDER=cloud
WHATSAPP_PHONE_NUMBER_ID=      # API Setup page — 15-digit, NOT the display number
WHATSAPP_BUSINESS_ACCOUNT_ID=  # WABA ID (optional)
WHATSAPP_ACCESS_TOKEN=         # System User token (long-lived)
WHATSAPP_VERIFY_TOKEN=         # any random string you choose
WHATSAPP_APP_SECRET=           # App Settings → Basic → App Secret
WHATSAPP_GRAPH_VERSION=v23.0
```

Where each comes from:
- **Phone Number ID / WABA ID / a temp token:** developers.facebook.com → your app → **WhatsApp → API Setup**.
- **Long-lived token:** business.facebook.com → **Business Settings → Users → System Users** → add a system user → **Generate token** with `whatsapp_business_messaging` + `whatsapp_business_management` → **Assign assets** (the app, the WABA, and the phone number). Set it to not expire.
- **App Secret:** developers.facebook.com → your app → **App Settings → Basic**.
- **Verify token:** you make it up (any string). It only has to match what you enter in the Meta dashboard.

## 2. Expose the webhook

The backend serves:
- `GET  /v1/webhooks/whatsapp` — Meta's subscription handshake.
- `POST /v1/webhooks/whatsapp` — inbound messages (signature-verified).

Locally, tunnel it so Meta can reach you:

```bash
ngrok http 4000           # or: cloudflared tunnel --url http://localhost:4000
```

## 3. Register it in Meta

In your app → **WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL:** `https://<your-tunnel>/v1/webhooks/whatsapp`
- **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save** (this hits the GET handshake).
- Under **Webhook fields**, **subscribe to `messages`**.

## 4. Test

Message your Meta number from a phone that's added as a **test recipient** (API
Setup page, up to 5 in sandbox). Duey replies. Voice notes work too if the STT
sidecar is running and `STT_ENABLED=true` (see [VOICE.md](VOICE.md)).

## Gotchas

- **24-hour window:** free-form replies are allowed only within 24h of the rep's
  last message. Reactive chat is always fine (the rep messages first); proactive
  pushes need approved **message templates**.
- **Sandbox cap:** before business verification you can only message up to 5
  verified test numbers.
- **Phone Number ID ≠ the visible number**, and it ≠ the WABA ID (using the WABA
  ID returns Graph error 100).
- **One business:** the app and the WABA must sit under the same Meta Business,
  or the token can't access the number.
