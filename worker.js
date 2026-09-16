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

const GREETINGS_EN =
  /^(hello|hi|hey|sup|yo|hola|good\s*(morning|afternoon|evening|day)|how\s*are\s*you|how\s*r\s*u|hru|nm\s*u|whats\s*up|wassup|waddup|dreetings|greetings|howdy|heya|wha\s*up)$/i;
const GREETINGS_ST =
  /^(dumela|dumelang|salibonani|ua\s*phela|le\s*kae|utimeile|kha\s*tsebe|hae\s*bele|njani|njani\s*na|kunjani|sawubona|unjani|ukhona\s*na|molo|ehleng|ehleng)$/i;
const GREETINGS_SH =
  /^(mhoroi|mangwanani|masikati|makorokoto|moro|mhoro|uri\s*zvipi|zvinjani|sezvo|makadii|mhoro\s*we|hey\s*we|mhlosho|siripo|siripho|uri\s*po|wauya|wakadii|yako)$/i;

const GREETING_REPLIES_EN = [
  "hey! what's up", "yo how's it going", "hi there", "hey, all good here",
  "sup! what's good", "heya, how you doing", "yo what's happening",
];
const GREETING_REPLIES_ST = [
  "eh, ke teng, u phela jwang?", "dumela! u kae?", "njani na, ke teng",
  "le kae? ke thabile", "hae bele! u pileng", "tjena, ke peng hantle",
];
const GREETING_REPLIES_SH = [
  "mhoro! uri zvipi?", "makadii, ndiri po", "mhoro we, zvinjani",
  "mhoro, ndini", "uri po? ndiri zvakanaka", "hey we, zvinjani",
];

function pickGreeting(text) {
  const clean = text.replace(/[!?.…,]+$/g, "").trim();
  if (GREETINGS_EN.test(clean)) return GREETING_REPLIES_EN[Math.floor(Math.random() * GREETING_REPLIES_EN.length)];
  if (GREETINGS_ST.test(clean)) return GREETING_REPLIES_ST[Math.floor(Math.random() * GREETING_REPLIES_ST.length)];
  if (GREETINGS_SH.test(clean)) return GREETING_REPLIES_SH[Math.floor(Math.random() * GREETING_REPLIES_SH.length)];
  return null;
}
  const PERSONA_DEFAULT =
  "Your name is Tino. You are replying to WhatsApp messages for yourself — " +
  "you ARE Tino, not an assistant. Text exactly like Tino: pretty normal, " +
  "casual, short messages, no robot phrasing.\n" +
  "- Your humor is dark and dry: you drop sarcastic, slightly morbid jokes " +
  "with people you trust, but you stay friendly and never mean-spirited. " +
  "You laugh at life's small misfortunes (e.g. 'lol another day of " +
  "suffering'). Keep dark humor light, not depressing.\n" +
  "- You care a lot about how people see you, so you keep a cool, smart, " +
  "confident tone and don't overshare or beg for attention. You value " +
  "yourself and your time.\n" +
  "- You're sharp and proud of how smart you are: quick with clever replies, " +
  "comfortable talking about ideas, science, tech or money.\n" +
  "- You have strong faith in God; mention it naturally when the topic is " +
  "about hope, struggle, plans or tough times.\n" +
  "- You love your laptop and gadgets and happily nerd out about devices, " +
  "phones and tech problems.\n" +
  "- Speak the language the person writes back in: English, Sesotho or " +
  "Shona — match their language.\n" +
  "- Keep replies to 1-2 sentences, normal texting style (lol, sike, nah, " +
  "ok that's crazy, let me think...), relaxed and confident. Sometimes ask " +
  "a question back so the chat flows.\n" +
  "- Never say you are an AI, a bot or an assistant. Never be formal, " +
  "preachy or overly helpful. If you don't know something just say you're " +
  "not sure. Sound like a real friend, not a business.";

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
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
    }),
  };

  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    const resp = await fetch(url, options);
    lastStatus = resp.status;

    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      try {
        const text = data.candidates[0].content.parts[0].text.trim();
        return text || null;
      } catch {
        return null;
      }
    }

    if (resp.status === 429 || resp.status === 503) {
      if (attempt < 3) {
        console.log("GEMINI_RETRY", resp.status, "attempt", attempt + 1);
        continue;
      }
    }
    const errText = await resp.text().catch(() => "");
    console.log("GEMINI_FAIL", resp.status, errText.slice(0, 200));
    return null;
  }
  console.log("GEMINI_FAIL", lastStatus, "after retries");
  return null;
}

async function sendGreenApi(chatId, message, id, token) {
  const url = `https://api.green-api.com/waInstance${id}/SendMessage/${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message }),
  });
  if (resp.status !== 200) {
    const errText = await resp.text().catch(() => "");
    console.log("SEND_FAIL", resp.status, errText.slice(0, 200));
  }
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

    const body =
      payload.body && typeof payload.body === "object" ? payload.body : payload;
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
    console.log("INCOMING", chatId, "-", text);

    const cachedReply = pickGreeting(text);
    if (cachedReply) {
      console.log("CACHED_REPLY", cachedReply);
      await sendGreenApi(chatId, cachedReply, env.GREEN_ID, env.GREEN_TOKEN);
      const key = "chat:" + chatId;
      let history = [];
      try { history = JSON.parse((await env.CHAT_RECORDS.get(key)) || "[]"); } catch { history = []; }
      if (!Array.isArray(history)) history = [];
      history.push({ role: "user", text }, { role: "assistant", text: cachedReply });
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    try {
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
      const reply = await askGemini(
        buildPrompt(persona, history),
        env.GEMINI_KEY,
        env.GEMINI_MODEL,
      );
      console.log("GEMINI_REPLY", reply ? "yes" : "no");
      if (reply) {
        const sent = await sendGreenApi(chatId, reply, env.GREEN_ID, env.GREEN_TOKEN);
        console.log("SEND_OK", sent);
        if (sent) {
          history.push({ role: "assistant", text: reply });
          history = history.slice(-MAX_HISTORY);
        }
      }

      await env.CHAT_RECORDS.put(key, JSON.stringify(history));
    } catch (err) {
      console.log("WORKER_ERR", String(err));
    }
    return new Response("ok");
  },
};