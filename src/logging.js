// Conversation logging.
//
// Every /chat exchange is appended as one JSON line to logs/conversations.jsonl:
//   { timestamp, userId, surface, messages, reply, toolsUsed }
//
// This is future training fuel and a debugging aid for Tracy across all surfaces.
//
// ⚠️ CONSENT — READ BEFORE PRODUCTION ⚠️
// These logs contain real user conversations and may include personal data. Do
// NOT ship any app that calls Tracy with this enabled until that app shows users
// clear consent language: what is stored, why, how long it's kept, and how to
// opt out. Storing conversations without informed consent can violate privacy
// law (GDPR, CCPA, etc.). Keep logs/ out of version control (it is, via
// .gitignore) and secure the file at rest. Consider per-user opt-out honored
// here (skip logging when a request opts out) once consent plumbing exists.

import { appendFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "conversations.jsonl");

export function logConversation({ userId, surface, messages, reply, toolsUsed }) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      userId: userId ?? null,
      surface: surface ?? null,
      messages,
      reply,
      toolsUsed: toolsUsed ?? [],
    });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (err) {
    // Never let a logging failure break a live conversation.
    console.error("Failed to log conversation:", err);
  }
}
