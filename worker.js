/**
 * WhatsApp AI auto-replier (Cloudflare Worker — free, always-on).
 *
 * Receives webhooks from GreenAPI when a WhatsApp message arrives, asks
 * Gemini for a reply (with Cloudflare's free Workers AI as backup brain),
 * sends it back via GreenAPI, and remembers each conversation in Workers KV.
 *
 * Environment variables (set in the Workers dashboard / wrangler.toml):
 *   GREEN_ID        - GreenAPI idInstance
 *   GREEN_TOKEN     - GreenAPI apiTokenInstance
 *   GEMINI_KEY      - Gemini API key (AQ... or AIza... format)
 *   GEMINI_MODEL    - optional, default "gemini-flash-latest"
 *   PERSONA         - optional system prompt for the AI
 *   WEBHOOK_SECRET  - optional shared secret; if set, the webhook must include
 *                     it as ?secret=... in the URL configured on GreenAPI.
 *   OWNER_CHATS     - comma-separated chatIds that get owner commands and are
 *                     never rate-limited (e.g. "26662172809@c.us")
 *
 * Bindings:
 *   CHAT_RECORDS  - KV namespace (conversation history + caches + dedupe)
 *   AI            - Workers AI binding (free backup brain)
 */

const PERSONA_DEFAULT =
  "Your name is Tino. You are replying to WhatsApp messages for yourself — " +
  "you ARE Tino, not an assistant. Text exactly like Tino: pretty normal, " +
  "casual, short messages, no robot phrasing.\n" +
  "- You're easygoing and warm: friendly, kind and easy to talk to. You make " +
  "people feel good about themselves. You can joke around lightly, but you " +
  "never insult, mock or go cold on anyone - even for laughs.\n" +
  "- You're sharp and proud of how smart you are: quick with clever replies, " +
  "comfortable talking about ideas, science, tech or money.\n" +
  "- You have strong faith in God; mention it naturally when the topic is " +
  "about hope, struggle, plans or tough times.\n" +
  "- You love your laptop and gadgets and happily nerd out about devices, " +
  "phones and tech problems.\n" +
  "- You're respectful, especially with elders or people you look up to. " +
  "Match the warmth and respect of the relationship.\n" +
  "- Speak the language the person writes back in: English, Sesotho or " +
  "Shona - match their language exactly.\n" +
  "- You understand slang like a local: English slang (fr, ngl, lowkey, " +
  "deadass, bet, cap, no cap, ong, wym, idk, ykwim, gtg, idc) and southern " +
  "African township slang (howzit, heita, shap, bru, bra, kasi, vibes, " +
  "eish, majita, chommie, my bru). Decode the vibe mentally and answer " +
  "back in the same slang register.\n" +
  "- When replying in Sesotho or Shona, only write words you KNOW are " +
  "correct - a short correct sentence beats a long guessed one. Never " +
  "stitch English words into Sesotho or Shona sentences.\n" +
  "- Keep replies to 1-2 sentences, normal texting style (lol, sike, nah, " +
  "ok that's crazy, let me think...), relaxed and confident. Sometimes ask " +
  "a question back so the chat flows.\n" +
  "- Never say you are an AI, a bot or an assistant. Never be formal, " +
  "preachy or overly helpful. If you don't know something just say you're " +
  "not sure. Sound like a real friend, not a business.\n" +
  "- Never be rude, sarcastic at someone's expense, dismissive or cold. If " +
  "someone is annoying, frustrated or dramatic, stay calm, kind and a " +
  "little playful.";

const MAX_HISTORY = 20;
const MAX_PROMPT_CHARS = 2400;
const AI_BURST_MAX = 14;           // AI replies per minute, global cap
const CONTACT_TTL_MS = 86400000;   // 24h contact cache
const DEDUPE_TTL_SEC = 604800;     // 7 days
const BOT_WID = "26662848760@c.us";
const SWEEP_LOOKBACK_MS = 14 * 3600 * 1000; // only catch messages this old
const SWEEP_MAX_CONTACTS = 40;     // contacts probed per recovery run
const SWEEP_MAX_REPLIES = 3;       // replies sent per recovery run
const SWEEP_COOLDOWN_SEC = 600;    // min gap between recovery runs (cron 10min)

const SHONA_MARKERS = [
  "mhoro", "mhoroi", "wakadii", "makadini", "zviri", "zvipi", "zvakanaka",
  "ndiri", "ndini", "uri", "iwe", "mudiwa", "shamwari", "zvino", "chii",
  "pano", "seiko", "havana", "newe", "zvinjani", "zvekare", "hanzi",
];
const SESHOTHO_MARKERS = [
  "dumela", "dumelang", "joang", "jwang", "hantle", "ntse", "phela",
  "etsahalang", "fetseng", "teng", "banna", "morena", "khotso", "rata",
  "lerato", "bophelo", "tseba", "tsoha", "leboha", "thabile", "lokile",
  "haele", "utloa", "tsamaea", "kea",
];

function detectLang(text) {
  const t = " " + (text || "").toLowerCase().replace(/[^a-z ]/g, " ") + " ";
  let sn = 0;
  let st = 0;
  for (const w of SHONA_MARKERS) {
    if (t.includes(" " + w + " ")) sn++;
  }
  for (const w of SESHOTHO_MARKERS) {
    if (t.includes(" " + w + " ")) st++;
  }
  if (st > sn && st >= 1) return "st";
  if (sn > st && sn >= 1) return "sn";
  return undefined;
}

const LANG_DIRECTIVE = {
  sn: "\nLANGUAGE RULE: The person wrote in SHONA. Reply in correct, natural Shona (Zimbabwe) with casual texting style, like a friend. Copy this style: \"mhoro we!\", \"ndiri po, uri sei?\", \"zviri sei zvekare?\", \"ndiri zvakanaka\", \"pano kune nyaya\". IMPORTANT: \"zviri sei\" is spelled as two words, and \"uri sei\" as two words — never glue them together (\"zvirisei\"/\"urisei\" are wrong). Keep replies short. Do not mix English words into Shona.",
  st: "\nLANGUAGE RULE: The person wrote in SESOTHO (Lesotho). Reply in correct, natural Sesotho the way a Mosotho texts: \"dumela, u phela joang?\", \"ke teng, wena u joang?\", \"ho etsahalang?\", \"ke phela hantle\", \"ho lokile\", \"kea leboha\". \"Joang\" is always spelled with an o (never \"jwang\"). Keep replies short and relaxed. Do not mix English words into Sesotho.",
};

const HOLD_MSG = "haha wait my fone glitched, say that again lol";

const BURST_MSG = {
  en: "eish, one at a time 😂",
  sn: "shuwa, one at a time 😂",
  st: "thola hanyane 😂",
};

const MICRO_EN = [
  "lol",
  "aha",
  "ngyakutha",
  "yo",
];
const MICRO_ST = ["heita!", "ok", "leboha!"];
const MICRO_SN = ["hevo!", "ndatenda!", "ok"];

const STICKER_ACK = [
  "lol nice sticker",
  "haha that one's a vibe",
  "fire one 😂",
  "aight this sticker tho 😂",
];
const MEDIA_ACK = [
  "can't open that right now bro, text me",
  "can't view that here, just text me what you meant",
  "eish, can't see that on my end — say it in words 😂",
];

// ---------- small helpers ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanize() {
  await sleep(250 + Math.floor(Math.random() * 1600));
}

function ownerChats(env) {
  return (env.OWNER_CHATS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOwnerChat(env, chatId) {
  return ownerChats(env).includes(chatId);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function loadHistory(raw) {
  try {
    const h = JSON.parse(raw || "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function lastAssistantText(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    if (history[i].role === "assistant" && history[i].text) return history[i].text;
  }
  return "";
}

function holdMessage() {
  return HOLD_MSG;
}

function burstMessage(lang) {
  return (lang && BURST_MSG[lang]) || BURST_MSG.en;
}

function extractText(messageData) {
  const raw = messageData || {};
  const td = raw.textMessageData || {};
  if (td.textMessage) return String(td.textMessage).trim();
  const ext = raw.extendedTextMessage || td.extendedTextMessage || {};
  if (ext.text) return String(ext.text).trim();
  const q = raw.quotedMessage || {};
  if (q.textMessage) return String(q.textMessage).trim();
  if (q.extendedTextMessage && q.extendedTextMessage.text) {
    return String(q.extendedTextMessage.text).trim();
  }
  return "";
}

// ---------- AI ----------

function buildPrompt(persona, history, lang, who) {
  const parts = [persona];
  if (who) parts.push(who);
  let budget = MAX_PROMPT_CHARS;
  const turns = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    const line = `${t.role === "user" ? "Human" : "Assistant"}: ${t.text}`;
    budget -= line.length;
    if (budget < 0) break;
    turns.unshift(line);
  }
  parts.push("", ...turns, "Assistant:");
  const text = parts.join("\n");
  return lang && LANG_DIRECTIVE[lang] ? text + LANG_DIRECTIVE[lang] : text;
}

function retrySeconds(resp, errText) {
  const h = resp.headers.get("retry-after");
  if (h && /^[0-9.]+$/.test(h)) return Math.min(parseFloat(h), 3);
  const m = errText.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s?/i);
  if (m) return Math.min(parseFloat(m[1]), 3);
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
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
    }),
  };

  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (waited > 6) {
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
      if (attempt < 2) {
        const wait = Math.min(retrySeconds(resp, errText), 3);
        waited += wait;
        console.log("GEMINI_RETRY", resp.status, "wait", wait, "attempt", attempt + 1);
        await sleep(wait * 1000);
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

// ---------- rate / quota guards ----------

async function rateAllowed(env, chatId, isOwner) {
  if (isOwner) return true;
  const minute = Math.floor(Date.now() / 60000);
  const gk = "rate:m:" + minute;
  const n = (parseInt((await env.CHAT_RECORDS.get(gk)) || "0", 10) || 0) + 1;
  await env.CHAT_RECORDS.put(gk, String(n), { expirationTtl: 90 });
  if (n > AI_BURST_MAX) {
    console.log("RATE_GLOBAL_BLOCK");
    return false;
  }
  let c = null;
  try {
    c = JSON.parse((await env.CHAT_RECORDS.get("rate:c:" + chatId)) || "null");
  } catch {}
  const now = Date.now();
  if (!c || now - (c.t || 0) > 30000) {
    c = { n: 1, t: now };
  } else {
    c.n += 1;
  }
  await env.CHAT_RECORDS.put("rate:c:" + chatId, JSON.stringify(c), {
    expirationTtl: 120,
  });
  if (c.n > 3) {
    console.log("RATE_CHAT_BLOCK", chatId, c.n);
    return false;
  }
  return true;
}

async function dedupeCheck(env, chatId, idMessage) {
  if (!idMessage) return false;
  const k = "d:" + chatId;
  const last = await env.CHAT_RECORDS.get(k);
  if (last === idMessage) {
    console.log("DEDUPE skip", idMessage);
    return true;
  }
  await env.CHAT_RECORDS.put(k, idMessage, { expirationTtl: DEDUPE_TTL_SEC });
  return false;
}

// ---------- contacts (how the owner saved the person) ----------

async function whoContext(env, chatId, senderData) {
  let saved = (senderData && senderData.senderContactName || "").trim();
  let profile = (senderData && senderData.senderName || "").trim();
  const ck = "cnt:" + chatId;
  let cached = null;
  try {
    const raw = await env.CHAT_RECORDS.get(ck);
    cached = raw ? JSON.parse(raw) : null;
  } catch {}

  const fresh = cached && Date.now() - (cached.ts || 0) < CONTACT_TTL_MS;
  if (fresh) {
    if (!saved && cached.contactName) saved = cached.contactName;
    if (!profile && cached.profileName) profile = cached.profileName;
  }

  if ((saved || profile) && (!fresh || (saved && !cached))) {
    await env.CHAT_RECORDS.put(
      ck,
      JSON.stringify({ contactName: saved, profileName: profile, ts: Date.now() }),
      { expirationTtl: 172800 },
    );
    cached = { contactName: saved, profileName: profile };
  }

  if (!saved && !profile) {
    const savedCached = cached && (cached.contactName || cached.profileName);
    if (savedCached) {
      saved = cached.contactName || "";
      profile = cached.profileName || "";
    }
  }

  if (saved) {
    return `The person you're texting with is known to you: you have them saved as "${saved}".${
      profile && profile !== saved ? ` Their WhatsApp profile name is "${profile}".` : ""
    } Treat them exactly how you'd treat someone with that relationship — use their name sometimes, and match the right warmth or respect. Never mention that you read it off a contact list.`;
  }
  if (profile) {
    return `The person you're texting with goes by "${profile}" (maybe not the name you'd use with them). Address them naturally and keep the tone casual.`;
  }
  return null;
}

async function fetchContactIfNew(env, chatId, historyLen) {
  if (historyLen > 0) return null;
  try {
    const ck = "cnt:" + chatId;
    const raw = await env.CHAT_RECORDS.get(ck);
    if (raw) return null;
    const url = `https://api.green-api.com/waInstance${env.GREEN_ID}/getContactInfo/${env.GREEN_TOKEN}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    if (resp.status === 200) {
      const data = await resp.json().catch(() => null);
      if (data && (data.contactName || data.name)) {
        await env.CHAT_RECORDS.put(
          ck,
          JSON.stringify({
            contactName: data.contactName || "",
            profileName: data.name || "",
            ts: Date.now(),
          }),
          { expirationTtl: 172800 },
        );
        console.log("CONTACT fetch", chatId, data.contactName || data.name);
      } else {
        await env.CHAT_RECORDS.put(ck, JSON.stringify({ empty: 1, ts: Date.now() }), {
          expirationTtl: 172800,
        });
      }
    }
  } catch (err) {
    console.log("CONTACT_ERR", String(err));
  }
}

// ---------- media / micro handling ----------

const MICRO_PATTERN = [
  /^(ok|lol|lmao|haha|hehe|aha|yo)$/i,
  /^(thx|ty|thanks|thanku|dankie|leboha|ndatenda|tenda|waita)$/i,
  /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]+$/u,
];

function microReply(text, lang) {
  const t = (text || "").trim();
  if (!t) return null;
  for (const re of MICRO_PATTERN) {
    if (re.test(t)) {
      const list = lang === "st" ? MICRO_ST : lang === "sn" ? MICRO_SN : MICRO_EN;
      return pick(list);
    }
  }
  return null;
}

const NON_TEXT_TYPES = new Set([
  "imageMessage", "videoMessage", "documentMessage", "audioMessage",
  "pttMessage", "stickerMessage", "locationMessage", "contactMessage",
  "contactsArrayMessage", "linkMessage", "pollMessage", "productMessage",
  "orderMessage", "templateMessage", "buttonsMessage", "listMessage",
  "groupInviteMessage",
]);

// ---------- send ----------

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

// ---------- contact-based recovery (catches missed webhooks) ----------

async function getGreenContacts(id, token) {
  try {
    const resp = await fetch(
      `https://api.green-api.com/waInstance${id}/getContacts/${token}`,
      { method: "GET" },
    );
    if (!resp.ok) {
      console.log("CONTACTS_FAIL", resp.status);
      return [];
    }
    const arr = await resp.json().catch(() => []);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.log("CONTACTS_ERR", String(err));
    return [];
  }
}

async function pullChatHistory(chatId, count, id, token) {
  try {
    const resp = await fetch(
      `https://api.green-api.com/waInstance${id}/getChatHistory/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, count }),
      },
    );
    if (!resp.ok) {
      console.log("HISTORY_FAIL", chatId, resp.status);
      return [];
    }
    const arr = await resp.json().catch(() => []);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.log("HISTORY_ERR", String(err));
    return [];
  }
}

async function recoverMissed(env, persona) {
  const now = Date.now();
  const lastCd = await env.CHAT_RECORDS.get("c:sweep").catch(() => null);
  if (lastCd && now - parseInt(lastCd, 10) < SWEEP_COOLDOWN_SEC * 1000) {
    return;
  }
  await env.CHAT_RECORDS.put("c:sweep", String(now), { expirationTtl: 700 });

  const minute = Math.floor(Date.now() / 60000);
  const used = parseInt((await env.CHAT_RECORDS.get("rate:m:" + minute)) || "0", 10) || 0;
  if (used >= 7) {
    console.log("RECOVER_SKIP_BUDGET", used);
    return;
  }

  const contacts = await getGreenContacts(env.GREEN_ID, env.GREEN_TOKEN);
  const targets = (contacts || [])
    .map((c) => c && c.id)
    .filter(
      (id) =>
        id &&
        id.endsWith("@c.us") &&
        id !== BOT_WID &&
        id !== "0@c.us" &&
        !id.startsWith("0@"),
    );
  if (!targets.length) {
    console.log("SWEEP_NONE");
    return;
  }

  let checked = 0;
  let replies = 0;
  for (const chatId of targets) {
    if (checked >= SWEEP_MAX_CONTACTS || replies >= SWEEP_MAX_REPLIES) break;
    checked++;

    const hist = loadHistory(await env.CHAT_RECORDS.get("chat:" + chatId));
    const last = hist[hist.length - 1];
    if (last && last.role === "assistant" && now - (last.ts || 0) < 12 * 3600 * 1000) {
      continue;
    }

    const msgs = await pullChatHistory(chatId, 3, env.GREEN_ID, env.GREEN_TOKEN);
    let missed = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.type !== "incoming" || m.senderId !== chatId) continue;
      const ts = (m.timestamp || 0) * 1000;
      if (now - ts > SWEEP_LOOKBACK_MS) continue;
      const dup = await env.CHAT_RECORDS.get("d:" + chatId).catch(() => null);
      if (dup === (m.idMessage || "")) continue;
      const text = extractText(m);
      if (!text) continue;
      missed = { m, text, ts };
    }
    if (!missed) continue;
    if (replies >= SWEEP_MAX_REPLIES) break;
    replies++;

    console.log("SWEEP_FOUND", chatId, "-", missed.text.slice(0, 60));
    const lang = detectLang(missed.text);
    let who = null;
    try {
      const rc = JSON.parse((await env.CHAT_RECORDS.get("cnt:" + chatId)) || "null");
      who = (rc && (rc.contactName || rc.profileName)) || null;
    } catch {}

    const h2 = loadHistory(await env.CHAT_RECORDS.get("chat:" + chatId));
    if (!h2.length) {
      await fetchContactIfNew(env, chatId, 0);
    }
    h2.push({ role: "user", text: missed.text, ts: missed.ts });
    const result = await replyChain(
      buildPrompt(persona, h2, lang, who),
      env,
    );
    if (result) {
      const sent = await sendGreenApi(
        chatId,
        result.text,
        env.GREEN_ID,
        env.GREEN_TOKEN,
      );
      if (sent) {
        h2.push({ role: "assistant", text: result.text, ts: Date.now() });
        await env.CHAT_RECORDS.put("chat:" + chatId, JSON.stringify(h2.slice(-MAX_HISTORY)));
      }
      await env.CHAT_RECORDS.put("d:" + chatId, missed.m.idMessage || "", {
        expirationTtl: DEDUPE_TTL_SEC,
      });
      console.log("SWEEP_REPLY", chatId, result.brain, "sent", sent);
    }
  }
  console.log("RECOVERY done checked", checked, "replied", replies);
}

// ---------- main handler ----------

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

    const body = payload.body && typeof payload.body === "object" ? payload.body : payload;
    if (body.typeWebhook !== "incomingMessageReceived") {
      return new Response("ok");
    }

    const senderData = body.senderData || {};
    const chatId = senderData.chatId;
    const idMessage = body.idMessage || "";
    const messageData = body.messageData || {};

    if (!chatId || chatId.endsWith("@g.us")) {
      return new Response("ok");
    }

    if (await dedupeCheck(env, chatId, idMessage)) {
      return new Response("ok");
    }

    const persona = env.PERSONA || PERSONA_DEFAULT;
    const key = "chat:" + chatId;
    const isOwner = isOwnerChat(env, chatId);
    let history = loadHistory(await env.CHAT_RECORDS.get(key));

    // Owner commands (no AI, cheap)
    const rawText = extractText(messageData);
    const cmd = rawText.trim();
    if (isOwner && /^[!/]/.test(cmd)) {
      const command = cmd.slice(1).trim().toLowerCase();
      if (command === "help" || command === "help me") {
        const help =
          "*Tino's toolbox*\n" +
          "• /reset — forget this chat's history\n" +
          "• !help — this list\n" +
          "• Talk normally for anything else :)";
        await sendGreenApi(chatId, help, env.GREEN_ID, env.GREEN_TOKEN);
        return new Response("ok");
      }
      if (command === "reset") {
        await env.CHAT_RECORDS.put(key, "[]");
        await sendGreenApi(chatId, "aight, fresh start", env.GREEN_ID, env.GREEN_TOKEN);
        return new Response("ok");
      }
    }

    // Non-text messages → polite ack, keep context, never silent
    if (messageData.typeMessage !== "textMessage" && NON_TEXT_TYPES.has(messageData.typeMessage)) {
      await humanize();
      const ack =
        messageData.typeMessage === "stickerMessage"
          ? pick(STICKER_ACK)
          : pick(MEDIA_ACK);
      await sendGreenApi(chatId, ack, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text: `(sent a ${messageData.typeMessage})`, ts: Date.now() },
        { role: "assistant", text: ack, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    const text = rawText.trim();
    if (!text) {
      return new Response("ok");
    }
    console.log("INCOMING", chatId, "-", text, isOwner ? "owner" : "guest");

    await fetchContactIfNew(env, chatId, history.length);
    const lang = detectLang(text);

    // Trivial / emoji-only → micro reply, zero AI (only as back-chat after we spoke)
    const micro =
      (history.length === 0 || history[history.length - 1].role === "assistant")
        ? microReply(text, lang)
        : null;
    if (micro) {
      await humanize();
      await sendGreenApi(chatId, micro, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: micro, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    // Instant multilingual greeting cache, zero AI (first message only)
    const cachedReply =
      history.length === 0 ? cachedGreeting(text, lastAssistantText(history)) : null;
    if (cachedReply) {
      console.log("CACHED_REPLY", cachedReply);
      await humanize();
      await sendGreenApi(chatId, cachedReply, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: cachedReply, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    // AI paths, gated by rate guards
    const allowed = await rateAllowed(env, chatId, isOwner);
    const who = await whoContext(env, chatId, senderData);
    if (!allowed) {
      const bm = burstMessage(lang);
      console.log("RATE_BOUNCED", chatId);
      await humanize();
      await sendGreenApi(chatId, bm, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: bm, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    await humanize();
    history.push({ role: "user", text, ts: Date.now() });
    const result = await replyChain(
      buildPrompt(persona, history, lang, who),
      env,
    );
    if (result) {
      console.log("REPLY", result.brain, lang || "en");
      const sent = await sendGreenApi(chatId, result.text, env.GREEN_ID, env.GREEN_TOKEN);
      if (sent) {
        history.push({ role: "assistant", text: result.text, ts: Date.now() });
      }
    } else {
      console.log("FULL_CHAIN_FAIL");
      await humanize();
      await sendGreenApi(chatId, holdMessage(), env.GREEN_ID, env.GREEN_TOKEN);
    }
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));

    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    try {
      await recoverMissed(env, env.PERSONA || PERSONA_DEFAULT);
    } catch (err) {
      console.log("SCHED_ERR", String(err));
    }
  },
};

// ---------- greeting phrase bank ----------

function cleanGreetText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+(tino|bro|bru|bra|we|banna|majita|chommie|my\s+(bru|bra|brah))\s*$/g, "")
    .trim();
}

const GREETING_EN =
  /^(hello|hi|hie|hey|heya|heyy|heyyy|hiya|howdy|greetings|yo|yo\s*yo|yo\s*yo\s*yo|sup|wassup|watsup|whassup|wazzup|waddup|whaddup|wsp|wsup|wusup|whats\s*up|what\s*up|wassap|whatsup|whats\s*good|wats\s*gud|whats\s*gud|whats\s*new|whats\s*happening|what\s*happening|how\s*are\s*you|how\s*r\s*u|howru|how\s*are\s*you\s*doing|how\s*u\s*doing|how\s*you\s*doin|how\s*you\s*doing|how\s*u\s*doin|hru|hows\s*it\s*going|hows\s*it|hows\s*things|how\s*are\s*things|how\s*is\s*everything|howzit|how\s*fortune|u\s*ok|you\s*ok|u\s*o\s*k|you\s*good|u\s*good|u\s*fine|you\s*fine|u\s*busy|you\s*busy|u\s*u\s*p\s*|you\s*up|u\s*there|you\s*there|are\s*u\s*there|ar\s*u\s*there|u\s*hear\b|long\s*time|long\s*time\s*no\s*see|aweh|awwweh|heita|shap|bru|bra|my\s*bru|my\s*bra|chommie|choma|eish|hm\s*u\b|nm\s*u\b|good\s*(morning|afternoon|evening|day)|morning|afternoon|evening|heita\s*shap|heita\s*bru|shap\s*bru|aweh\s*shap|(?:hey|hi|hie|hello|heya|yo|howzit|sup|aweh|heita|wassup|whaddup|hiya)\s+(?:how\s*are\s*you|how\s*r\s*u|how\s*you\s*doing|how\s*u\s*doing|hows\s*it\s*going|whats\s*up|what\s*up|how\s*is\s*everything|how\s*are\s*things))$/;
const GREETING_ST =
  /^(dumela|dumelang|dumelang\s*banna|le\s*tsogile|u\s*tsogile|le\s*tsogile\s*hantle|u\s*tsogile\s*hantle|u\s*phela\s*joang|le\s*phela\s*joang|u\s*ntse\s*joang|le\s*ntse\s*joang|ho\s*etsahalang|ho\s*fetseng|u\s*kae|le\s*kae|khotso|khotso\s*ho\s*joang|ho\s*joang|joang|(?:dumela|dumelang|heita|shap)\s+(?:u\s*phela\s*joang|le\s*phela\s*joang|u\s*ntse\s*joang|le\s*ntse\s*joang|u\s*kae|le\s*kae|ho\s*joang|ho\s*etsahalang))$/;
const GREETING_SN =
  /^(mhoro|mhoroi|mhoro\s*we|mangwanani|masikati|manheru|uri\s*sei|urisei|muriko|zviri\s*sei|zvirisei|zvinjani|makadini|makadii|wakadii|wakadini|hevo|hovo|uri\s*pano|muri\s*pano|(?:mhoro|mhoroi|hevo|hovo)\s+(?:uri\s*sei|uri\s*pano|muriko|zviri\s*sei|zvinjani|wakadii|makadini))$/;

function pickAvoid(list, avoid) {
  if (avoid && list.length > 1) {
    const others = list.filter((x) => x !== avoid);
    if (others.length) return pick(others);
  }
  return pick(list);
}

function cachedGreeting(text, avoid) {
  const clean = cleanGreetText(text);
  if (GREETING_EN.test(clean)) {
    return pickAvoid(
      [
        "hey! what's up",
        "yo how's it going",
        "hi there",
        "hey, all good here",
        "sup! what's good",
        "heya, how you doing",
        "yo what's happening",
        "howzit, what you up to",
        "yo what's new with you",
        "hey! all good, you?",
        "heya! how are you doing",
        "hi! how's everything",
      ],
      avoid,
    );
  }
  if (GREETING_ST.test(clean)) {
    return pickAvoid(
      [
        "dumelang! heita, u ntse joang?",
        "heita shap! ke teng, wena u phela joang?",
        "khotso! ho etsahalang le hona joale?",
        "dumela, ke phela hantle. wena u ntse joang?",
        "ho fetseng? ke teng, u tsoile joang?",
        "shap! ke lokile, wena u phela joang?",
        "dumela! ke thabile. wena u ntse joang?",
        "heita! ke teng mona. u phela joang?",
        "khotso! le hantle. u tsoile joang?",
        "dumelang banna! ke teng, u phela joang?",
        "shap! ke siboloha. wena?",
        "ho lokile, kea leboha. u ntse joang?",
      ],
      avoid,
    );
  }
  if (GREETING_SN.test(clean)) {
    return pickAvoid(
      [
        "mhoro we! wakadii?",
        "hevo! uri sei?",
        "muriko? ndiri po",
        "ndiri zvakanaka, iwe uri sei?",
        "zvinjani? pane chii?",
        "mhoro! ndiri pano, wena uri sei?",
        "wakadii? ndiripo zvakanaka",
        "hegu! uri sei zvino?",
        "mhoro! ndiripo, pane chii?",
        "makadii shamwari? ndiripo",
        "ndiripo, wakadini iwe?",
        "mangwanani! uri sei? (or masikati/manheru depending on time)",
      ],
      avoid,
    );
  }
  return null;
}