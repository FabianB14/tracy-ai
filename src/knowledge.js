// Tracy's knowledge base (RAG) — her own growing memory of answers and facts.
//
// The loop: on each question she retrieves the most relevant things she's
// learned and answers with them in context; after a good answer she saves it
// back, so next time she knows it without leaning as hard on Claude.
//
// Stored as embeddings + text in Postgres (or a JSON file locally). Similarity
// is plain cosine in JS — no pgvector required, which keeps it portable; for a
// large base you'd later switch to a vector index.
//
// IMPORTANT: only NON-DYNAMIC answers are saved (see server.js). Live data
// (stats, web search, current events) must never be cached as "knowledge" — it
// goes stale. The retrieval note also tells Tracy to prefer tools for fresh data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";
import { embed, embeddingsConfigured } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "logs");
const FILE = path.join(DIR, "knowledge.json");

export function kbEnabled() {
  return (process.env.TRACY_KB || "on").toLowerCase() !== "off" && embeddingsConfigured();
}

// ---- storage ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id        BIGSERIAL PRIMARY KEY,
        ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
        scope     TEXT NOT NULL DEFAULT 'global',
        kind      TEXT NOT NULL DEFAULT 'qa',
        question  TEXT,
        content   TEXT NOT NULL,
        embedding JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_scope_idx ON knowledge (scope);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
function readStore() { try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")); } catch { /* ignore */ } return []; }
function writeStore(rows) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(rows)); }

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Pull candidate rows for the given scopes (global + this user).
async function candidates(scopes) {
  if (dbEnabled()) {
    await ensureSchema();
    const { rows } = await query(
      "SELECT question, content, embedding FROM knowledge WHERE scope = ANY($1) ORDER BY id DESC LIMIT 2000",
      [scopes]);
    return rows.map((r) => ({ question: r.question, content: r.content, embedding: r.embedding }));
  }
  return readStore().filter((e) => scopes.includes(e.scope));
}

// Retrieve the top-k most relevant entries for a query. Returns [{question, content, score}].
export async function kbSearch(text, { userId, k = 4, minScore = 0.76 } = {}) {
  if (!kbEnabled() || !text) return [];
  const vec = await embed(text);
  if (!vec) return [];
  const scopes = ["global"];
  if (userId) scopes.push(userId);
  const cand = await candidates(scopes);
  const scored = cand
    .map((e) => ({ question: e.question, content: e.content, score: Array.isArray(e.embedding) ? cosine(vec, e.embedding) : 0 }))
    .sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= minScore).slice(0, k);
}

// Save a piece of knowledge. Embeds it, skips near-duplicates in the same scope.
export async function kbAdd({ scope = "global", kind = "qa", question = "", content = "" }) {
  if (!kbEnabled() || !String(content).trim()) return false;
  const vec = await embed((question || content));
  if (!vec) return false;
  try {
    const cand = await candidates([scope]);
    for (const e of cand) { if (Array.isArray(e.embedding) && cosine(vec, e.embedding) > 0.95) return false; }
  } catch { /* dedup best-effort */ }
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query(
        "INSERT INTO knowledge (scope, kind, question, content, embedding) VALUES ($1, $2, $3, $4, $5)",
        [scope, kind, question || null, content, JSON.stringify(vec)]);
    } else {
      const rows = readStore();
      rows.push({ id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, scope, kind, question, content, embedding: vec });
      if (rows.length > 5000) rows.splice(0, rows.length - 5000);
      writeStore(rows);
    }
    return true;
  } catch (err) { console.error("kbAdd failed:", err.message); return false; }
}

// Split a document into ~900-char chunks on blank lines, remembering the nearest
// heading as each chunk's title. Used by the UI upload + the ingest script.
export function chunkText(text) {
  const paras = String(text).replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let buf = "", title = "";
  for (const p of paras) {
    if (/^#{1,6}\s/.test(p)) title = p.replace(/^#{1,6}\s+/, "").trim();
    if ((buf + "\n\n" + p).length > 900) { if (buf) chunks.push({ title, content: buf }); buf = p; }
    else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) chunks.push({ title, content: buf });
  return chunks;
}

// Ingest a whole document into the knowledge base as chunks. Returns counts.
export async function kbIngestDoc({ scope = "global", title = "", text = "" }) {
  if (!kbEnabled() || !String(text).trim()) return { added: 0, skipped: 0 };
  let added = 0, skipped = 0;
  for (const c of chunkText(text)) {
    const ok = await kbAdd({ scope, kind: "doc", question: c.title || title, content: c.content });
    ok ? added++ : skipped++;
  }
  return { added, skipped };
}

// Format retrieved knowledge as a system-prompt block. "" when there's nothing.
export function formatKnowledgeBlock(hits) {
  if (!hits || !hits.length) return "";
  const items = hits.map((h) => {
    const q = h.question ? `Q: ${h.question}\n  ` : "";
    return `- ${q}${h.content}`.slice(0, 1200);
  });
  return (
    "## From your knowledge base (things you've learned before)\n" +
    items.join("\n") +
    "\n\n(These are notes and past answers you saved. Use them when they're " +
    "relevant and still accurate. If the question needs live or current data " +
    "— prices, stats, recent events — use your tools instead of these notes.)"
  );
}
