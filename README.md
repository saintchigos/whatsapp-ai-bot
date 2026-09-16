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

## Always-on in the cloud (Docker)

A `Dockerfile` is included. Build and run, setting `DATA_DIR` to a persistent
volume so conversation history survives restarts. Example:

```
docker build -t whatsapp-ai-bot .
docker run -d --env-file .env -v whatsbot_data:/data whatsapp-ai-bot
```

Keep `data/conversations.json` in git out (it contains chat history) — add a
`.gitignore` with `.env` and `data/` if you commit this to GitHub.

## Notes

- Using your personal WhatsApp number with third-party bridges like GreenAPI
  violates WhatsApp's terms and carries a ban risk. You chose this route.
- The AI persona is fully configurable via `AI_PERSONA` in `.env`.