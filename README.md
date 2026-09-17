# WhatsApp AI bot — human-like auto-replies using YOUR own local AI

A personal, always-on WhatsApp auto-replier that answers your messages as if a real
human is texting. It runs on **your machine, your own model** — no monthly fees, no
message limits, no third-party chat services, no business verification.

```
WhatsApp (your number)  ->  bridge/bridge.js (Baileys QR session)
                         ->  chigos-ai local AI (llama)  ->  humanized reply back
```

## The journey (why the repo looks the way it does)

This project went through three approaches. The current one is the winner.

1. **GreenAPI + Gemini** (`bot.py`, oldest) — a third-party WhatsApp service
   (session-based, cloud). Abandoned: provider-imposed limits (trial caps,
   throttling, paid tiers).
2. **Meta WhatsApp Cloud API** (`worker.js`, `wrangler.toml`) — Meta's official API
   via a free Cloudflare Worker. Abandoned: it legally requires a **registered
   business** + business verification. For a personal number with no business, it is
   a dead end. Worker is still deployed at `wa-bot.saintchigos.workers.dev` but is
   deprecated.
3. **Own bridge + local llama (current)** — see below.

## Current recommended path: `bridge/`

`bridge/bridge.js` is a self-hosted WhatsApp client (Baileys) that links your
existing WhatsApp number the same way WhatsApp Web does — by **scanning a QR code**
once. No third party is in the loop: messages go straight to your local AI and the
reply goes straight back to WhatsApp.

### Why it feels human

- Types before replying (WhatsApp "typing…" indicator is shown)
- Natural thinking + typing delay (no instant robot responses)
- Long replies are sent in natural short chunks, like a real texter
- Human persona prompt (casual, warm, matches the sender's language, never
  reveals it is a bot)

### How it works

1. Baileys connects to your WhatsApp number (QR link, saved session).
2. Each incoming message is skipped unless it's a normal text/caption chat
   (groups and groups-ignore are off by default).
3. The message is sent to the brain:
   - **chigos-ai agent server** (`http://localhost:8000`) if it's running — full
     agents + memory + tools, or
   - the **raw local llama** (`http://localhost:8080/v1`, OpenAI-compatible) as a
     fallback — e.g. chigos-ai's `local_server.py` / llama-cpp-python.
4. The reply is humanized and sent back; per-contact history is kept.

### Run it

```bat
cd bridge
npm install
node bridge.js
```

Then on your phone: **WhatsApp → Settings → Linked devices → Link a device** and
scan the QR printed in the terminal. Keep the terminal window open — while it's
running, messages get answered.

> The local model must also be running. Minimum: the llama server on
> `http://127.0.0.1:8080/v1` (e.g. from chigos-ai: `python local_server.py`).
> For the full chigos-ai agents instead of the raw model, also run chigos-ai's
> server so `http://localhost:8000/api/status` responds.

### Configuration (`bridge/.env`, copy from `.env.example`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHIGOS_API_URL` | `http://127.0.0.1:8000` | chigos-ai agent server (used when reachable) |
| `CHIGOS_MASTER_CODE` | `@T16i11n20k06` | master code for chigos-ai `/api/auth` |
| `LLAMA_URL` | `http://127.0.0.1:8080/v1` | raw local llama fallback brain |
| `BOT_PERSONA` | (built-in) | the "human" personality prompt |
| `IGNORE_GROUPS` | `true` | don't auto-reply in group chats |
| `MAX_HISTORY` | `12` | how many past turns the brain sees |
| `SESSION_DIR` | `bridge/session` | where the WhatsApp QR session is saved |

## Alternatives still in the repo

### `bot.py` — GreenAPI client (path #1)

Python bot that polls **GreenAPI** notifications and replies. It has been re-wired
to use the local llama instead of Gemini (`LLAMA_SERVER` / `LOCAL_MODEL` in `.env`),
so it can serve as a plain local-AI test harness. Not the recommended path — it
needs a GreenAPI instance and still hits third-party limits.

### `worker.js` — Meta Cloud API (path #2)

Cloudflare Worker that receives Meta WhatsApp webhooks and replies via the Graph
API. Fully built and the webhook verification works, **but it is unusable without
a business registered with Meta**, so it's deprecated. Kept for reference.

## Notes

- The QR link is a "linked device" on your own WhatsApp account — your number stays
  yours, and nothing is hosted on any third party.
- Personal-use self-hosting: understand that running an unofficial WhatsApp client
  is against WhatsApp's terms and carries a risk of your number being flagged. Use
  with a number you can afford to lose. (This is also exactly why the official Meta
  API exists — but that needs a real business.)
- No secrets live in this repo. Real credentials go in your local `.env` / Cloudflare
  secrets / `bridge/session`.