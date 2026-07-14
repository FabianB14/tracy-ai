// Conversation logging.
//
// Every /chat exchange is recorded as { timestamp, userId, surface, messages,
// reply, toolsUsed }. Two backends:
//   - DATABASE_URL set  → Postgres (src/db.js). Used on Render so logs survive
//                         redeploys. Falls back to the file if a DB write fails.
//   - DATABASE_URL unset → appended to logs/conversations.jsonl (zero-config
//                         local dev).
//
// This is future training fuel and a debugging aid for Tracy across all surfaces.
//
// ⚠️ CONSENT — READ BEFORE PRODUCTION ⚠️
// These logs contain real user conversations and may include personal data. Do
// NOT ship any app that calls Tracy with this enabled until that app shows users
// clear consent language: what is stored, why, how long it's kept, and how to
// opt out. Storing conversations without informed consent can violate privacy
// law (GDPR, CCPA, etc.). Keep logs/ out of version control (it is, via
// .gitignore), secure the store at rest, and honor per-user opt-out here (skip
// logging when a request opts out) once consent plumbing exists.

import { appendFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, logConversationToDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "conversations.jsonl");

// Append one JSON line to logs/conversations.jsonl.
function logToFile({ userId, surface, messages, reply, toolsUsed }) {
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
    console.error("Failed to log conversation to file:", err);
  }
}

// Fire-and-forget: callers don't await this, so a slow DB never delays a reply.
export function logConversation(entry) {
  if (dbEnabled()) {
    logConversationToDb(entry).catch((err) => {
      // If the DB write fails, don't lose the record — fall back to the file.
      console.error("DB log failed, falling back to file:", err.message);
      logToFile(entry);
    });
  } else {
    logToFile(entry);
  }
}
