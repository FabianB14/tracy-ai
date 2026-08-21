// The Interverse brain, plugged into Tracy.
//
// Tier 1 (files): brain/entities/ is read off disk, filtered on tracy_ready +
// confidence, and matched by keyword (title/id/alias/tag). Works with zero
// infrastructure; entities deploy with the app.
//
// Tier 2 (embeddings + Postgres): entities are embedded (Gemini, same model as
// the knowledge base) and upserted into a brain_entities table. Retrieval then
// ALSO matches by meaning, so "what's our company strategy?" finds the
// ecosystem entity without naming it. Because the daily brain loop can run the
// sync from anywhere (scripts/brain-sync.js), deployed Tracy picks up new
// entities within a minute of a sync, no redeploy needed. The server also
// syncs at boot, so a plain deploy refreshes the table too.
//
// Retrieval = keyword hits first (precise), then semantic hits above
// BRAIN_MIN_SCORE (recall), deduped, capped at BRAIN_MAX_ENTITIES. Everything
// degrades gracefully: no DB -> disk keyword matching; no Gemini key -> no
// semantic layer; a bad entity file never breaks loading.

import crypto from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";
import { embeddingsConfigured, embed } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTITIES_DIR = path.join(__dirname, "..", "brain", "entities");

const MIN_CONFIDENCE = Number(process.env.BRAIN_MIN_CONFIDENCE || 0.7);
const MAX_INJECT = Number(process.env.BRAIN_MAX_ENTITIES || 3);
const MIN_SCORE = Number(process.env.BRAIN_MIN_SCORE || 0.6); // query-to-summary cosine
const CACHE_TTL_MS = 60000;

// ---- Frontmatter parsing (same dialect the brain's graph builder reads) ----
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(strip(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = strip(kv[2]);
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      }
      fm[currentKey] = val;
    }
  }
  return fm;
}
const strip = (s) => s.replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");

// ---- Disk entities (tier 1 + the sync source) ----
let diskCache = { ts: 0, entities: [] };

function loadEntities() {
  const now = Date.now();
  if (now - diskCache.ts < CACHE_TTL_MS) return diskCache.entities;
  const entities = [];
  try {
    if (existsSync(ENTITIES_DIR)) {
      for (const f of readdirSync(ENTITIES_DIR)) {
        if (!f.endsWith(".md")) continue;
        try {
          const text = readFileSync(path.join(ENTITIES_DIR, f), "utf8");
          const fm = parseFrontmatter(text);
          const ready = fm.tracy_ready === "true" || fm.tracy_ready === true;
          const confidence = Number(fm.confidence || 0);
          if (!ready || !(confidence >= MIN_CONFIDENCE)) continue;
          const body = text.replace(/^---[\s\S]*?---\s*/, "").trim()
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => label || id);
          const terms = [
            String(fm.id || ""), String(fm.title || ""),
            ...(Array.isArray(fm.aliases) ? fm.aliases : []),
            ...(Array.isArray(fm.tags) ? fm.tags : []),
          ].filter(Boolean);
          entities.push({
            id: String(fm.id || f.replace(/\.md$/, "")),
            title: String(fm.title || fm.id || f),
            terms,
            confidence,
            body,
          });
        } catch { /* one bad file never breaks the brain */ }
      }
    }
  } catch (err) {
    console.error("brain load failed:", err.message);
  }
  diskCache = { ts: now, entities };
  return entities;
}

export function brainEnabled() {
  return loadEntities().length > 0 || rowCache.rows.length > 0;
}

// ---- Postgres layer (tier 2) ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS brain_entities (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        terms      JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence REAL NOT NULL,
        body       TEXT NOT NULL,
        hash       TEXT NOT NULL,
        embedding  JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const entityHash = (e) =>
  crypto.createHash("sha256").update([e.title, e.confidence, e.body, e.terms.join("|")].join("\n")).digest("hex");

// Sync disk entities into the table. Upsert-only by default: a server whose
// checkout is OLDER than the loop's must never delete the loop's fresh rows.
// prune=true (the CLI's flag, run where the disk is the source of truth) also
// removes rows whose file is gone. Embeds only new/changed entities.
export async function syncBrain({ prune = false } = {}) {
  if (!dbEnabled()) return { synced: 0, reason: "no DATABASE_URL" };
  await ensureSchema();
  const disk = loadEntities();
  let synced = 0, embedded = 0;
  const { rows } = await query("SELECT id, hash, embedding IS NOT NULL AS has_emb FROM brain_entities");
  const existing = new Map(rows.map((r) => [r.id, r]));

  for (const e of disk) {
    const h = entityHash(e);
    const cur = existing.get(e.id);
    const needsEmbed = embeddingsConfigured() && (!cur || cur.hash !== h || !cur.has_emb);
    if (cur && cur.hash === h && !needsEmbed) continue;
    let vector = null;
    if (needsEmbed) {
      try {
        vector = await embed(`${e.title}\n${e.terms.join(", ")}\n${e.body}`.slice(0, 8000));
        if (vector) embedded++;
      } catch (err) { console.error(`brain embed failed (${e.id}):`, err.message); }
    }
    await query(
      `INSERT INTO brain_entities (id, title, terms, confidence, body, hash, embedding, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, terms = EXCLUDED.terms, confidence = EXCLUDED.confidence,
         body = EXCLUDED.body, hash = EXCLUDED.hash,
         embedding = COALESCE(EXCLUDED.embedding, brain_entities.embedding),
         updated_at = now()`,
      [e.id, e.title, JSON.stringify(e.terms), e.confidence, e.body, h, vector ? JSON.stringify(vector) : null],
    );
    synced++;
  }

  let pruned = 0;
  if (prune) {
    const diskIds = new Set(disk.map((e) => e.id));
    for (const id of existing.keys()) {
      if (!diskIds.has(id)) { await query("DELETE FROM brain_entities WHERE id = $1", [id]); pruned++; }
    }
  }
  rowCache.ts = 0; // next retrieval re-reads
  return { synced, embedded, pruned, total: disk.length };
}

// Clear stored entity vectors (used when the embedding model changes — the
// next syncBrain re-embeds everything with the current model).
export async function resetBrainEmbeddings() {
  if (!dbEnabled()) return;
  await ensureSchema();
  await query("UPDATE brain_entities SET embedding = NULL");
  rowCache.ts = 0;
}

let rowCache = { ts: 0, rows: [] };
async function getDbRows() {
  if (!dbEnabled()) return [];
  const now = Date.now();
  if (now - rowCache.ts < CACHE_TTL_MS) return rowCache.rows;
  try {
    await ensureSchema();
    const { rows } = await query("SELECT id, title, terms, confidence, body, embedding FROM brain_entities WHERE confidence >= $1", [MIN_CONFIDENCE]);
    rowCache = {
      ts: now,
      rows: rows.map((r) => ({
        id: r.id, title: r.title,
        terms: Array.isArray(r.terms) ? r.terms : [],
        confidence: Number(r.confidence), body: r.body,
        embedding: Array.isArray(r.embedding) ? r.embedding : null,
      })),
    };
  } catch (err) {
    console.error("brain db read failed:", err.message);
    rowCache.ts = now; // don't hammer a broken DB
  }
  return rowCache.rows;
}

// ---- Matching ----
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// STOP_TERMS never match on their own: people address Tracy by name in most
// voice messages, and her core prompt already covers who she is.
const STOP_TERMS = new Set(["tracy"]);

function keywordMatch(text, entities) {
  const hay = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const scored = [];
  for (const e of entities) {
    const terms = e.terms
      .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
      .filter((t) => t.length >= 3 && !STOP_TERMS.has(t));
    let hits = 0;
    for (const t of new Set(terms)) if (hay.includes(" " + t + " ")) hits++;
    if (hits > 0) scored.push({ e, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || b.e.confidence - a.e.confidence);
  return scored.map((s) => s.e);
}

async function matchBrain(text) {
  const dbRows = await getDbRows();
  const pool = dbRows.length ? dbRows : loadEntities();

  // Layer 1: exact-name keyword hits (work with or without embeddings).
  const picked = keywordMatch(text, pool);

  // Layer 2: semantic hits by meaning (needs DB rows with embeddings + a key).
  if (embeddingsConfigured() && dbRows.length && picked.length < MAX_INJECT) {
    try {
      const qv = await embed(String(text).slice(0, 2000));
      if (qv) {
        const sem = dbRows
          .filter((r) => r.embedding)
          .map((r) => ({ e: r, score: cosine(qv, r.embedding) }))
          .filter((s) => s.score >= MIN_SCORE)
          .sort((a, b) => b.score - a.score);
        for (const s of sem) {
          if (!picked.some((p) => p.id === s.e.id)) picked.push(s.e);
        }
      }
    } catch (err) { console.error("brain semantic match failed:", err.message); }
  }
  return picked.slice(0, MAX_INJECT);
}

// Build the system-prompt block for a message (empty string when nothing matches).
export async function formatBrainBlock(text) {
  const matched = await matchBrain(text);
  if (!matched.length) return "";
  const parts = matched.map((e) => `### ${e.title}\n${e.body}`);
  return (
    "## Interverse brain (curated knowledge)\n" +
    "Verified knowledge from Interverse's curated knowledge base. Treat it as " +
    "accurate and current, and prefer it over guesses about Interverse's own " +
    "products and plans.\n\n" +
    parts.join("\n\n")
  );
}
