// Tracy's vault — pass secrets (tokens, keys, credentials) between specific
// people, safely.
//
// The problem it solves: "I'm the CEO, hand this API key to the CTO" without
// pasting it in Slack/email where it lives forever. Tracy stores the secret
// ENCRYPTED and releases it ONLY to the designated recipient — verified by
// their access key (real authentication), never by the self-declared User ID
// field, which anyone can type anything into.
//
// Security model:
//   • Identity = the access key a person authenticated with (src/auth.js).
//     Each key is bound to a user id + role when generated. No authenticated
//     identity → no vault, period.
//   • Secrets are AES-256-GCM encrypted at rest with VAULT_SECRET (env). A DB
//     dump or file leak without VAULT_SECRET reveals nothing.
//   • Release rule: only the designated recipient can retrieve a secret's
//     value. The sender can see that it exists (and delete it), not read it
//     back. Optional one-time retrieval and expiry.
//   • Nothing here is ever logged in plaintext; /chat also redacts
//     conversation logging on vault turns (see src/server.js).
//
// Config (env — never committed):
//   VAULT_SECRET   long random string; encrypts secrets at rest. Rotating it
//                  orphans previously stored secrets (by design).

import crypto from "crypto";
import { dbEnabled, query } from "./db.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "logs", "vault.json");

const SECRET = process.env.VAULT_SECRET || "";
const MAX_SECRET_LEN = 8192;

export function vaultEnabled() {
  return Boolean(SECRET);
}

// ---- Encryption (AES-256-GCM) ----
function keyBytes() {
  return crypto.createHash("sha256").update(SECRET).digest(); // 32 bytes
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ---- Storage: Postgres when available, encrypted file fallback ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS vault_items (
        id           BIGSERIAL PRIMARY KEY,
        sender       TEXT NOT NULL,
        recipient    TEXT NOT NULL,
        label        TEXT NOT NULL,
        ciphertext   TEXT NOT NULL,
        one_time     BOOLEAN NOT NULL DEFAULT false,
        expires_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        retrieved_at TIMESTAMPTZ,
        retrievals   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS vault_recipient_idx ON vault_items (recipient);
      CREATE INDEX IF NOT EXISTS vault_sender_idx    ON vault_items (sender);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

function readFile() {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { nextId: 1, items: [] }; }
  catch { return { nextId: 1, items: [] }; }
}
function writeFile(data) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const norm = (s) => String(s || "").trim().toLowerCase();
const expired = (row) => row.expires_at && new Date(row.expires_at).getTime() < Date.now();

// Store a secret for a designated recipient. Returns { id, label, recipient }.
// oneTime defaults to TRUE: a handed-off key should not outlive its handoff —
// it self-destructs when the recipient retrieves it. Senders opt IN to keeping
// a secret retrievable (e.g. a shared credential several people will need).
export async function storeSecret({ sender, recipient, label, secret, oneTime = true, expiresDays = null }) {
  if (!vaultEnabled()) throw new Error("vault-not-configured");
  if (!sender || !recipient || !label || !secret) throw new Error("sender, recipient, label and secret are all required");
  if (String(secret).length > MAX_SECRET_LEN) throw new Error(`secret too long (max ${MAX_SECRET_LEN} chars)`);
  const ciphertext = encrypt(secret);
  const expiresAt = expiresDays ? new Date(Date.now() + Number(expiresDays) * 86400000).toISOString() : null;
  const row = {
    sender: norm(sender), recipient: norm(recipient), label: String(label).trim(),
    ciphertext, one_time: Boolean(oneTime), expires_at: expiresAt,
  };
  if (dbEnabled()) {
    await ensureSchema();
    const { rows } = await query(
      `INSERT INTO vault_items (sender, recipient, label, ciphertext, one_time, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [row.sender, row.recipient, row.label, row.ciphertext, row.one_time, row.expires_at],
    );
    return { id: rows[0].id, label: row.label, recipient: row.recipient };
  }
  const data = readFile();
  const id = data.nextId++;
  data.items.push({ id, ...row, created_at: new Date().toISOString(), retrieved_at: null, retrievals: 0 });
  writeFile(data);
  return { id, label: row.label, recipient: row.recipient };
}

// List items a user can see: addressed TO them (retrievable) or sent BY them
// (visible + deletable, but not readable). Metadata only — never the secret.
export async function listSecrets(user) {
  if (!vaultEnabled()) throw new Error("vault-not-configured");
  const u = norm(user);
  let rows;
  if (dbEnabled()) {
    await ensureSchema();
    ({ rows } = await query(
      `SELECT id, sender, recipient, label, one_time, expires_at, created_at, retrieved_at, retrievals
       FROM vault_items WHERE recipient = $1 OR sender = $1 ORDER BY created_at DESC`, [u]));
  } else {
    rows = readFile().items.filter((r) => r.recipient === u || r.sender === u);
  }
  return rows.filter((r) => !expired(r)).map((r) => ({
    id: r.id, label: r.label, from: r.sender, to: r.recipient,
    forMe: r.recipient === u, oneTime: r.one_time,
    expiresAt: r.expires_at || null, createdAt: r.created_at,
    retrieved: r.retrievals > 0 ? `${r.retrievals}x, last ${r.retrieved_at}` : "not yet",
  }));
}

// Retrieve a secret's VALUE — recipient only. `ref` is an id or a label.
// One-time secrets are deleted on read. Returns { label, from, secret } or throws.
export async function getSecret(user, ref) {
  if (!vaultEnabled()) throw new Error("vault-not-configured");
  const u = norm(user);
  let row;
  if (dbEnabled()) {
    await ensureSchema();
    const byId = /^\d+$/.test(String(ref).trim());
    const { rows } = await query(
      byId
        ? `SELECT * FROM vault_items WHERE recipient = $1 AND id = $2`
        : `SELECT * FROM vault_items WHERE recipient = $1 AND lower(label) = lower($2) ORDER BY created_at DESC LIMIT 1`,
      [u, String(ref).trim()],
    );
    row = rows[0];
  } else {
    const items = readFile().items.filter((r) => r.recipient === u);
    row = /^\d+$/.test(String(ref).trim())
      ? items.find((r) => r.id === Number(ref))
      : items.filter((r) => norm(r.label) === norm(ref)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  }
  if (!row || expired(row)) throw new Error("not-found"); // same error whether missing, expired, or not yours
  const secret = decrypt(row.ciphertext);
  if (row.one_time) {
    await removeById(row.id);
  } else if (dbEnabled()) {
    await query(`UPDATE vault_items SET retrieved_at = now(), retrievals = retrievals + 1 WHERE id = $1`, [row.id]);
  } else {
    const data = readFile();
    const it = data.items.find((r) => r.id === row.id);
    if (it) { it.retrieved_at = new Date().toISOString(); it.retrievals = (it.retrievals || 0) + 1; writeFile(data); }
  }
  return { label: row.label, from: row.sender, secret, oneTime: Boolean(row.one_time) };
}

async function removeById(id) {
  if (dbEnabled()) { await query(`DELETE FROM vault_items WHERE id = $1`, [id]); return; }
  const data = readFile();
  data.items = data.items.filter((r) => r.id !== Number(id));
  writeFile(data);
}

// Delete an item — sender or recipient only. Returns true if something was deleted.
export async function deleteSecret(user, id) {
  if (!vaultEnabled()) throw new Error("vault-not-configured");
  const u = norm(user);
  if (dbEnabled()) {
    await ensureSchema();
    const { rowCount } = await query(
      `DELETE FROM vault_items WHERE id = $1 AND (sender = $2 OR recipient = $2)`, [Number(id), u]);
    return rowCount > 0;
  }
  const data = readFile();
  const before = data.items.length;
  data.items = data.items.filter((r) => !(r.id === Number(id) && (r.sender === u || r.recipient === u)));
  writeFile(data);
  return data.items.length < before;
}
