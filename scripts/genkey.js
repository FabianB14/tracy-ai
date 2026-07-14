#!/usr/bin/env node
// Generate an access key for Tracy.
//
// Usage:
//   node scripts/genkey.js "Alice"        # label is optional
//
// With DATABASE_URL set, the key's hash is stored in the access_keys table
// (revocable, usage-tracked). Without a DB, it prints a key to add to the
// ACCESS_KEYS env var instead. The plaintext key is shown ONCE — copy it now;
// only its hash is stored.

import "dotenv/config";
import crypto from "crypto";
import { createKey } from "../src/auth.js";

function genKey() {
  const part = () => crypto.randomBytes(2).toString("hex");
  return `tracy-${part()}-${part()}-${part()}`;
}

const label = process.argv.slice(2).join(" ") || "unnamed";
const key = genKey();

const stored = await createKey(label, key);

console.log("");
if (stored) {
  console.log(`Access key created (label: "${label}").`);
  console.log("Give this to the person — it is not stored in plaintext and won't be shown again:\n");
  console.log(`    ${key}\n`);
} else {
  console.log("No DATABASE_URL set — nothing was stored. Add this key to the ACCESS_KEYS");
  console.log("env var on your server (comma-separated for multiple):\n");
  console.log(`    ACCESS_KEYS=${key}\n`);
}
process.exit(0);
