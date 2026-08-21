// The Interverse brain, plugged into Tracy (tier 1: file read).
//
// brain/entities/ holds distilled, first-party-or-sourced knowledge curated by
// the daily brain loop (see brain/README.md). This module loads those entities
// and injects the relevant ones into Tracy's system prompt, so what the brain
// learns, Tracy knows — with zero extra infrastructure. Entities deploy with
// the app; a redeploy is how production Tracy picks up new brain knowledge.
//
// Filtering: only entities with tracy_ready: true AND confidence >= the
// threshold (env BRAIN_MIN_CONFIDENCE, default 0.7) are eligible. Matching is
// cheap and transparent: an entity is injected when the user's message mentions
// its title, id, an alias, or a tag. Entities are capped small by the brain's
// own rules (< 300 words), so injecting a few is cheap.

import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTITIES_DIR = path.join(__dirname, "..", "brain", "entities");

const MIN_CONFIDENCE = Number(process.env.BRAIN_MIN_CONFIDENCE || 0.7);
const MAX_INJECT = Number(process.env.BRAIN_MAX_ENTITIES || 3);
const CACHE_TTL_MS = 60000; // re-scan at most once a minute (cheap local dev reloads)

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

// ---- Load + cache ----
let cache = { ts: 0, entities: [] };

function loadEntities() {
  const now = Date.now();
  if (now - cache.ts < CACHE_TTL_MS) return cache.entities;
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
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => label || id); // unwrap wikilinks
          entities.push({
            id: String(fm.id || f.replace(/\.md$/, "")),
            title: String(fm.title || fm.id || f),
            aliases: Array.isArray(fm.aliases) ? fm.aliases : [],
            tags: Array.isArray(fm.tags) ? fm.tags : [],
            confidence,
            body,
          });
        } catch { /* one bad file never breaks the brain */ }
      }
    }
  } catch (err) {
    console.error("brain load failed:", err.message);
  }
  cache = { ts: now, entities };
  return entities;
}

export function brainEnabled() {
  return loadEntities().length > 0;
}

// Words from the message, lowercased; entity terms match as whole words so
// "part" alone doesn't drag in PartOut but "partout" or "part out" does.
// STOP_TERMS never match on their own: people address Tracy by name in most
// voice messages, and her core prompt already covers who she is — injecting
// her entity on every "Tracy, ..." would be pure token waste.
const STOP_TERMS = new Set(["tracy"]);
function matchEntities(text) {
  const hay = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const scored = [];
  for (const e of loadEntities()) {
    const terms = [e.id, e.title, ...e.aliases, ...e.tags]
      .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
      .filter((t) => t.length >= 3 && !STOP_TERMS.has(t));
    let hits = 0;
    for (const t of new Set(terms)) {
      if (hay.includes(" " + t + " ")) hits++;
    }
    if (hits > 0) scored.push({ e, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || b.e.confidence - a.e.confidence);
  return scored.slice(0, MAX_INJECT).map((s) => s.e);
}

// Build the system-prompt block for a message (empty string when nothing matches).
export function formatBrainBlock(text) {
  const matched = matchEntities(text);
  if (!matched.length) return "";
  const parts = matched.map((e) =>
    `### ${e.title}\n${e.body}`
  );
  return (
    "## Interverse brain (curated knowledge)\n" +
    "Verified knowledge from Interverse's curated knowledge base. Treat it as " +
    "accurate and current, and prefer it over guesses about Interverse's own " +
    "products and plans.\n\n" +
    parts.join("\n\n")
  );
}
