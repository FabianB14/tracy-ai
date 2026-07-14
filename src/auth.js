// Access-key auth for Tracy's backend.
//
// Goal: anyone with the URL can load the page, but only people with a valid
// ACCESS KEY can actually talk to Tracy. A key is redeemed once per browser for
// a signed session token (stored client-side); a new browser must redeem again.
//
// Enabled only when AUTH_SECRET is set — so deploying this doesn't lock anyone
// out until you configure it. Turn it on by setting, on Render:
//   AUTH_SECRET   a long random string (signs session tokens)
//   ACCESS_KEYS   optional comma-separated keys (in addition to DB keys)
// Generate managed keys with: node scripts/genkey.js "label"  (needs DATABASE_URL)
//
// Keys are never stored in plaintext — only their SHA-256 hash. Tokens are
// stateless HMACs (no session table); revoking a DB key invalidates its tokens
// within ~60s (the valid-key cache TTL).

import crypto from "crypto";
import { dbEnabled, query } from "./db.js";

const SECRET = process.env.AUTH_SECRET || "";
const TOKEN_MAX_AGE_MS = 180 * 24 * 3600 * 1000; // 180 days

export function authEnabled() { return Boolean(SECRET); }

function hashKey(k) { return crypto.createHash("sha256").update(String(k)).digest("hex"); }

// ---- Session tokens (stateless HMAC) ----
export function issueToken(keyHash) {
  const payload = Buffer.from(JSON.stringify({ kh: keyHash, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!data || !data.kh || !data.iat) return null;
  if (Date.now() - data.iat > TOKEN_MAX_AGE_MS) return null;
  return data;
}

// ---- Valid keys (env + DB), cached ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS access_keys (
        id           BIGSERIAL PRIMARY KEY,
        label        TEXT,
        key_hash     TEXT UNIQUE NOT NULL,
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        use_count    INTEGER NOT NULL DEFAULT 0
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

function envKeyHashes() {
  const raw = process.env.ACCESS_KEYS;
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean).map(hashKey));
}

let cache = { ts: 0, set: new Set() };
async function validKeyHashes() {
  const now = Date.now();
  if (cache.set.size && now - cache.ts < 60000) return cache.set;
  const set = new Set(envKeyHashes());
  if (dbEnabled()) {
    try {
      await ensureSchema();
      const { rows } = await query("SELECT key_hash FROM access_keys WHERE active");
      for (const r of rows) set.add(r.key_hash);
    } catch (err) { console.error("access_keys read failed:", err.message); }
  }
  cache = { ts: now, set };
  return set;
}

// Validate a submitted key; record usage for DB keys. Returns key hash or null.
async function validateKey(rawKey) {
  const kh = hashKey(rawKey);
  const set = await validKeyHashes();
  if (!set.has(kh)) return null;
  if (dbEnabled()) {
    try { await query("UPDATE access_keys SET last_used_at = now(), use_count = use_count + 1 WHERE key_hash = $1 AND active", [kh]); } catch {}
  }
  return kh;
}

// Generate/store a managed key (DB). Returns true if stored, false if no DB.
export async function createKey(label, rawKey) {
  if (!dbEnabled()) return false;
  await ensureSchema();
  await query("INSERT INTO access_keys (label, key_hash) VALUES ($1, $2)", [label || null, hashKey(rawKey)]);
  return true;
}

// ---- Express glue ----

// POST /auth  { key } → { ok, token }
export async function handleAuth(req, res) {
  if (!authEnabled()) return res.json({ ok: true, authRequired: false, token: null });
  const key = (req.body && req.body.key ? String(req.body.key) : "").trim();
  if (!key) return res.status(400).json({ error: "Access key required." });
  const kh = await validateKey(key);
  if (!kh) return res.status(401).json({ error: "That access key isn't valid." });
  return res.json({ ok: true, token: issueToken(kh) });
}

// Middleware protecting /chat. Open when auth is not configured.
export async function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: "Access key required.", authRequired: true });
  const set = await validKeyHashes();
  if (!set.has(data.kh)) return res.status(401).json({ error: "Access has been revoked.", authRequired: true });
  next();
}
