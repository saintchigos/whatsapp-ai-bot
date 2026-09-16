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
  "Shona — match their language exactly.\n" +
  "- You understand slang like a local: English slang (fr, ngl, lowkey, " +
  "deadass, bet, cap, no cap, ong, wym, idk, ykwim, gtg, idc) and southern " +
  "African township slang (howzit, heita, shap, bru, bra, kasi, vibes, " +
  "eish, majita, chommie, my bru). Decode the vibe mentally and answer " +
  "back in the same slang register.\n" +
  "- When replying in Sesotho or Shona, only write words you KNOW are " +
  "correct — a short correct sentence beats a long guessed one. Never " +
  "stitch English words into Sesotho or Shona sentences.\n" +
  "- Keep replies to 1-2 sentences, normal texting style (lol, sike, nah, " +
  "ok that's crazy, let me think...), relaxed and confident. Sometimes ask " +
  "a question back so the chat flows.\n" +
  "- Never say you are an AI, a bot or an assistant. Never be formal, " +
  "preachy or overly helpful. If you don't know something just say you're " +
  "not sure. Sound like a real friend, not a business.";

const CLAUDE_HOLD = "haha sorry, my phone froze, one sec lol";

const MAX_HISTORY = 20;
const SWEEP_LIMIT = 30;
const MAX_PROMPT_CHARS = 2400;
const AI_BURST_MAX = 14;           // AI replies per minute, global cap
const CONTACT_TTL_MS = 86400000;   // 24h contact cache
const DEDUPE_TTL_SEC = 604800;     // 7 days

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

const CANNED_REPLY = {
  sn: [
    "ndiri po, zvakanaka. iwe uri sei?",
    "hevo! ndiri pano, wakadii?",
    "zviri sei? ndiri zvakanaka fela",
    "mhoro we, ndiri po. wena uri sei?",
  ],
  st: [
    "ke teng, ho lokile. wena u ntse joang?",
    "heita! ke phela hantle, wena u joang?",
    "shap, ke lokile. u tsoile joang?",
    "dumela, ke teng mona. wena u phela joang?",
  ],
};

const HOLD_MSG = {
  sn: "sori, foni yangu yaoma, one sec",
  st: "sorri, founu yaka e ngametse, one sec",
};

const BURST_MSG = {
  en: "haha aight aight, one at a time 😂",
  sn: "haha shuwa, one at a time 😂",
  st: "haha, thola hanyane 😂",
};

const MICRO_EN = [
  "aight bet",
  "lol cool",
  "np bro",
  "haha yeah",
  "yo",
  "cool cool",
  "no worries",
];
const MICRO_ST = ["ho lokile", "shap!", "heita", "kea utloa"];
const MICRO_SN = ["zvakanaka", "hevo!", "shuwa"];

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

function cannedReply(lang) {
  const list = CANNED_REPLY[lang];
  return list ? pick(list) : null;
}

function holdMessage(lang) {
  return (lang && HOLD_MSG[lang]) || CLAUDE_HOLD;
}

function burstMessage(lang) {
  return (lang && BURST_MSG[lang]) || BURST_MSG.en;
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
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
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

async function replyChain(prompt, env, lang) {
  const gemini = await askGemini(prompt, env.GEMINI_KEY, env.GEMINI_MODEL);
  if (gemini) return { text: gemini, brain: "gemini" };
  if (lang === "sn" || lang === "st") {
    const canned = cannedReply(lang);
    if (canned) return { text: canned, brain: "canned" };
  }
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
  /^(ok|okk|okay|oke|okei|k|kk|kkk|sure|yep|yup|yaas|yea|yeah|yepyep|fine|alright|aight|ight|dope|nice|cool|sweet|noted|lol|lmao|lool|loool|haha+|hehe+|hmm+|mm+|oh+|ooh+|pff+|koe|kool|bet|good|great|gw|gj)$/i,
  /^(thx|ty|tysm|tnx|thanks|thank\s*you|thanku|dankie|kea\s*leboha|leboha|ndatenda|tenda|waita)$/i,
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

// ---------- catch-up sweep ----------

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
      const lang = detectLang(last.text);
      let who = null;
      try {
        const rawC = await env.CHAT_RECORDS.get("cnt:" + chatId);
        if (rawC) {
          const c = JSON.parse(rawC);
          who = c.contactName || c.profileName || null;
        }
      } catch {}
      const result = await replyChain(buildPrompt(persona, history, lang, who), env, lang);
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
    const rawText = (messageData.textMessageData || {}).textMessage || "";
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
    if (messageData.typeMessage !== "textMessage") {
      if (NON_TEXT_TYPES.has(messageData.typeMessage)) {
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
      }
      return new Response("ok");
    }

    const text = rawText.trim();
    if (!text) {
      return new Response("ok");
    }
    console.log("INCOMING", chatId, "-", text, isOwner ? "owner" : "guest");

    await fetchContactIfNew(env, chatId, history.length);
    const lang = detectLang(text);

    // Trivial / emoji-only → micro reply, zero AI
    const micro = microReply(text, lang);
    if (micro) {
      await sendGreenApi(chatId, micro, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: micro, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      return new Response("ok");
    }

    // Instant multilingual greeting cache, zero AI
    const cachedReply = cachedGreeting(text);
    if (cachedReply) {
      console.log("CACHED_REPLY", cachedReply);
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
      await sendGreenApi(chatId, bm, env.GREEN_ID, env.GREEN_TOKEN);
      history.push(
        { role: "user", text, ts: Date.now() },
        { role: "assistant", text: bm, ts: Date.now() },
      );
      await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
      try {
        await sweepUnreplied(env, persona);
      } catch (err) {
        console.log("SWEEP_ERR", String(err));
      }
      return new Response("ok");
    }

    await humanize();
    history.push({ role: "user", text, ts: Date.now() });
    const result = await replyChain(buildPrompt(persona, history, lang, who), env, lang);
    if (result) {
      console.log("REPLY", result.brain, lang || "en");
      const sent = await sendGreenApi(chatId, result.text, env.GREEN_ID, env.GREEN_TOKEN);
      if (sent) {
        history.push({ role: "assistant", text: result.text, ts: Date.now() });
      }
    } else {
      console.log("FULL_CHAIN_FAIL");
      await sendGreenApi(chatId, holdMessage(lang), env.GREEN_ID, env.GREEN_TOKEN);
    }
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));

    try {
      await sweepUnreplied(env, persona);
    } catch (err) {
      console.log("SWEEP_ERR", String(err));
    }

    return new Response("ok");
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

function cachedGreeting(text) {
  const clean = cleanGreetText(text);
  if (GREETING_EN.test(clean)) {
    return [
      "hey! what's up",
      "yo how's it going",
      "hi there",
      "hey, all good here",
      "sup! what's good",
      "heya, how you doing",
      "yo what's happening",
      "howzit, what you up to",
    ][Math.floor(Math.random() * 8)];
  }
  if (GREETING_ST.test(clean)) {
    return [
      "dumelang! heita, u ntse joang?",
      "heita shap! ke teng, wena u phela joang?",
      "khotso! ho etsahalang le hona joale?",
      "dumela, ke phela hantle. wena u ntse joang?",
      "ho fetseng? ke teng, u tsoile joang?",
      "shap! ke lokile, wena u phela joang?",
    ][Math.floor(Math.random() * 6)];
  }
  if (GREETING_SN.test(clean)) {
    return [
      "mhoro we! wakadii?",
      "hevo! uri sei?",
      "muriko? ndiri po",
      "ndiri zvakanaka, iwe uri sei?",
      "zvinjani? pane chii?",
      "mhoro! ndiri pano, wena uri sei?",
    ][Math.floor(Math.random() * 6)];
  }
  return null;
}