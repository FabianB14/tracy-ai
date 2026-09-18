// Manages the task-runner child process: start, stop, restart-on-crash, and a
// small log tail the status window shows. The runner is Tracy's own
// scripts/agent-runner.js, executed with Electron's bundled Node
// (ELECTRON_RUN_AS_NODE) so the user needs no Node install of their own.

import { spawn } from "child_process";
import path from "path";

const LOG_LINES = 400;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 5;

export function createRunner({ execPath, tracyRoot, envFn, onChange = () => {} }) {
  let child = null;
  let logs = [];
  let restarts = [];
  let wanted = false;
  let lastExit = null;

  const script = path.join(tracyRoot, "scripts", "agent-runner.js");

  function log(line) {
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      logs.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
    }
    if (logs.length > LOG_LINES) logs = logs.slice(-LOG_LINES);
    onChange();
  }

  function start() {
    if (child) return status();
    wanted = true;
    const env = { ...process.env, ...envFn(), ELECTRON_RUN_AS_NODE: "1" };
    child = spawn(execPath, [script], { cwd: tracyRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    log(`runner starting (pid ${child.pid})`);
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.on("exit", (code, signal) => {
      lastExit = { code, signal, at: Date.now() };
      log(`runner exited (${signal || code})`);
      child = null;
      onChange();
      if (!wanted) return;
      // Crash loop guard: a bad DATABASE_URL would otherwise spin forever.
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (restarts.length >= MAX_RESTARTS) {
        wanted = false;
        log(`runner crashed ${MAX_RESTARTS} times in 10 minutes — stopped. Check settings, then start it again.`);
        onChange();
        return;
      }
      restarts.push(now);
      setTimeout(() => { if (wanted && !child) start(); }, 3000);
    });
    onChange();
    return status();
  }

  function stop() {
    wanted = false;
    if (child) {
      log("stopping runner");
      child.kill("SIGTERM");
      const c = child;
      setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 5000);
    }
    return status();
  }

  function status() {
    return { running: Boolean(child), wanted, pid: child?.pid || null, lastExit, restartsRecent: restarts.length };
  }

  return { start, stop, status, logs: () => logs.slice(), log };
}
