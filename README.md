# WhatsApp AI bot (personal project — not part of the website)

A standalone, always-on WhatsApp auto-replier. Uses GreenAPI (your personal
WhatsApp number stays on their cloud) and Google Gemini (free tier) to answer
messages for you. Completely independent of the car trimmers website.

## How it works

1. Polls GreenAPI for new incoming messages.
2. Sends the message (plus recent history for that contact) to Gemini.
3. Sends Gemini's reply back to the contact on WhatsApp.
4. Stores per-contact conversation history in `data/conversations.json`.

## Setup

1. **GreenAPI** — create an account at https://green-api.com, add your WhatsApp
   number, and copy the `idInstance` and `apiTokenInstance` from your cabinet.
2. **Gemini key** — get a free API key at https://aistudio.google.com/app/apikey.
3. Create `.env` from `.env.example` and fill in the values.
4. Run locally:
   ```
   python -m venv venv
   venv\Scripts\activate        # Windows
   pip install -r requirements.txt
   python bot.py
   ```

## Always-on in the cloud, FREE (recommended) — Cloudflare Workers

No credit card, no sleeping server, never expires (free tier = 100k
requests/day). The bot runs as a serverless webhook: it only wakes up when a
WhatsApp message arrives, asks Gemini, replies, and remembers the conversation
in Workers KV. Everything lives in `worker.js`.

1. Create a free Cloudflare account at https://dash.cloudflare.com (no card).
2. **Workers & Pages → Create → Worker** → delete the starter code and paste
   the contents of `worker.js` → **Save and Deploy**.
3. **Settings → Variables**:
   - Add `GREEN_ID` and `GREEN_TOKEN` (from GreenAPI) — mark as secrets.
   - Add `GEMINI_KEY` (your AQ./AIza key) as a secret.
   - (Optional) `GEMINI_MODEL` = `gemini-flash-latest`, `PERSONA` = your prompt.
   - (Optional) `WEBHOOK_SECRET` = a password you invent.
4. **Settings → KV bindings → Create namespace** named `CHAT_RECORDS`; bind it
   to variable `CHAT_RECORDS`. This stores conversation history.
5. Copy your Worker URL, e.g. `https://whatsapp-bot.you.workers.dev`.
6. On GreenAPI → your instance → **Webhook URL**, set it to
   `https://whatsapp-bot.you.workers.dev/?secret=YOUR_SECRET` (omit `?secret=`
   if you didn't add `WEBHOOK_SECRET`).
7. Message your WhatsApp number from another phone — the AI should reply.

Your free quota handles roughly 100k messages/day, far beyond personal use.

## Alt: run it yourself as a container (Docker)

A `Dockerfile` is included. Build and run, setting `DATA_DIR` to a persistent
volume so conversation history survives restarts. Example:

```
docker build -t whatsapp-ai-bot .
docker run -d --env-file .env -v whatsbot_data:/data whatsapp-ai-bot
```

Or locally without Docker: `python bot.py` (see Setup above).

Keep `data/conversations.json` in git out (it contains chat history) — add a
`.gitignore` with `.env` and `data/` if you commit this to GitHub.

## Notes

- Using your personal WhatsApp number with third-party bridges like GreenAPI
  violates WhatsApp's terms and carries a ban risk. You chose this route.
- The AI persona is fully configurable via `AI_PERSONA` in `.env`.