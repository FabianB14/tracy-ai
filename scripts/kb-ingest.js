// Seed Tracy's knowledge base from markdown/text files (global scope), so
// retrieval has content from day one instead of only learning as she goes.
//
// Usage (needs the same env the server uses for embeddings + storage):
//   GEMINI_API_KEY=... [DATABASE_URL=...] node scripts/kb-ingest.js docs/ONBOARDING_ADMIN.md prompts/surfaces/developers.md
//
// Re-running is safe: near-duplicate chunks are skipped.

import { readFileSync } from "fs";
import { kbAdd, kbEnabled } from "../src/knowledge.js";

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: node scripts/kb-ingest.js <file...>"); process.exit(1); }
if (!kbEnabled()) { console.error("Knowledge base is not enabled — set GEMINI_API_KEY (and don't set TRACY_KB=off)."); process.exit(1); }

// Split a doc into ~900-char chunks on blank lines, remembering the nearest heading.
function chunk(text) {
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let buf = "", title = "";
  for (const p of paras) {
    if (/^#{1,6}\s/.test(p)) title = p.replace(/^#{1,6}\s+/, "").trim();
    if ((buf + "\n\n" + p).length > 900) { if (buf) chunks.push({ title, content: buf }); buf = p; }
    else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) chunks.push({ title, content: buf });
  return chunks;
}

let added = 0, skipped = 0;
for (const f of files) {
  const chunks = chunk(readFileSync(f, "utf8"));
  for (const c of chunks) {
    const ok = await kbAdd({ scope: "global", kind: "doc", question: c.title || f, content: c.content });
    ok ? added++ : skipped++;
    process.stdout.write(ok ? "." : "x");
  }
}
console.log(`\nDone. Added ${added}, skipped ${skipped} (duplicates/empties).`);
process.exit(0);
