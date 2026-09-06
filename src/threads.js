// Saved conversations ("threads") — pick up where you left off.
//
// The web client keeps the conversation in memory; this persists it per user
// so it survives a refresh, a phone switch, or a week away. Auto-saved after
// every exchange; resumable from Settings → Conversations or automatically on
// load. Same two backends as memory/logging:
//   - DATABASE_URL set   → Postgres `chat_threads`
//   - DATABASE_URL unset → logs/threads.json (local dev)
//
// A thread: { id, userId, surface, title, messages, createdAt, updatedAt }.
// Threads are private to their userId; every read/write is scoped by it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import { dbEnabled, query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "logs");
const FILE = path.join(DIR, "threads.json");

const MAX_THREADS_PER_USER = 200;
const MAX_MESSAGES = 400;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        surface    TEXT,
        title      TEXT,
        messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chat_threads_user_idx ON chat_threads (user_id, updated_at DESC);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

function readStore() { try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8")); } catch { /* ignore */ } return []; }
function writeStore(rows) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(rows)); }

const newId = () => "t-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");

// Derive a title from the first user message when none was given.
function autoTitle(messages) {
  const first = (messages || []).find((m) => m && m.role === "user");
  const text = first ? (typeof first.content === "string" ? first.content
    : (first.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ")) : "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t ? (t.length > 60 ? t.slice(0, 57) + "…" : t) : "New conversation";
}

// Keep only what the client needs to resume: role + text content. Images are
// dropped (they're large and a resumed chat doesn't need to re-send them).
function sanitize(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
    if (content.trim()) out.push({ role: m.role, content });
  }
  return out.slice(-MAX_MESSAGES);
}

export async function listThreads(userId, limit = 30) {
  if (!userId) return [];
  if (dbEnabled()) {
    await ensureSchema();
    const { rows } = await query(
      `SELECT id, surface, title, jsonb_array_length(messages) AS count, updated_at
       FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, limit]);
    return rows.map((r) => ({ id: r.id, surface: r.surface, title: r.title, count: Number(r.count), updatedAt: r.updated_at }));
  }
  return readStore().filter((t) => t.userId === userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit)
    .map((t) => ({ id: t.id, surface: t.surface, title: t.title, count: t.messages.length, updatedAt: t.updatedAt }));
}

export async function getThread(userId, id) {
  if (!userId || !id) return null;
  if (dbEnabled()) {
    await ensureSchema();
    const { rows } = await query(
      "SELECT id, surface, title, messages, updated_at FROM chat_threads WHERE user_id = $1 AND id = $2", [userId, id]);
    const r = rows[0];
    return r ? { id: r.id, surface: r.surface, title: r.title, messages: r.messages, updatedAt: r.updated_at } : null;
  }
  const t = readStore().find((x) => x.userId === userId && x.id === id);
  return t ? { id: t.id, surface: t.surface, title: t.title, messages: t.messages, updatedAt: t.updatedAt } : null;
}

// Create or update. Returns { id, title }.
export async function saveThread({ id, userId, surface, title, messages }) {
  if (!userId) throw new Error("userId required");
  const msgs = sanitize(messages);
  if (!msgs.length) throw new Error("nothing to save");
  const tid = id || newId();
  const finalTitle = (title && String(title).trim()) || autoTitle(msgs);
  if (dbEnabled()) {
    await ensureSchema();
    await query(
      `INSERT INTO chat_threads (id, user_id, surface, title, messages) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         surface = EXCLUDED.surface, title = EXCLUDED.title, messages = EXCLUDED.messages, updated_at = now()
       WHERE chat_threads.user_id = EXCLUDED.user_id`,
      [tid, userId, surface || null, finalTitle, JSON.stringify(msgs)]);
    // Light housekeeping: cap threads per user.
    await query(
      `DELETE FROM chat_threads WHERE user_id = $1 AND id IN (
         SELECT id FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC OFFSET $2)`,
      [userId, MAX_THREADS_PER_USER]).catch(() => {});
    return { id: tid, title: finalTitle };
  }
  const rows = readStore();
  const now = new Date().toISOString();
  const i = rows.findIndex((t) => t.id === tid && t.userId === userId);
  const rec = { id: tid, userId, surface: surface || null, title: finalTitle, messages: msgs,
                createdAt: i >= 0 ? rows[i].createdAt : now, updatedAt: now };
  if (i >= 0) rows[i] = rec; else rows.push(rec);
  writeStore(rows);
  return { id: tid, title: finalTitle };
}

export async function deleteThread(userId, id) {
  if (!userId || !id) return false;
  if (dbEnabled()) {
    await ensureSchema();
    const { rowCount } = await query("DELETE FROM chat_threads WHERE user_id = $1 AND id = $2", [userId, id]);
    return rowCount > 0;
  }
  const rows = readStore();
  const next = rows.filter((t) => !(t.userId === userId && t.id === id));
  writeStore(next);
  return next.length < rows.length;
}
