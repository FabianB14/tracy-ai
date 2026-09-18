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

/** Claude Code's user-level config; user-scope MCP servers live under mcpServers. */
export function claudeConfigPath() {
  return path.join(HOME, ".claude.json");
}

/** The stdio server entry Claude Code needs to launch tracy-tools. */
export function mcpServerEntry({ execPath, serverPath, env }) {
  return {
    type: "stdio",
    command: execPath,
    args: [serverPath],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Register (or re-register) tracy-tools by writing Claude Code's config
 * directly. 0.1.0 shelled out to `claude mcp add`, and its argument parsing
 * rejected the call on Windows even in the documented form; the file is the
 * source of truth the CLI writes anyway, so write it ourselves: read, merge
 * under mcpServers, write atomically, read back. Other keys are untouched,
 * and a config that does not parse is left alone rather than clobbered.
 */
export function registerMcp({ execPath, serverPath, env, configPath = claudeConfigPath() }) {
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); }
    catch (e) { return { ok: false, out: `${configPath} is not valid JSON (${e.message}) — not touching it. Fix or remove the file and try again.` }; }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { ok: false, out: `${configPath} is not a JSON object — not touching it.` };
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers["tracy-tools"] = mcpServerEntry({ execPath, serverPath, env });
  const tmp = `${configPath}.tracy-tmp`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  return mcpRegistered(configPath)
    ? { ok: true, out: `tracy-tools registered in ${configPath}` }
    : { ok: false, out: `wrote ${configPath} but could not read tracy-tools back` };
}

export function mcpRegistered(configPath = claudeConfigPath()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const e = cfg?.mcpServers?.["tracy-tools"];
    return Boolean(e && e.command && Array.isArray(e.args));
  } catch { return false; }
}
