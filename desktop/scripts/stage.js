#!/usr/bin/env node
// Stage Tracy's own code for packaging. The installed app carries a copy of
// the repo's runtime pieces (src, scripts, mcp, skills + production deps)
// under resources/tracy, and runs them with Electron's bundled Node. This
// script builds that copy at desktop/staged; electron-builder ships it.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(here, "..");
const ROOT = path.join(DESKTOP, "..");
const OUT = path.join(DESKTOP, "staged");

export const COPY = ["package.json", "package-lock.json", "src", "scripts", "mcp", "skills", "TRACY.md"];

export function plan() {
  return {
    from: ROOT, to: OUT,
    copy: COPY.filter((p) => fs.existsSync(path.join(ROOT, p))),
    extraSkills: path.join(DESKTOP, "skills"),
  };
}

export function stage({ install = true } = {}) {
  const p = plan();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const item of p.copy) {
    fs.cpSync(path.join(ROOT, item), path.join(OUT, item), {
      recursive: true,
      filter: (src) => !/[\\/](tests?|__tests__|\.git|node_modules|desktop|web|brain|logs)([\\/]|$)/.test(src),
    });
  }
  // The four skills the app installs: Tracy's own plus the vendored SDK ones.
  fs.cpSync(p.extraSkills, path.join(OUT, "skills"), { recursive: true });
  if (install) {
    execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: OUT, stdio: "inherit" });
  }
  return p;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = stage();
  console.log(`staged ${p.copy.join(", ")} → ${p.to}`);
}
