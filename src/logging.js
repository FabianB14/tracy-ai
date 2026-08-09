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

// ---- Secret scrubbing ----
// Anything that looks like a credential is masked BEFORE it is stored, in every
// logged turn — not just vault turns. This matters because a pasted secret can
// appear in turns where no vault tool ran (e.g. Tracy asks "who is this for?"
// first), and because clients re-send the whole chat history each turn, so one
// paste would otherwise be logged again and again. Better to over-mask a log
// than to retain a key: logs are a debugging aid, not a system of record.
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,          // Anthropic
  /\bsk[-_](?:live|test|proj)[-_][A-Za-z0-9_-]{8,}\b/g, // Stripe/OpenAI-style
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,             // generic sk- keys
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,            // Google API keys
  /\bAKIA[A-Z0-9]{16}\b/g,                  // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,        // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,      // GitHub fine-grained PATs
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,      // Slack tokens
  /\btracy-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\b/g, // Tracy access keys
  /\b[0-9a-fA-F]{32,}\b/g,                  // long hex (hashes, hex secrets)
  // Long mixed letter+digit token runs (JWT segments, base64 secrets). Requires
  // both cases/digits so ordinary words and file names don't get eaten.
  /\b(?=[A-Za-z0-9+/_=-]*[0-9])(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{30,}\b/g,
];

function scrubText(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[secret-masked]");
  return out;
}

// Scrub a messages array: mask secret-like strings in text, and drop inline
// image bytes entirely (they're big, and photos don't belong in text logs).
function scrubMessages(messages) {
  return (messages || []).map((m) => {
    if (!m) return m;
    if (typeof m.content === "string") return { ...m, content: scrubText(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((b) => {
          if (b?.type === "text") return { ...b, text: scrubText(b.text || "") };
          if (b?.type === "image") return { type: "image", note: "[image omitted from log]" };
          return b;
        }),
      };
    }
    return m;
  });
}

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
  const scrubbed = {
    ...entry,
    messages: scrubMessages(entry.messages),
    reply: entry.reply == null ? entry.reply : scrubText(entry.reply),
  };
  if (dbEnabled()) {
    logConversationToDb(scrubbed).catch((err) => {
      // If the DB write fails, don't lose the record — fall back to the file.
      console.error("DB log failed, falling back to file:", err.message);
      logToFile(scrubbed);
    });
  } else {
    logToFile(scrubbed);
  }
}
