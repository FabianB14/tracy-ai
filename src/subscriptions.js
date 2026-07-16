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
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS time      TEXT NOT NULL DEFAULT '08:00';
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tz        TEXT NOT NULL DEFAULT 'America/New_York';
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_sent TEXT;
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

const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/New_York";

function normalize(row) {
  if (!row) return null;
  return {
    email: row.email || "",
    apps: Array.isArray(row.apps) ? row.apps : [],
    digest: Boolean(row.digest),
    time: row.time || "08:00",
    tz: row.tz || DEFAULT_TZ,
    last_sent: row.last_sent || null,
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
export async function setSubscription(userId, { email, apps, digest, time, tz }) {
  if (!userId) return false;
  const clean = {
    email: String(email || "").trim(),
    apps: Array.isArray(apps) ? apps.map(String) : [],
    digest: Boolean(digest),
    time: String(time || "08:00").trim(),
    tz: String(tz || DEFAULT_TZ).trim(),
  };
  try {
    if (dbEnabled()) {
      await ensureSchema();
      // Changing prefs clears last_sent so a new/edited schedule can fire today.
      await query(
        `INSERT INTO subscriptions (user_id, email, apps, digest, time, tz, last_sent, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, now())
         ON CONFLICT (user_id) DO UPDATE
           SET email = EXCLUDED.email, apps = EXCLUDED.apps, digest = EXCLUDED.digest,
               time = EXCLUDED.time, tz = EXCLUDED.tz, last_sent = NULL, updated_at = now()`,
        [userId, clean.email, JSON.stringify(clean.apps), clean.digest, clean.time, clean.tz]
      );
    } else {
      const store = readFileStore();
      store[userId] = { ...clean, last_sent: null };
      writeFileStore(store);
    }
    return true;
  } catch (err) {
    console.error("setSubscription failed:", err.message);
    return false;
  }
}

// Record that a user's digest was sent for a given local date (dedupe per day).
export async function markSent(userId, localDate) {
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query("UPDATE subscriptions SET last_sent = $2 WHERE user_id = $1", [userId, localDate]);
    } else {
      const store = readFileStore();
      if (store[userId]) { store[userId].last_sent = localDate; writeFileStore(store); }
    }
  } catch (err) {
    console.error("markSent failed:", err.message);
  }
}

// Current local date + HH:MM in a timezone (falls back to UTC on a bad tz).
export function localNow(tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const hh = p.hour === "24" ? "00" : p.hour; // some environments emit "24" at midnight
    return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${hh}:${p.minute}` };
  } catch {
    const iso = new Date().toISOString();
    return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
  }
}

// Due if we've reached the user's local send time today and haven't sent yet.
export function isDue(sub, now = null) {
  const t = now || localNow(sub.tz);
  return t.hhmm >= (sub.time || "08:00") && sub.last_sent !== t.date;
}

// Everyone due a daily digest: digest enabled, an email set, and ≥1 app.
// Returns [{ userId, email, apps }]. Never throws.
export async function listDigestSubscribers() {
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const { rows } = await query(
        `SELECT user_id, email, apps, time, tz, last_sent FROM subscriptions
         WHERE digest = true AND email <> '' AND jsonb_array_length(apps) > 0`
      );
      return rows.map((r) => ({
        userId: r.user_id, email: r.email, apps: Array.isArray(r.apps) ? r.apps : [],
        time: r.time || "08:00", tz: r.tz || DEFAULT_TZ, last_sent: r.last_sent || null,
      }));
    }
    const store = readFileStore();
    return Object.entries(store)
      .filter(([, s]) => s && s.digest && s.email && Array.isArray(s.apps) && s.apps.length)
      .map(([userId, s]) => ({
        userId, email: s.email, apps: s.apps,
        time: s.time || "08:00", tz: s.tz || DEFAULT_TZ, last_sent: s.last_sent || null,
      }));
  } catch (err) {
    console.error("listDigestSubscribers failed:", err.message);
    return [];
  }
}
