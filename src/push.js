// Web Push — send notifications to a user's phone/desktop (the installed PWA).
//
// Gated on VAPID keys. Generate a pair once with `node scripts/genvapid.js` and
// set them as env (never commit the private key):
//   VAPID_PUBLIC_KEY   shared with the browser so it can subscribe
//   VAPID_PRIVATE_KEY  secret; signs push messages
//   VAPID_SUBJECT      a mailto: or https: contact URL (default mailto below)
//
// Subscriptions are stored per user (Postgres + file fallback, same as the rest).
// iOS note: web push only reaches iPhones for a PWA the user has INSTALLED
// (Add to Home Screen) on iOS 16.4+, launched from the home screen.

import webpush from "web-push";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "logs");
const FILE = path.join(DIR, "push.json");

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:notifications@interverse.app";

export function pushConfigured() { return Boolean(PUBLIC && PRIVATE); }
export function getPublicKey() { return PUBLIC; }

if (pushConfigured()) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); }
  catch (err) { console.error("VAPID setup failed:", err.message); }
}

// ---- storage ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        sub        JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions (user_id);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
function readStore() { try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")); } catch { /* ignore */ } return {}; }
function writeStore(s) { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2)); }

export async function savePushSub(userId, sub) {
  if (!userId || !sub || !sub.endpoint) return false;
  try {
    if (dbEnabled()) {
      await ensureSchema();
      await query(
        `INSERT INTO push_subscriptions (endpoint, user_id, sub) VALUES ($1, $2, $3)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, sub = EXCLUDED.sub`,
        [sub.endpoint, userId, JSON.stringify(sub)]);
    } else {
      const s = readStore(); (s[userId] ||= {})[sub.endpoint] = sub; writeStore(s);
    }
    return true;
  } catch (err) { console.error("savePushSub failed:", err.message); return false; }
}

export async function removePushSub(endpoint) {
  if (!endpoint) return;
  try {
    if (dbEnabled()) { await ensureSchema(); await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]); }
    else { const s = readStore(); for (const u of Object.keys(s)) delete s[u][endpoint]; writeStore(s); }
  } catch (err) { console.error("removePushSub failed:", err.message); }
}

export async function getPushSubs(userId) {
  if (!userId) return [];
  try {
    if (dbEnabled()) {
      await ensureSchema();
      const { rows } = await query("SELECT sub FROM push_subscriptions WHERE user_id = $1", [userId]);
      return rows.map((r) => r.sub);
    }
    return Object.values(readStore()[userId] || {});
  } catch (err) { console.error("getPushSubs failed:", err.message); return []; }
}

// Send a payload to every device a user has registered. Prunes dead subscriptions
// (404/410 = the browser dropped it). Returns how many were delivered.
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured()) return 0;
  const subs = await getPushSubs(userId);
  let sent = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); sent++; }
    catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) await removePushSub(sub.endpoint);
      else console.error("push send failed:", err && err.message);
    }
  }
  return sent;
}
