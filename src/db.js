// Postgres connection + conversation storage.
//
// Used when DATABASE_URL is set (e.g. on Render, pointed at the managed
// Postgres). Local dev with no DATABASE_URL uses file-based fallbacks in the
// modules that call this (src/logging.js, src/memory.js) — so nothing new is
// required to run locally.
//
// This module never touches the API key. The same consent caveat as file
// logging applies (see src/logging.js): apps must show users consent language
// before conversation storage / memory is enabled in production.

import pg from "pg";

const { Pool } = pg;

let pool = null;
let schemaReady = null;

export function dbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    // Render's INTERNAL DB hostnames (e.g. dpg-xxxxx-a) need no SSL; the
    // EXTERNAL ones (*.render.com) require it. Detect and toggle so either
    // connection string in DATABASE_URL just works.
    const needsSsl = /\.render\.com/i.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
  }
  return pool;
}

// Shared query helper so other modules (memory) can reuse the same pool.
export function query(text, params) {
  return getPool().query(text, params);
}

// Create the table + indexes once (idempotent). Cached so we don't re-run DDL
// on every write; on failure we clear the cache so a later write can retry.
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id         BIGSERIAL PRIMARY KEY,
          ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
          user_id    TEXT,
          surface    TEXT,
          messages   JSONB NOT NULL,
          reply      TEXT,
          tools_used JSONB NOT NULL DEFAULT '[]'::jsonb
        );
        CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations (user_id);
        CREATE INDEX IF NOT EXISTS conversations_surface_idx ON conversations (surface);
        CREATE INDEX IF NOT EXISTS conversations_ts_idx      ON conversations (ts);
      `)
      .catch((err) => {
        schemaReady = null; // allow a later retry
        throw err;
      });
  }
  return schemaReady;
}

export async function logConversationToDb({ userId, surface, messages, reply, toolsUsed }) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO conversations (user_id, surface, messages, reply, tools_used)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId ?? null,
      surface ?? null,
      JSON.stringify(messages),      // jsonb column — stringify so pg stores JSON
      reply ?? null,
      JSON.stringify(toolsUsed ?? []),
    ]
  );
}
