// The brain's daily loop, run by Tracy Desktop instead of a cron entry.
//
// Same thing brain/loops/run-daily.sh does — Claude Code works through
// brain/loops/daily.md inside a clone of tracy-ai — but scheduled by the
// app, with the clone, the auth, the Node the helper scripts need, and the
// digest all handled here. The loop commits; this pushes those commits to a
// `tracy/brain` branch so nothing is lost and main is never touched by a
// machine. Entities reach Tracy immediately through brain-sync's database
// write; the weekly review merges the branch.

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

export const REPO_URL = "https://github.com/FabianB14/tracy-ai";
export const BRANCH = "tracy/brain";
export const COMPARE_URL = `${REPO_URL}/compare/main...${BRANCH.replace("/", "%2F")}?expand=1`;

// Mirrors run-daily.sh: tools scoped to exactly what the loop needs.
export const ALLOWED_TOOLS =
  "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(mv raw/*:*),Bash(node graph/build-graph.js)," +
  "Bash(node ../scripts/brain-sync.js),Bash(node ../scripts/brain-notes-pull.js),Bash(git add .)," +
  "Bash(git commit:*),Bash(git status:*),Bash(date:*),Bash(ls:*)";

export function claudeArgs() {
  // The prompt goes over stdin (as the task runner does), so the argument
  // list stays short enough for cmd.exe and carries nothing to misquote.
  return ["-p", "--output-format", "json", "--allowedTools", ALLOWED_TOOLS,
          "--permission-mode", "acceptEdits", "--max-turns", "60"];
}

/** Is a run due? Once per local day, at or after runAt ("HH:MM"). */
export function isDue({ now = new Date(), runAt = "07:00", lastRunDate = null } = {}) {
  const [h, m] = String(runAt).split(":").map((n) => parseInt(n, 10) || 0);
  const today = localDate(now);
  if (lastRunDate === today) return false;
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The loop ends its output with a short digest; keep the tail as the summary. */
export function digestFrom(output) {
  let text = String(output || "");
  try {
    const j = JSON.parse(text);
    text = typeof j.result === "string" ? j.result : text;
  } catch { /* plain text */ }
  text = text.trim();
  const i = text.toLowerCase().lastIndexOf("digest");
  const tail = i >= 0 && text.length - i < 2500 ? text.slice(i) : text.slice(-1500);
  return tail.trim();
}

/** Quote one argument for cmd.exe (only used when the CLI is a .cmd shim). */
export function winQuote(arg) {
  const s = String(arg);
  if (s !== "" && /^[A-Za-z0-9_\-./:=,@+~\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * A `node` the loop's helper scripts can call, backed by Electron's own
 * runtime. Goes at the END of PATH, so a real Node install wins when present.
 */
export function ensureNodeShim(binDir, execPath) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const f = path.join(binDir, "node.cmd");
    fs.writeFileSync(f, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`);
    return f;
  }
  const f = path.join(binDir, "node");
  fs.writeFileSync(f, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${execPath}" "$@"\n`, { mode: 0o755 });
  return f;
}

/** The clone's node_modules → the app's staged production deps. */
export function ensureNodeModulesLink(cloneDir, tracyRoot) {
  const target = path.join(tracyRoot, "node_modules");
  const link = path.join(cloneDir, "node_modules");
  if (fs.existsSync(link)) return link;
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

function gitAuthArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

export function createBrainLoop({ execPath, tracyRoot, workDir, findClaude, envFn, pathFn = () => process.env.PATH, onChange = () => {} }) {
  const stateFile = path.join(workDir, "brain-state.json");
  const cloneDir = path.join(workDir, "tracy-ai");
  const binDir = path.join(workDir, "bin");
  let state = { running: false, lastRun: null, lastRunDate: null, log: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")), running: false }; } catch {}

  function save() {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, log: state.log.slice(-200) }, null, 2));
    onChange();
  }
  function log(line) {
    for (const l of String(line).split(/\r?\n/)) if (l.trim()) state.log.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
    if (state.log.length > 200) state.log = state.log.slice(-200);
    onChange();
  }

  function git(args, { token = "", cwd = cloneDir } = {}) {
    const r = spawnSync("git", [...gitAuthArgs(token), ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: pathFn() }, timeout: 120000 });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    return (r.stdout || "").trim();
  }

  function ensureClone(token) {
    if (!fs.existsSync(path.join(cloneDir, ".git"))) {
      fs.mkdirSync(workDir, { recursive: true });
      log("cloning tracy-ai");
      git(["clone", "--quiet", REPO_URL, cloneDir], { token, cwd: workDir });
      git(["config", "user.name", "Tracy (Interverse assistant)"]);
      git(["config", "user.email", "tracy@interverse.local"]);
    }
    git(["fetch", "--quiet", "origin", "main", BRANCH], { token });
    let hasBranch = true;
    try { git(["rev-parse", "--verify", `origin/${BRANCH}`]); } catch { hasBranch = false; }
    if (hasBranch) {
      git(["checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`]);
      git(["merge", "--quiet", "--no-edit", "origin/main"]);
    } else {
      git(["checkout", "-q", "-B", BRANCH, "origin/main"]);
    }
    ensureNodeModulesLink(cloneDir, tracyRoot);
  }

  function runClaude(claudePath, env) {
    return new Promise((resolve) => {
      const prompt = fs.readFileSync(path.join(cloneDir, "brain", "loops", "daily.md"), "utf8");
      const win = process.platform === "win32";
      const useShell = win && !/\.exe$/i.test(claudePath);
      const args = useShell ? claudeArgs().map(winQuote) : claudeArgs();
      const child = spawn(claudePath, args, {
        cwd: path.join(cloneDir, "brain"), shell: useShell,
        env: { ...process.env, ...env, PATH: pathFn() + path.delimiter + binDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; log(d); });
      const timer = setTimeout(() => child.kill("SIGTERM"), 45 * 60 * 1000);
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
      child.stdin.end(prompt);
    });
  }

  async function runOnce({ reason = "manual" } = {}) {
    if (state.running) return status();
    const env = envFn();
    const claudePath = findClaude();
    const missing = [!env.DATABASE_URL && "database URL", !env.GITHUB_TOKEN && "GitHub token", !claudePath && "Claude Code"].filter(Boolean);
    if (missing.length) {
      state.lastRun = { at: new Date().toISOString(), ok: false, error: `Can't run the brain loop: missing ${missing.join(", ")}.` };
      save(); return status();
    }
    state.running = true; state.log = []; log(`brain loop starting (${reason})`); save();
    try {
      ensureClone(env.GITHUB_TOKEN);
      ensureNodeShim(binDir, execPath);
      const before = git(["rev-parse", "HEAD"]);
      const r = await runClaude(claudePath, { DATABASE_URL: env.DATABASE_URL, GEMINI_API_KEY: env.GEMINI_API_KEY || "" });
      if (r.code !== 0) throw new Error(`Claude Code exited ${r.code}: ${(r.err || r.out).trim().slice(-400)}`);
      const after = git(["rev-parse", "HEAD"]);
      const committed = before !== after;
      if (committed) { git(["push", "--quiet", "-u", "origin", BRANCH], { token: env.GITHUB_TOKEN }); log(`pushed ${BRANCH}`); }
      state.lastRun = { at: new Date().toISOString(), ok: true, digest: digestFrom(r.out), committed, compareUrl: COMPARE_URL };
      state.lastRunDate = localDate();
      log("brain loop finished");
    } catch (err) {
      state.lastRun = { at: new Date().toISOString(), ok: false, error: String(err.message || err) };
      log(`brain loop failed: ${err.message || err}`);
    } finally {
      state.running = false; save();
    }
    return status();
  }

  function tick({ enabled, runAt }) {
    if (!enabled || state.running) return false;
    if (!isDue({ runAt, lastRunDate: state.lastRunDate })) return false;
    runOnce({ reason: "scheduled" });
    return true;
  }

  function status() {
    return { running: state.running, lastRun: state.lastRun, lastRunDate: state.lastRunDate, log: state.log.slice(-60), compareUrl: COMPARE_URL };
  }

  return { runOnce, tick, status };
}
