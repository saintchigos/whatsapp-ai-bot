import json
import os
import sys
import time
from pathlib import Path

import requests

ID_INSTANCE = os.environ.get("GREEN_API_ID_INSTANCE", "").strip()
API_TOKEN = os.environ.get("GREEN_API_TOKEN", "").strip()
LLAMA_SERVER = os.environ.get("LLAMA_SERVER", "http://127.0.0.1:8080/v1").strip()
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "Qwen2.5-1.5B-Instruct").strip()
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
    messages = [{"role": "system", "content": system}]
    for turn in history[-MAX_HISTORY:]:
        role = "user" if turn["role"] == "user" else "assistant"
        messages.append({"role": role, "content": turn["text"]})

    model = LOCAL_MODEL
    try:
        r = requests.get(f"{LLAMA_SERVER}/models", timeout=10)
        if r.status_code == 200 and r.json().get("data"):
            model = r.json()["data"][0]["id"]
    except (requests.RequestException, KeyError, IndexError, TypeError):
        pass

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 400,
    }
    try:
        r = requests.post(f"{LLAMA_SERVER}/chat/completions", json=payload, timeout=120)
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"].strip()
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
    if not (ID_INSTANCE and API_TOKEN):
        print(
            "Missing config. Set GREEN_API_ID_INSTANCE and GREEN_API_TOKEN in .env",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Starting WhatsApp AI bot (local llama @ {LLAMA_SERVER})...")
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