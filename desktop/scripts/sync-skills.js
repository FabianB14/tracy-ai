#!/usr/bin/env node
// Refresh the vendored SDK skills from a sibling InterverseSDK checkout.
// (Tracy's own skill is read straight from ../skills at stage time.)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.argv[2] || path.join(here, "..", "..", "..", "InterverseSDK", "skills");
if (!fs.existsSync(sdk)) { console.error(`no SDK skills at ${sdk} — pass the path as an argument`); process.exit(1); }
for (const name of fs.readdirSync(sdk)) {
  if (!name.startsWith("interverse-")) continue;
  const to = path.join(here, "..", "skills", name);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(sdk, name), to, { recursive: true });
  console.log(`synced ${name}`);
}
