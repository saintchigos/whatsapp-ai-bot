/**
 * WhatsApp AI auto-replier (Cloudflare Worker — free, always-on).
 *
 * Receives webhooks from GreenAPI when a WhatsApp message arrives, asks
 * Gemini for a reply, sends it back via GreenAPI, and remembers each
 * conversation in Workers KV.
 *
 * Environment variables (set in the Workers dashboard, not in this file):
 *   GREEN_ID      - GreenAPI idInstance
 *   GREEN_TOKEN   - GreenAPI apiTokenInstance
 *   GEMINI_KEY    - Gemini API key (AQ... or AIza... format)
 *   GEMINI_MODEL  - optional, default "gemini-flash-latest"
 *   PERSONA       - optional system prompt for the AI
 *   WEBHOOK_SECRET- optional shared secret; if set, the webhook must include
 *                   it as ?secret=... in the URL configured on GreenAPI.
 *
 * KV binding: CHAT_RECORDS
 */

const PERSONA_DEFAULT =
  "You are a friendly personal assistant who replies to WhatsApp messages " +
  "on behalf of the owner. Be warm, natural and concise (keep replies under " +
  "150 words). Chat in the same language you are written in. If you cannot " +
  "answer something, say so plainly and offer to pass it to the owner.";

const MAX_HISTORY = 20;

function buildPrompt(persona, history) {
  const lines = [persona, ""];
  for (const turn of history) {
    const who = turn.role === "user" ? "Human" : "Assistant";
    lines.push(`${who}: ${turn.text}`);
  }
  lines.push("Assistant:");
  return lines.join("\n");
}

async function askGemini(prompt, key, model) {
  const mdl = model || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  try {
    const text = data.candidates[0].content.parts[0].text.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function sendGreenApi(chatId, message, id, token) {
  const url = `https://api.green-api.com/waInstance${id}/SendMessage/${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message }),
  });
  return resp.status === 200;
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("whatsapp-ai-bot is alive", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (env.WEBHOOK_SECRET && url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const body = payload.body || {};
    if (body.typeWebhook !== "incomingMessageReceived") {
      return new Response("ok");
    }

    const chatId = (body.senderData || {}).chatId;
    const messageData = body.messageData || {};
    if (
      !chatId ||
      chatId.endsWith("@g.us") ||
      messageData.typeMessage !== "textMessage"
    ) {
      return new Response("ok");
    }
    const text = ((messageData.textMessageData || {}).textMessage || "").trim();
    if (!text) {
      return new Response("ok");
    }

    const key = "chat:" + chatId;
    let history = [];
    try {
      history = JSON.parse((await env.CHAT_RECORDS.get(key)) || "[]");
    } catch {
      history = [];
    }
    if (!Array.isArray(history)) history = [];

    history.push({ role: "user", text });
    history = history.slice(-MAX_HISTORY);

    const persona = env.PERSONA || PERSONA_DEFAULT;
    const reply = await askGemini(buildPrompt(persona, history), env.GEMINI_KEY, env.GEMINI_MODEL);
    if (reply) {
      await sendGreenApi(chatId, reply, env.GREEN_ID, env.GREEN_TOKEN);
      history.push({ role: "assistant", text: reply });
      history = history.slice(-MAX_HISTORY);
    }

    await env.CHAT_RECORDS.put(key, JSON.stringify(history));
    return new Response("ok");
  },
};