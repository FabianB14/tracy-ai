#!/usr/bin/env node
// Generate an access key for Tracy.
//
// Usage:
//   node scripts/genkey.js "Alice"                          # label only
//   node scripts/genkey.js "Josh M" --user josh --role cto  # bound to a person
//
// --user binds the key to a user id — that becomes the person's VERIFIED
// identity (Tracy's vault releases secrets based on it). --role is a free-form
// role tag Tracy can see (ceo, cto, admin, staff, ...). Keys without --user
// still work for access, but can't use the vault.
//
// With DATABASE_URL set, the key's hash is stored in the access_keys table
// (revocable, usage-tracked). Without a DB, it prints a key to add to the
// ACCESS_KEYS env var instead (env keys carry no identity → no vault). The
// plaintext key is shown ONCE — copy it now; only its hash is stored.

import "dotenv/config";
import crypto from "crypto";
import { createKey } from "../src/auth.js";

function genKey() {
  const part = () => crypto.randomBytes(2).toString("hex");
  return `tracy-${part()}-${part()}-${part()}`;
}

// Parse: positional words form the label; --user X / --role Y are options.
const args = process.argv.slice(2);
const labelParts = [];
let userId = null, role = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--user") userId = args[++i] || null;
  else if (args[i] === "--role") role = args[++i] || null;
  else labelParts.push(args[i]);
}
const label = labelParts.join(" ") || "unnamed";
const key = genKey();

const stored = await createKey(label, key, userId, role);

console.log("");
if (stored) {
  console.log(`Access key created (label: "${label}"${userId ? `, user: ${userId}` : ""}${role ? `, role: ${role}` : ""}).`);
  if (!userId) console.log("Note: no --user given — this key has no verified identity, so it can't use the vault.");
  console.log("Give this to the person — it is not stored in plaintext and won't be shown again:\n");
  console.log(`    ${key}\n`);
} else {
  console.log("No DATABASE_URL set — nothing was stored. Add this key to the ACCESS_KEYS");
  console.log("env var on your server (comma-separated for multiple):\n");
  console.log(`    ACCESS_KEYS=${key}\n`);
  if (userId) console.log("Note: env keys can't carry an identity — --user/--role need the database.");
}
process.exit(0);
