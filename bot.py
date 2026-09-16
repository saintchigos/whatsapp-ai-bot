import json
import os
import sys
import time
from pathlib import Path

import requests

ID_INSTANCE = os.environ.get("GREEN_API_ID_INSTANCE", "").strip()
API_TOKEN = os.environ.get("GREEN_API_TOKEN", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash").strip()
AI_PERSONA = os.environ.get(
    "AI_PERSONA",
    "You are a friendly personal assistant who replies to WhatsApp messages "
    "on behalf of the owner. Be warm, natural and concise (keep replies under "
    "150 words). Chat in the same language you are written in. If you cannot "
    "answer something, say so plainly and offer to pass it to the owner.",
).strip()
AI_LOCALE = os.environ.get("AI_LOCALE", "en-ZA").strip()
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))

API_BASE = "https://api.green-api.com"
MAX_HISTORY = 20

DATA_DIR.mkdir(parents=True, exist_ok=True)
CONVERSATIONS = DATA_DIR / "conversations.json"


def load_conversations():
    if CONVERSATIONS.exists():
        try:
            return json.loads(CONVERSATIONS.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_conversations(data):
    tmp = CONVERSATIONS.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(CONVERSATIONS)


def receive_notification():
    url = f"{API_BASE}/waInstance{ID_INSTANCE}/ReceiveNotification/{API_TOKEN}"
    try:
        r = requests.get(url, params={"receiveTimeout": 10}, timeout=30)
        if r.status_code == 200 and r.text.strip() and r.text.strip() != "null":
            return r.json()
    except requests.RequestException:
        pass
    return None


def delete_notification(receipt_id):
    url = f"{API_BASE}/waInstance{ID_INSTANCE}/DeleteNotification/{API_TOKEN}"
    try:
        requests.get(url, params={"receiptId": receipt_id}, timeout=15)
    except requests.RequestException:
        pass


def send_message(chat_id, text):
    url = f"{API_BASE}/waInstance{ID_INSTANCE}/SendMessage/{API_TOKEN}"
    try:
        r = requests.post(
            url,
            json={"chatId": chat_id, "message": text},
            timeout=30,
        )
        return r.status_code == 200
    except requests.RequestException:
        return False


def ai_reply(history):
    system = f"{AI_PERSONA}\nLanguage/region: {AI_LOCALE}"
    lines = [system, ""]
    for turn in history[-MAX_HISTORY:]:
        who = "Human" if turn["role"] == "user" else "Assistant"
        lines.append(f"{who}: {turn['text']}")
    lines.append("Assistant:")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": "\n".join(lines)}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 400},
    }
    try:
        r = requests.post(url, params={"key": GEMINI_API_KEY}, json=payload, timeout=60)
        r.raise_for_status()
        data = r.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        return text or None
    except (requests.RequestException, KeyError, IndexError, TypeError):
        return None


def handle_message(chat_id, text, conversations):
    history = conversations.setdefault(chat_id, [])
    history.append({"role": "user", "text": text})
    history = history[-MAX_HISTORY:]

    reply = ai_reply(history)
    if reply:
        if send_message(chat_id, reply):
            history.append({"role": "assistant", "text": reply})
            history = history[-MAX_HISTORY:]
    else:
        history.pop()

    conversations[chat_id] = history
    save_conversations(conversations)


def main():
    if not (ID_INSTANCE and API_TOKEN and GEMINI_API_KEY):
        print(
            "Missing config. Set GREEN_API_ID_INSTANCE, GREEN_API_TOKEN and "
            "GEMINI_API_KEY in .env",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Starting WhatsApp AI bot ({GEMINI_MODEL})...")
    conversations = load_conversations()
    last_error = None

    while True:
        try:
            notification = receive_notification()
            if notification is None:
                if not ID_INSTANCE.startswith("1"):
                    last_error = None
                time.sleep(1)
                continue

            body = notification.get("body", {}) or {}
            receipt_id = notification.get("receiptId")
            sender = body.get("senderData", {}) or {}
            chat_id = sender.get("chatId", "")
            message_data = body.get("messageData", {}) or {}

            if (
                receipt_id is not None
                and body.get("typeWebhook") == "incomingMessageReceived"
                and chat_id
                and not chat_id.endswith("@g.us")
                and message_data.get("typeMessage") == "textMessage"
            ):
                text = (message_data.get("textMessageData") or {}).get("textMessage", "").strip()
                if text:
                    try:
                        handle_message(chat_id, text, conversations)
                    except (requests.RequestException, OSError):
                        time.sleep(5)

            if receipt_id is not None:
                delete_notification(receipt_id)

            last_error = None
        except KeyboardInterrupt:
            print("Stopped.")
            return
        except Exception as exc:
            if exc != last_error:
                print(f"Error: {exc}", file=sys.stderr)
                last_error = exc
            time.sleep(5)


if __name__ == "__main__":
    main()