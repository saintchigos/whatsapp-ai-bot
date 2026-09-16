/**
 * WhatsApp AI auto-replier (Cloudflare Worker — free, always-on).
 *
 * Receives webhooks from GreenAPI when a WhatsApp message arrives, asks
 * Gemini for a reply (with Cloudflare's free Workers AI as backup brain),
 * sends it back via GreenAPI, and remembers each conversation in Workers KV.
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
 * Bindings:
 *   CHAT_RECORDS  - KV namespace (conversation history)
 *   AI            - Workers AI binding (free backup brain)
 */

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

const CLAUDE_HOLD = "haha sorry, my phone froze, one sec lol";

const MAX_HISTORY = 20;
const SWEEP_LIMIT = 30;

function buildPrompt(persona, history) {
  const lines = [persona, ""];
  for (const turn of history) {
    const who = turn.role === "user" ? "Human" : "Assistant";
    lines.push(`${who}: ${turn.text}`);
  }
  lines.push("Assistant:");
  return lines.join("\n");
}

function retrySeconds(resp, errText) {
  const h = resp.headers.get("retry-after");
  if (h && /^[0-9.]+$/.test(h)) return Math.min(parseFloat(h), 4);
  const m = errText.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s?/i);
  if (m) return Math.min(parseFloat(m[1]), 4);
  return 1;
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

  let waited = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (waited > 15) {
      console.log("GEMINI_TIMEOUT wait budget");
      return null;
    }
    const resp = await fetch(url, options);
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
      const errText = await resp.text().catch(() => "");
      if (attempt < 3) {
        const wait = retrySeconds(resp, errText);
        waited += wait;
        console.log("GEMINI_RETRY", resp.status, "wait", wait, "attempt", attempt + 1);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
    }
    const errText = (await resp.text().catch(() => "")).slice(0, 200);
    console.log("GEMINI_FAIL", resp.status, errText);
    return null;
  }
  return null;
}

async function askCloudflare(prompt, env) {
  try {
    if (!env.AI) throw new Error("no AI binding");
    const ai = env.AI;
    const persona = env.PERSONA || PERSONA_DEFAULT;
    const out = await ai.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [
        { role: "system", content: persona },
        { role: "user", content: prompt },
      ],
      max_tokens: 256,
      temperature: 0.7,
    });
    const text = (out && (out.response || "")) || "";
    const trimmed = text.trim();
    if (!trimmed) {
      console.log("CF_EMPTY");
      return null;
    }
    console.log("CF_REPLY yes");
    return trimmed;
  } catch (err) {
    console.log("CF_FAIL", String(err));
    return null;
  }
}

async function replyChain(prompt, env) {
  const gemini = await askGemini(prompt, env.GEMINI_KEY, env.GEMINI_MODEL);
  if (gemini) return { text: gemini, brain: "gemini" };
  const cf = await askCloudflare(prompt, env);
  if (cf) return { text: cf, brain: "cloudflare" };
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

function loadHistory(raw) {
  try {
    const h = JSON.parse(raw || "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

async function sweepUnreplied(env, persona) {
  let scanned = 0;
  let cursor;
  let found = 0;
  while (scanned < SWEEP_LIMIT) {
    const page = await env.CHAT_RECORDS.list({ limit: 100, cursor });
    for (const k of page.keys || []) {
      if (scanned++ >= SWEEP_LIMIT) break;
      if (!k.name.startsWith("chat:")) continue;
      const history = loadHistory(await env.CHAT_RECORDS.get(k.name));
      if (!history.length) continue;
      const last = history[history.length - 1];
      if (last.role !== "user") continue;
      found++;
      const chatId = k.name.slice(5);
      const result = await replyChain(buildPrompt(persona, history), env);
      if (!result) {
        console.log("SWEEP_SKIP", chatId, "still busy");
        continue;
      }
      const sent = await sendGreenApi(chatId, result.text, env.GREEN_ID, env.GREEN_TOKEN);
      console.log("SWEEP_REPLY", chatId, result.brain, sent);
      if (sent) {
        history.push({ role: "assistant", text: result.text, ts: Date.now() });
        await env.CHAT_RECORDS.put(k.name, JSON.stringify(history.slice(-MAX_HISTORY)));
      }
    }
    if (page.list_complete && !page.cursor) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  console.log("SWEEP_DONE scanned", scanned, "unreplied", found);
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

    const persona = env.PERSONA || PERSONA_DEFAULT;
    const key = "chat:" + chatId;
    let history = loadHistory(await env.CHAT_RECORDS.get(key));

    const cachedReply = cachedGreeting(text);
    if (cachedReply) {
      console.log("CACHED_REPLY", cachedReply);
      await sendGreenApi(chatId, cachedReply, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: cachedReply, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    } else {
      history.push({ role: "user", text, ts: Date.now() });
      const result = await replyChain(buildPrompt(persona, history), env);
      if (result) {
        console.log("REPLY", result.brain);
        const sent = await sendGreenApi(chatId, result.text, env.GREEN_ID, env.GREEN_TOKEN);
        if (sent) {
          history.push({ role: "assistant", text: result.text, ts: Date.now() });
        }
      } else {
        console.log("FULL_CHAIN_FAIL");
        await sendGreenApi(chatId, CLAUDE_HOLD, env.GREEN_ID, env.GREEN_TOKEN);
      }
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    }

    try {
      await sweepUnreplied(env, persona);
    } catch (err) {
      console.log("SWEEP_ERR", String(err));
    }

    return new Response("ok");
  },
};

function cachedGreeting(text) {
  const clean = text.replace(/[!?.…,]+$/g, "").trim();
  if (/^(hello|hi|hey|sup|yo|hola|good\s*(morning|afternoon|evening|day)|how\s*are\s*you|how\s*r\s*u|hru|nm\s*u|whats\s*up|wassup|waddup|greetings|howdy|heya|wha\s*up)$/i.test(clean))
    return ["hey! what's up", "yo how's it going", "hi there", "hey, all good here", "sup! what's good", "heya, how you doing", "yo what's happening"][Math.floor(Math.random() * 7)];
  if (/^(dumela|dumelang|salibonani|ua\s*phela|le\s*kae|utimeile|kha\s*tsebe|hae\s*bele|njani|njani\s*na|kunjani|sawubona|unjani|ukhona\s*na|molo|ehleng)$/i.test(clean))
    return ["eh, ke teng, u phela jwang?", "dumela! u kae?", "njani na, ke teng", "le kae? ke thabile", "hae bele! u pileng", "tjena, ke peng hantle"][Math.floor(Math.random() * 6)];
  if (/^(mhoroi|mangwanani|masikati|makorokoto|moro|mhoro|uri\s*zvipi|zvinjani|sezvo|makadii|mhoro\s*we|hey\s*we|mhlosho|siripo|siripho|uri\s*po|wauya|wakadii|yako)$/i.test(clean))
    return ["mhoro! uri zvipi?", "makadii, ndiri po", "mhoro we, zvinjani", "mhoro, ndini", "uri po? ndiri zvakanaka", "hey we, zvinjani"][Math.floor(Math.random() * 6)];
  return null;
}