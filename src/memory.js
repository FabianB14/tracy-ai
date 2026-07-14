// Per-user memory — how Tracy remembers people across sessions.
//
// Memory is GLOBAL per user (keyed by userId), not per surface: Tracy is the
// same assistant everywhere, so what she remembers about you carries across
// BabyResell, the desktop, a game, etc.
//
// Two backends, same as logging:
//   - DATABASE_URL set  → Postgres `user_memory` table (survives redeploys).
//   - DATABASE_URL unset → logs/memory.json (zero-config local dev).
//
// She READS memory at the start of each chat (injected into her system prompt)
// and WRITES it via the `remember` tool (see src/tools.js), so she decides what
// is worth keeping. Same consent caveat as logging applies before production.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEM_DIR = path.join(__dirname, "..", "logs");
const MEM_FILE = path.join(MEM_DIR, "memory.json");

const MAX_ITEMS = 40; // cap how much memory we inject / keep per user

// ---- Postgres backend ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_memory_user_id_idx ON user_memory (user_id);
    `).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---- File backend (local dev) ----
function readFileStore() {
  try {
    if (existsSync(MEM_FILE)) return JSON.parse(readFileSync(MEM_FILE, "utf-8"));
  } catch { /* ignore corrupt file */ }
  return {};
}
function writeFileStore(store) {
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(MEM_FILE, JSON.stringify(store, null, 2));
}

// ---- Public API ----

// Save a durable fact/preference about a user. Best-effort; never throws.
export async function addMemory(userId, content) {
  if (!userId || !content || !String(content).trim()) return false;
  const text = String(content).trim();
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query("INSERT INTO user_memory (user_id, content) VALUES ($1, $2)", [userId, text]);
    } else {
      const store = readFileStore();
      (store[userId] ||= []).push({ content: text, ts: new Date().toISOString() });
      if (store[userId].length > MAX_ITEMS) store[userId] = store[userId].slice(-MAX_ITEMS);
      writeFileStore(store);
    }
    return true;
  } catch (err) {
    console.error("addMemory failed:", err.message);
    return false;
  }
}

// Fetch a user's memory items (oldest → newest), capped. Never throws.
export async function getMemories(userId, limit = MAX_ITEMS) {
  if (!userId) return [];
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const { rows } = await query(
        "SELECT content FROM user_memory WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
        [userId, limit]
      );
      return rows.map((r) => r.content).reverse();
    }
    const store = readFileStore();
    return (store[userId] || []).slice(-limit).map((m) => m.content);
  } catch (err) {
    console.error("getMemories failed:", err.message);
    return [];
  }
}

// Format memory items as a system-prompt section. "" when there's nothing.
export function formatMemoryBlock(items) {
  if (!items || !items.length) return "";
  return (
    "## What you remember about this user\n" +
    items.map((i) => `- ${i}`).join("\n") +
    "\n\n(These are notes you saved in past conversations with this user. Use " +
    "them naturally to personalize your help — don't recite them back verbatim.)"
  );
}
