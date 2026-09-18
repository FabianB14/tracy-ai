// First-run setup: find Claude Code, open its login, install the bundled
// skills, and register Tracy's MCP server with it. Every step is idempotent
// so the buttons can be pressed again safely.

import { spawnSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const HOME = os.homedir();

/** PATH a GUI app should use — GUI processes get a minimal PATH on macOS. */
export function fixedPath() {
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = process.platform === "win32"
    ? [path.join(process.env.APPDATA || "", "npm"), path.join(HOME, ".local", "bin"),
       path.join(process.env.LOCALAPPDATA || "", "Programs", "claude")]
    : ["/usr/local/bin", "/opt/homebrew/bin", path.join(HOME, ".local", "bin"),
       path.join(HOME, ".npm-global", "bin"), path.join(HOME, ".claude", "bin")];
  if (process.platform === "darwin") {
    const r = spawnSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo -n $PATH"], { encoding: "utf8", timeout: 4000 });
    if (r.status === 0 && r.stdout) extra.unshift(...r.stdout.split(":"));
  }
  return [...new Set([...extra, ...parts])].filter(Boolean).join(path.delimiter);
}

/** Absolute path to the claude CLI, or null. */
export function findClaude() {
  const env = { ...process.env, PATH: fixedPath() };
  const probe = process.platform === "win32" ? ["where", ["claude"]] : ["which", ["claude"]];
  const r = spawnSync(probe[0], probe[1], { encoding: "utf8", env, timeout: 4000 });
  const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return r.status === 0 && first ? first : null;
}

export function claudeVersion(claudePath) {
  if (!claudePath) return null;
  const r = spawnSync(claudePath, ["--version"], { encoding: "utf8", env: { ...process.env, PATH: fixedPath() },
    timeout: 8000, shell: process.platform === "win32" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** Open a terminal running `claude` so the person can log in once. */
export function openLoginTerminal() {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "\"Claude Code login\"", "cmd.exe", "/k", "claude"], { detached: true, stdio: "ignore", shell: false }).unref();
  } else if (process.platform === "darwin") {
    spawn("osascript", ["-e", 'tell application "Terminal" to do script "claude"', "-e", 'tell application "Terminal" to activate'],
      { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", "claude"], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Where Claude Code looks for personal skills. */
export function skillsTarget() {
  return path.join(HOME, ".claude", "skills");
}

/** Copy every skill folder (one with a SKILL.md) from sourceDirs into target. */
export function installSkills(sourceDirs, target = skillsTarget()) {
  const installed = [];
  fs.mkdirSync(target, { recursive: true });
  for (const src of sourceDirs) {
    if (!fs.existsSync(src)) continue;
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      if (!fs.existsSync(path.join(from, "SKILL.md"))) continue;
      const to = path.join(target, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
      installed.push(name);
    }
  }
  return installed;
}

export function installedSkills(target = skillsTarget()) {
  try { return fs.readdirSync(target).filter((n) => fs.existsSync(path.join(target, n, "SKILL.md"))); }
  catch { return []; }
}

/** Register (or re-register) tracy-tools with Claude Code, user scope. */
export function registerMcp({ claudePath, execPath, serverPath, env }) {
  const opts = { encoding: "utf8", env: { ...process.env, PATH: fixedPath() }, timeout: 15000, shell: process.platform === "win32" };
  spawnSync(claudePath, ["mcp", "remove", "-s", "user", "tracy-tools"], opts); // idempotent; ignore result
  const envFlags = Object.entries({ ...env, ELECTRON_RUN_AS_NODE: "1" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = spawnSync(claudePath, ["mcp", "add", "-s", "user", ...envFlags, "tracy-tools", "--", execPath, serverPath], opts);
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

export function mcpRegistered(claudePath) {
  if (!claudePath) return false;
  const r = spawnSync(claudePath, ["mcp", "list"], { encoding: "utf8", env: { ...process.env, PATH: fixedPath() },
    timeout: 15000, shell: process.platform === "win32" });
  return r.status === 0 && /tracy-tools/.test(r.stdout || "");
}
