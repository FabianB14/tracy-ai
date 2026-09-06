#!/usr/bin/env node
// One-command setup for Tracy's agent runner on a PC.
//
//   npm run runner:setup
//
// Asks a few questions, writes .env (keeping anything already there), installs
// the coding-agent CLIs you pick, and tells you exactly what to run next. Safe
// to re-run: it only changes the values you answer.

import "dotenv/config";
import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
// Line reader that never loses input: lines are queued as they arrive, so it
// works typed interactively AND with answers piped in (scripts, tests).
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const queue = [], waiters = [];
let closed = false;
rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(""); });
const ask = (q) => new Promise((res) => {
  process.stdout.write(q);
  const done = (a) => res(String(a || "").trim());
  if (queue.length) return done(queue.shift());
  if (closed) return done("");
  waiters.push(done);
});
const askDefault = async (q, cur) => { const a = await ask(cur ? `${q} [keep current] ` : `${q} `); return a || cur || ""; };
const mask = (v) => (v ? v.slice(0, 6) + "…" + v.slice(-4) : "");

console.log("\nTracy agent runner — setup\n===========================");
console.log("This machine will run coding tasks Tracy hands out (Claude Code / Codex).");
console.log("Values are saved to .env in this folder and never leave this PC.\n");

// ---- Questions ----
const cur = { ...process.env };

console.log("1) Tracy's database (the task queue). Render → your Postgres → Connect → External Database URL.");
const DATABASE_URL = await askDefault(cur.DATABASE_URL ? `   DATABASE_URL (current: ${mask(cur.DATABASE_URL)})` : "   DATABASE_URL:", cur.DATABASE_URL);

console.log("\n2) GitHub token so the runner can clone repos, push a branch, and open pull requests.");
console.log("   GitHub → Settings → Developer settings → Fine-grained tokens → repos you choose →");
console.log("   permissions: Contents (read/write) + Pull requests (read/write).");
const GITHUB_TOKEN = await askDefault(cur.GITHUB_TOKEN ? `   GITHUB_TOKEN (current: ${mask(cur.GITHUB_TOKEN)})` : "   GITHUB_TOKEN:", cur.GITHUB_TOKEN);

console.log("\n3) Gemini API key (optional) — lets finished tasks be saved to Tracy's memory. Same key as on Render.");
const GEMINI_API_KEY = await askDefault(cur.GEMINI_API_KEY ? `   GEMINI_API_KEY (current: ${mask(cur.GEMINI_API_KEY)})` : "   GEMINI_API_KEY (Enter to skip):", cur.GEMINI_API_KEY);

console.log("\n4) Repos Tracy may work on: GitHub URLs, comma-separated.");
console.log("   e.g. https://github.com/FabianB14/tracy-ai, https://github.com/FabianB14/PartOut");
let repos = {};
try { repos = JSON.parse(cur.AGENT_REPOS || "{}"); } catch { repos = {}; }
const repoAnswer = await ask(Object.keys(repos).length ? `   Repos (current: ${Object.keys(repos).join(", ")}) [keep current]: ` : "   Repos: ");
if (repoAnswer) {
  repos = {};
  for (const u of repoAnswer.split(",").map((s) => s.trim()).filter(Boolean)) {
    const name = u.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop().toLowerCase();
    repos[name] = u;
  }
}

console.log("\n5) Which coding agents should this PC run? (they use your own logins/subscriptions)");
const agentsAnswer = (await ask("   claude / codex / both [both]: ")).toLowerCase() || "both";
const wantClaude = agentsAnswer === "both" || agentsAnswer.includes("claude");
const wantCodex = agentsAnswer === "both" || agentsAnswer.includes("codex");
rl.close();

// ---- Write .env (merge) ----
const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
const set = (key, val) => {
  if (val == null) return;
  const line = `${key}=${val}`;
  const i = lines.findIndex((l) => l.startsWith(key + "="));
  if (i >= 0) lines[i] = line; else lines.push(line);
};
set("DATABASE_URL", DATABASE_URL);
set("GITHUB_TOKEN", GITHUB_TOKEN);
if (GEMINI_API_KEY) set("GEMINI_API_KEY", GEMINI_API_KEY);
set("AGENT_REPOS", JSON.stringify(repos));
writeFileSync(ENV_FILE, lines.filter((l, i, a) => l.trim() || i === a.length - 1).join("\n").replace(/\n*$/, "\n"));
console.log(`\n✓ Saved .env (${Object.keys(repos).length} repo(s): ${Object.keys(repos).join(", ") || "none"})`);

// ---- Install CLIs ----
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const npmInstall = (pkg) => {
  console.log(`\nInstalling ${pkg} …`);
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", pkg], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) console.log(`  (install of ${pkg} reported a problem — you can run: npm install -g ${pkg})`);
};
if (wantClaude) { if (has("claude")) console.log("\n✓ Claude Code already installed"); else npmInstall("@anthropic-ai/claude-code"); }
if (wantCodex) { if (has("codex")) console.log("✓ Codex already installed"); else npmInstall("@openai/codex"); }

// ---- What's next ----
console.log("\nNext steps\n----------");
let n = 1;
if (wantClaude) console.log(`${n++}. Log in to Claude Code once:   claude        (browser login, then type /exit)`);
if (wantCodex)  console.log(`${n++}. Log in to Codex once:         codex login`);
console.log(`${n++}. Start the runner:             npm run runner`);
console.log("   Leave that window open. Tracy's tasks queue up while it's closed and run when it's back.");
if (!DATABASE_URL) console.log("\n! DATABASE_URL is empty — the runner can't see the queue until it's set.");
if (!GITHUB_TOKEN && Object.values(repos).some((u) => /github\.com/.test(u))) console.log("! GITHUB_TOKEN is empty — private clones, pushes, and PRs will fail.");
console.log("");
process.exit(0);
