/**
 * WhatsApp AI Bridge
 * Connects your WhatsApp number to Chigo's AI local models.
 * - No third-party services: links via QR code like WhatsApp Web.
 * - Brain: chigos-ai agent server (localhost:8000) or raw local llama (localhost:8080).
 * - Humanized replies: typing indicator, natural delay, natural text chunks, human persona.
 */
require("dotenv").config();
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8080/v1";
const CHIGOS_API_URL = process.env.CHIGOS_API_URL || "http://127.0.0.1:8000";
const CHIGOS_MASTER_CODE = process.env.CHIGOS_MASTER_CODE || "@T16i11n20k06";
const IGNORE_GROUPS = (process.env.IGNORE_GROUPS || "true").toLowerCase() === "true";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "12", 10);
const SESSION_DIR = path.resolve(process.env.SESSION_DIR || path.join(__dirname, "session"));
const BOT_PERSONA = process.env.BOT_PERSONA ||
  "You are the WhatsApp auto-replier of a busy person. Reply exactly like a real human " +
  "texting on WhatsApp: natural, warm, casual, sometimes witty. Keep replies short like " +
  "a chat message (under 3 sentences unless the topic really needs more). Match the " +
  "language the other person uses. No lists, no disclaimers, no markdown, no bullet points, " +
  "no 'as an AI'. Occasionally use small human touches ('yeah', 'haha', 'no worries', 'btw'). " +
  "Never reveal you are an AI, a bot, or a model. If you don't know something, say so plainly.";

let chigosToken = null;
const history = new Map();
const processed = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function brainAgent() {
  try {
    const r = await fetch(`${CHIGOS_API_URL}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return "chigos";
  } catch {}
  try {
    const r = await fetch(`${LLAMA_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return "llama";
  } catch {}
  return null;
}

async function chigosTokenGet() {
  if (chigosToken) return chigosToken;
  const r = await fetch(`${CHIGOS_API_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ master_code: CHIGOS_MASTER_CODE }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("chigos auth failed");
  chigosToken = (await r.json()).token;
  return chigosToken;
}

async function askChigos(jid, text) {
  const token = await chigosTokenGet();
  const conv = `wa-${jid.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const r = await fetch(`${CHIGOS_API_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token },
    body: JSON.stringify({ message: text, conversation_id: conv }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error("chigos chat failed");
  return (await r.json()).response;
}

async function llamaModelId() {
  try {
    const r = await fetch(`${LLAMA_URL}/models`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      const id = data.data && data.data[0] && data.data[0].id;
      if (id) return id;
    }
  } catch {}
  return "Qwen2.5-1.5B-Instruct";
}

async function askLlama(messages) {
  const r = await fetch(`${LLAMA_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: await llamaModelId(), messages, temperature: 0.7, max_tokens: 400 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error("llama chat failed");
  const text = (await r.json()).choices[0].message.content;
  return (text || "").trim();
}

async function getReply(jid, text) {
  const hist = history.get(jid) || [];
  hist.push({ role: "user", content: text });
  const trimmed = hist.slice(-MAX_HISTORY);

  const brain = await brainAgent();
  let reply = "";
  if (brain === "chigos") {
    reply = await askChigos(jid, text);
  } else if (brain === "llama") {
    const messages = [{ role: "system", content: BOT_PERSONA }, ...trimmed];
    reply = await askLlama(messages);
  } else {
    console.log("BRAIN_OFFLINE (need chigos server :8000 or llama :8080)");
  }

  if (reply) {
    hist.push({ role: "assistant", content: reply });
    history.set(jid, hist.slice(-MAX_HISTORY));
  } else {
    history.set(jid, hist.slice(0, -1));
  }
  return reply;
}

function chunkText(text, max = 220) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [""];
}

function thinkWait(text) {
  return Math.max(1500, Math.min(8000, text.length * 80 + Math.round(2000 * Math.random())));
}

async function typingPresence(sock, jid, ms) {
  await sock.sendPresenceUpdate("composing", jid);
  await sleep(ms);
  await sock.sendPresenceUpdate("paused", jid);
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === "status@broadcast") return;
  if (IGNORE_GROUPS && jid.endsWith("@g.us")) return;
  if (processed.has(msg.key.id)) return;
  processed.add(msg.key.id);

  const text =
    (msg.message && (msg.message.conversation ||
      (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
      (msg.message.imageMessage && msg.message.imageMessage.caption))) ||
    "";
  if (!text.trim()) return;

  const started = Date.now();
  let reply;
  try {
    reply = await getReply(jid, text.trim());
  } catch (err) {
    console.log("REPLY_ERR", err.message);
    return;
  }
  if (!reply) return;

  const remaining = thinkWait(reply) - (Date.now() - started);
  await typingPresence(sock, jid, Math.max(500, remaining));

  const chunks = chunkText(reply);
  for (let i = 0; i < chunks.length; i++) {
    await sock.sendMessage(jid, { text: chunks[i] });
    if (chunks.length > 1) await sleep(400 + Math.random() * 800);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["ChigosAI Bridge", "Chrome", "124.0.0.1"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\n============================================");
      console.log(" Scan this QR with your phone -> WhatsApp -> ");
      console.log(" Linked Devices -> Link a Device");
      console.log("============================================");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("Connected to WhatsApp. Autoreplier is ON.");
    }
    if (connection === "close") {
      const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      if (status !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        start();
      } else {
        console.log("Logged out of WhatsApp. Restart the bridge to re-link.");
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) handleMessage(sock, m).catch((e) => console.log("HANDLE_ERR", e.message));
  });
}

process.on("uncaughtException", (e) => console.log("FATAL", e.message));
start();

setInterval(() => {
  if (history.size > 300) history.clear();
  if (processed.size > 2000) processed.clear();
}, 3600000);