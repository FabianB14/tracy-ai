#!/usr/bin/env node
// Sync brain/entities/ into the brain_entities table (tier 2 of "plugging the
// brain into Tracy"): embeds each tracy_ready entity and upserts it so the
// DEPLOYED Tracy picks it up within a minute, no redeploy needed.
//
// Usage:
//   node scripts/brain-sync.js           # upsert new/changed entities
//   node scripts/brain-sync.js --prune   # also delete rows whose file is gone
//                                        # (run only where brain/ is up to date)
//
// Needs env: DATABASE_URL (the Tracy Postgres) and GEMINI_API_KEY (embeddings).
// Without DATABASE_URL it does nothing; without GEMINI_API_KEY it upserts
// text-only (keyword matching still works, semantic matching waits for a key).

import "dotenv/config";
import { syncBrain } from "../src/brain.js";

const prune = process.argv.includes("--prune");
const r = await syncBrain({ prune });
if (r.reason) {
  console.log(`brain-sync: skipped (${r.reason})`);
} else {
  console.log(`brain-sync: ${r.synced} upserted, ${r.embedded} embedded, ${r.pruned || 0} pruned (${r.total} eligible on disk)`);
}
process.exit(0);
