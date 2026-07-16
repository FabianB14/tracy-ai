// Notification subscriptions — who wants what, per userId.
//
// Each user (operator/admin) can opt into a daily digest for the apps they care
// about, delivered to their email. Same two backends as memory/logging:
//   - DATABASE_URL set   → Postgres `subscriptions` table
//   - DATABASE_URL unset → logs/subscriptions.json (local dev)
//
// A subscription row: { userId, email, apps: [...], digest: bool }.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "logs");
const FILE = path.join(DIR, "subscriptions.json");

// ---- Postgres backend ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id    TEXT PRIMARY KEY,
        email      TEXT,
        apps       JSONB NOT NULL DEFAULT '[]'::jsonb,
        digest     BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---- File backend ----
function readFileStore() {
  try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")); } catch { /* ignore */ }
  return {};
}
function writeFileStore(store) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function normalize(row) {
  if (!row) return null;
  return {
    email: row.email || "",
    apps: Array.isArray(row.apps) ? row.apps : [],
    digest: Boolean(row.digest),
  };
}

// Read one user's subscription (or null if none saved). Never throws.
export async function getSubscription(userId) {
  if (!userId) return null;
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const { rows } = await query("SELECT email, apps, digest FROM subscriptions WHERE user_id = $1", [userId]);
      return normalize(rows[0]);
    }
    return normalize(readFileStore()[userId]);
  } catch (err) {
    console.error("getSubscription failed:", err.message);
    return null;
  }
}

// Create/replace a user's subscription. Best-effort; returns true on success.
export async function setSubscription(userId, { email, apps, digest }) {
  if (!userId) return false;
  const clean = {
    email: String(email || "").trim(),
    apps: Array.isArray(apps) ? apps.map(String) : [],
    digest: Boolean(digest),
  };
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query(
        `INSERT INTO subscriptions (user_id, email, apps, digest, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
           SET email = EXCLUDED.email, apps = EXCLUDED.apps,
               digest = EXCLUDED.digest, updated_at = now()`,
        [userId, clean.email, JSON.stringify(clean.apps), clean.digest]
      );
    } else {
      const store = readFileStore();
      store[userId] = clean;
      writeFileStore(store);
    }
    return true;
  } catch (err) {
    console.error("setSubscription failed:", err.message);
    return false;
  }
}

// Everyone due a daily digest: digest enabled, an email set, and ≥1 app.
// Returns [{ userId, email, apps }]. Never throws.
export async function listDigestSubscribers() {
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const { rows } = await query(
        `SELECT user_id, email, apps FROM subscriptions
         WHERE digest = true AND email <> '' AND jsonb_array_length(apps) > 0`
      );
      return rows.map((r) => ({ userId: r.user_id, email: r.email, apps: Array.isArray(r.apps) ? r.apps : [] }));
    }
    const store = readFileStore();
    return Object.entries(store)
      .filter(([, s]) => s && s.digest && s.email && Array.isArray(s.apps) && s.apps.length)
      .map(([userId, s]) => ({ userId, email: s.email, apps: s.apps }));
  } catch (err) {
    console.error("listDigestSubscribers failed:", err.message);
    return [];
  }
}
