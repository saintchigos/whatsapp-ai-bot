/**
 * WhatsApp AI auto-replier (Cloudflare Worker — free, always-on).
 *
 * Receives WhatsApp Cloud API webhooks (Meta) when a WhatsApp message arrives,
 * asks Gemini for a reply (with Cloudflare's free Workers AI as backup brain),
 * sends it back via the Meta Graph API, and remembers each conversation in
 * Workers KV. Free: customer-service replies inside the 24h window cost 0.
 *
 * Environment variables (set in the Workers dashboard / wrangler.toml):
 *   META_TOKEN         - Meta Graph API access token (with whatsapp_business_messaging)
 *   META_PHONE_ID      - numeric WhatsApp phone-number ID (from Meta dashboard)
 *   META_VERIFY_TOKEN  - string you choose; must match the one in the Meta
 *                        webhook config (hub.verify_token)
 *   META_APP_SECRET    - optional; if set, webhook payloads are validated with
 *                        X-Hub-Signature-256 (HMAC-SHA256 of the raw body)
 *   GEMINI_KEY         - Gemini API key (AQ... or AIza... format)
 *   GEMINI_MODEL       - optional, default "gemini-flash-latest"
 *   PERSONA            - optional system prompt for the AI
 *   OWNER_CHATS        - comma-separated chatIds that get owner commands and are
 *                        never rate-limited (e.g. "26662172809@c.us")
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
const SWEEP_LOOKBACK_MS = 7 * 24 * 3600 * 1000; // backfill "left on read" up to 7 days
const SWEEP_MAX_REPLIES = 5;       // replies sent per recovery run
const SWEEP_COOLDOWN_SEC = 600;    // min gap between recovery runs (cron 10min)
const GRAPH_VERSION = "v21.0";

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
  "accepted 😂",
  "😂",
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
  const imd = raw.interactiveMessageData || {};
  if (imd.title) return String(imd.title).trim();
  const ext = raw.extendedTextMessage || td.extendedTextMessage || {};
  if (ext.text) return String(ext.text).trim();
  const q = raw.quotedMessage || {};
  if (q.textMessage) return String(q.textMessage).trim();
  if (q.extendedTextMessage && q.extendedTextMessage.text) {
    return String(q.extendedTextMessage.text).trim();
  }
  return "";
}

// ---------- Meta Cloud API (webhook + sending) ----------

function waId(chatId) {
  return (chatId || "").replace(/@c\.us$/, "");
}

async function sendMeta(chatId, message, env) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env.META_PHONE_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.META_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: waId(chatId),
      type: "text",
      text: { body: message },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.log("SEND_FAIL", resp.status, errText.slice(0, 200));
  }
  return resp.ok;
}

// Turn a Meta Cloud API message object into the internal messageData shape.
function metaMessageData(msg) {
  const type = msg.type || "text";
  if (type === "reaction") return null; // emoji react to our own message: ignore
  const txt =
    (type === "text" && msg.text && msg.text.body) ||
    (type === "button" && msg.button && msg.button.text) ||
    (type === "interactive" &&
      msg.interactive &&
      ((msg.interactive.button_reply && msg.interactive.button_reply.title) ||
        (msg.interactive.list_reply && msg.interactive.list_reply.title))) ||
    (type === "image" && msg.image && msg.image.caption) ||
    (type === "video" && msg.video && msg.video.caption) ||
    (type === "document" && msg.document && msg.document.caption) ||
    "";
  return {
    typeMessage:
      type === "text" || type === "button" || type === "interactive"
        ? "textMessage"
        : type + "Message",
    textMessageData: { textMessage: txt },
    interactiveMessageData:
      type === "interactive" ? { title: txt } : undefined,
  };
}

async function validSignature(secret, raw, sig) {
  if (!secret || !sig || !sig.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sig.slice(7);
}

async function cacheProfile(env, chatId, profileName) {
  if (!profileName) return null;
  try {
    const ck = "cnt:" + chatId;
    const raw = await env.CHAT_RECORDS.get(ck);
    let cached = null;
    try {
      cached = raw ? JSON.parse(raw) : null;
    } catch {}
    if (
      cached &&
      cached.profileName === profileName &&
      Date.now() - (cached.ts || 0) < CONTACT_TTL_MS
    ) {
      return { contactName: cached.contactName || "", profileName };
    }
    const entry = {
      contactName: (cached && cached.contactName) || "",
      profileName,
      ts: Date.now(),
    };
    await env.CHAT_RECORDS.put(ck, JSON.stringify(entry), { expirationTtl: 172800 });
    console.log("CONTACT fetch", chatId, profileName);
    return entry;
  } catch (err) {
    console.log("CONTACT_ERR", String(err));
    return null;
  }
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

// ---------- contacts (what the AI knows about who it's texting) ----------

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

// ---------- inbox ledger (replaces the GreenAPI journal for recovery) ----------

const INBOX_MAX = 300;

async function pushInbox(env, rec) {
  try {
    let list = [];
    try {
      list = JSON.parse((await env.CHAT_RECORDS.get("inbox")) || "[]");
    } catch {}
    if (!Array.isArray(list)) list = [];
    list.unshift(rec);
    if (list.length > INBOX_MAX) list.length = INBOX_MAX;
    await env.CHAT_RECORDS.put("inbox", JSON.stringify(list));
  } catch (err) {
    console.log("INBOX_ERR", String(err));
  }
}

// ---------- contact-based recovery (catches missed webhooks / left-on-read) ----------

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

  let list = [];
  try {
    list = JSON.parse((await env.CHAT_RECORDS.get("inbox")) || "[]");
  } catch {}
  if (!Array.isArray(list) || list.length === 0) {
    console.log("SWEEP_NONE");
    return;
  }

  let replies = 0;
  for (const m of list) {
    if (replies >= SWEEP_MAX_REPLIES) break;
    const chatId = m.chatId;
    if (!chatId || !chatId.endsWith("@c.us") || chatId === BOT_WID || chatId === "0@c.us") {
      continue;
    }
    const ts = m.ts || 0;
    if (now - ts > SWEEP_LOOKBACK_MS) continue;

    const text = (m.text || "").trim();
    if (!text || text.startsWith("{{")) continue;

    const dup = await env.CHAT_RECORDS.get("d:" + chatId).catch(() => null);
    if (dup === (m.idMessage || "")) continue;

    const h2 = loadHistory(await env.CHAT_RECORDS.get("chat:" + chatId));
    const last = h2[h2.length - 1];
    if (
      last &&
      last.role === "assistant" &&
      (last.ts || 0) >= ts
    ) {
      continue; // already replied to this exchange
    }

    console.log("SWEEP_FOUND", chatId, "-", text.slice(0, 60));
    const lang = detectLang(text);
    let who = null;
    try {
      const rc = JSON.parse((await env.CHAT_RECORDS.get("cnt:" + chatId)) || "null");
      who = (rc && (rc.contactName || rc.profileName)) || null;
    } catch {}

    h2.push({ role: "user", text, ts });
    const result = await replyChain(buildPrompt(persona, h2, lang, who), env);
    if (result) {
      const sent = await sendMeta(chatId, result.text, env);
      if (sent) {
        h2.push({ role: "assistant", text: result.text, ts: Date.now() });
        await env.CHAT_RECORDS.put("chat:" + chatId, JSON.stringify(h2.slice(-MAX_HISTORY)));
        await env.CHAT_RECORDS.put("d:" + chatId, m.idMessage || "", {
          expirationTtl: DEDUPE_TTL_SEC,
        });
      }
      console.log("SWEEP_REPLY", chatId, result.brain, "sent", sent);
      replies++;
    }
  }
  console.log("RECOVERY done replied", replies);
}

// ---------- main message pipeline (per incoming WhatsApp message) ----------

async function processMessage(env, chatId, idMessage, senderData, messageData) {
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
      await sendMeta(chatId, help, env);
      return;
    }
    if (command === "reset") {
      await env.CHAT_RECORDS.put(key, "[]");
      await sendMeta(chatId, "aight, fresh start", env);
      return;
    }
  }

  // Non-text messages → polite ack, keep context, never silent
  if (messageData.typeMessage !== "textMessage" && NON_TEXT_TYPES.has(messageData.typeMessage)) {
    await humanize();
    const ack =
      messageData.typeMessage === "stickerMessage"
        ? pick(STICKER_ACK)
        : pick(MEDIA_ACK);
    await sendMeta(chatId, ack, env);
    history.push(
      { role: "user", text: `(sent a ${messageData.typeMessage})`, ts: Date.now() },
      { role: "assistant", text: ack, ts: Date.now() },
    );
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    return;
  }

  const text = rawText.trim();
  if (!text) {
    return;
  }
  console.log("INCOMING", chatId, "-", text, isOwner ? "owner" : "guest");

  const lang = detectLang(text);

  // Trivial / emoji-only → micro reply, zero AI (only as back-chat after we spoke)
  const micro =
    (history.length === 0 || history[history.length - 1].role === "assistant")
      ? microReply(text, lang)
      : null;
  if (micro) {
    await humanize();
    await sendMeta(chatId, micro, env);
    history.push(
      { role: "user", text, ts: Date.now() },
      { role: "assistant", text: micro, ts: Date.now() },
    );
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    return;
  }

  // Instant multilingual greeting cache, zero AI (first message only)
  const cachedReply =
    history.length === 0 ? cachedGreeting(text, lastAssistantText(history)) : null;
  if (cachedReply) {
    console.log("CACHED_REPLY", cachedReply);
    await humanize();
    await sendMeta(chatId, cachedReply, env);
    history.push(
      { role: "user", text, ts: Date.now() },
      { role: "assistant", text: cachedReply, ts: Date.now() },
    );
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    return;
  }

  // AI paths, gated by rate guards
  const allowed = await rateAllowed(env, chatId, isOwner);
  const who = await whoContext(env, chatId, senderData);
  if (!allowed) {
    const bm = burstMessage(lang);
    console.log("RATE_BOUNCED", chatId);
    await humanize();
    await sendMeta(chatId, bm, env);
    history.push(
      { role: "user", text, ts: Date.now() },
      { role: "assistant", text: bm, ts: Date.now() },
    );
    await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
    return;
  }

  await humanize();
  history.push({ role: "user", text, ts: Date.now() });
  const result = await replyChain(
    buildPrompt(persona, history, lang, who),
    env,
  );
  if (result) {
    console.log("REPLY", result.brain, lang || "en");
    const sent = await sendMeta(chatId, result.text, env);
    if (sent) {
      history.push({ role: "assistant", text: result.text, ts: Date.now() });
    }
  } else {
    console.log("FULL_CHAIN_FAIL");
    await humanize();
    await sendMeta(chatId, holdMessage(), env);
  }
  await env.CHAT_RECORDS.put(key, JSON.stringify(history.slice(-MAX_HISTORY)));
}

async function handleIncoming(env, ctx, msg, profileName) {
  const from = msg.from;
  if (!from) return;
  const chatId = (from + "@c.us").replace("@s.whatsapp.net@c.us", "@c.us");
  if (chatId === BOT_WID || chatId === "0@c.us" || chatId.endsWith("@g.us")) {
    return;
  }
  const idMessage = msg.id || "";
  const ts = (parseInt(msg.timestamp || "0", 10) || 0) * 1000;
  const messageData = metaMessageData(msg);
  if (!messageData) return; // e.g. reaction

  // Backstop recovery: every incoming webhook also runs an inbox sweep to
  // catch stale / left-on-read messages (cooldown-gated, so it's cheap).
  ctx.waitUntil(
    recoverMissed(env, env.PERSONA || PERSONA_DEFAULT).catch((err) =>
      console.log("SWEEP_WH_ERR", String(err)),
    ),
  );

  if (profileName) {
    await cacheProfile(env, chatId, profileName);
  }

  if (await dedupeCheck(env, chatId, idMessage)) {
    return;
  }

  await pushInbox(env, {
    chatId,
    idMessage,
    text: extractText(messageData),
    ts,
  });

  const senderData = { chatId, senderName: profileName, senderContactName: profileName };
  await processMessage(env, chatId, idMessage, senderData, messageData);
}

// ---------- main handler ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const sp = url.searchParams;

    // WhatsApp Cloud API webhook verification (Meta pings this GET once).
    if (request.method === "GET") {
      if (sp.get("hub.mode") === "subscribe") {
        if (sp.get("hub.verify_token") === env.META_VERIFY_TOKEN) {
          return new Response(sp.get("hub.challenge") || "ok", { status: 200 });
        }
        return new Response("forbidden", { status: 403 });
      }
      return new Response("whatsapp-ai-bot is alive", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // Optional payload authenticity check via X-Hub-Signature-256.
    if (env.META_APP_SECRET) {
      const raw = await request.clone().arrayBuffer();
      const sig = request.headers.get("x-hub-signature-256") || "";
      if (!(await validSignature(env.META_APP_SECRET, raw, sig))) {
        console.log("SIGNATURE_BAD");
        return new Response("unauthorized", { status: 401 });
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (!value.messages || !Array.isArray(value.messages)) continue;
        const profileByName = {};
        for (const c of value.contacts || []) {
          if (c.wa_id && c.profile && c.profile.name) {
            profileByName[c.wa_id] = String(c.profile.name).trim();
          }
        }
        for (const msg of value.messages || []) {
          ctx.waitUntil(
            handleIncoming(env, ctx, msg, profileByName[msg.from] || "").catch((err) =>
              console.log("HANDLE_ERR", String(err)),
            ),
          );
        }
      }
    }

    return new Response("ok", { status: 200 });
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