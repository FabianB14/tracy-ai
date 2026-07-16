// Self-sufficiency log — records how each answer was produced, so you can see
// how often Tracy answers from her own knowledge vs. asking Claude.
//
// path values:
//   "kb-direct"  — returned a saved answer verbatim (no model call at all)
//   "kb-gemini"  — answered with the cheap model, grounded in her knowledge
//   "model"      — full Claude path (with tools)
//
// Postgres `answer_log` (or a JSON file locally). Aggregate only — no message
// content is stored here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "logs");
const FILE = path.join(DIR, "answerlog.json");

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS answer_log (
        id      BIGSERIAL PRIMARY KEY,
        ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id TEXT,
        surface TEXT,
        path    TEXT NOT NULL,
        score   REAL
      );
      CREATE INDEX IF NOT EXISTS answer_log_ts_idx ON answer_log (ts);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
function readStore() { try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")); } catch { /* ignore */ } return []; }
function writeStore(rows) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(rows)); }

// Record one answer. Best-effort, never throws.
export async function logAnswer({ userId, surface, path: p, score }) {
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query("INSERT INTO answer_log (user_id, surface, path, score) VALUES ($1, $2, $3, $4)",
        [userId || null, surface || null, p, typeof score === "number" ? score : null]);
    } else {
      const rows = readStore();
      rows.push({ ts: new Date().toISOString(), userId: userId || null, surface: surface || null, path: p, score: score ?? null });
      if (rows.length > 20000) rows.splice(0, rows.length - 20000);
      writeStore(rows);
    }
  } catch (err) { console.error("logAnswer failed:", err.message); }
}

function summarize(rows) {
  const total = rows.length;
  const kbDirect = rows.filter((r) => r.path === "kb-direct").length;
  const kbGemini = rows.filter((r) => r.path === "kb-gemini").length;
  const model = rows.filter((r) => r.path === "model").length;
  const fromKnowledge = kbDirect + kbGemini;
  return {
    total, fromKnowledge, fromModel: model, kbDirect, kbGemini,
    selfSufficientPct: total ? Math.round((fromKnowledge / total) * 100) : 0,
  };
}

// Aggregate stats: all-time + last 7 days. Never throws.
export async function getAnswerStats() {
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const all = (await query("SELECT path FROM answer_log")).rows;
      const recent = (await query("SELECT path FROM answer_log WHERE ts > now() - interval '7 days'")).rows;
      return { allTime: summarize(all), last7Days: summarize(recent) };
    }
    const rows = readStore();
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const recent = rows.filter((r) => r.ts && new Date(r.ts).getTime() >= cutoff);
    return { allTime: summarize(rows), last7Days: summarize(recent) };
  } catch (err) {
    console.error("getAnswerStats failed:", err.message);
    return { allTime: summarize([]), last7Days: summarize([]) };
  }
}
