#!/usr/bin/env node
// Tracy's agent runner — executes queued code tasks with Claude Code or Codex.
//
// Runs on a machine that has the repos checked out and the CLIs installed
// (your laptop, a small VM). It polls the agent_tasks queue that deployed
// Tracy writes to, runs the chosen agent non-interactively inside the repo,
// and writes the result + token/cost stats back. Tracy then reports it, and
// the summary is saved to her knowledge base so the same ask is answered from
// memory next time.
//
// Setup (once):
//   1. Install the CLIs you want: `claude` (Claude Code) and/or `codex`.
//   2. In .env next to this repo: DATABASE_URL (Tracy's Postgres, external URL),
//      GEMINI_API_KEY (so results can be saved to her knowledge base; optional),
//      and AGENT_REPOS — a JSON map of repo name → local path, e.g.
//        AGENT_REPOS={"tracy-ai":"/home/me/tracy-ai","partout":"/home/me/PartOut"}
//      Only repos in this map can be touched. Unknown repo → task fails clearly.
//   3. Run:  node scripts/agent-runner.js        (Ctrl-C to stop)
//      or as a service / in a tmux; it polls every AGENT_POLL_MS (default 15s).
//
// Per-repo guidance: if the repo has a TRACY.md at its root, its contents are
// prepended to every task prompt (like CLAUDE.md, but for Tracy's delegated
// work: conventions, do-nots, how to test, what "done" means). See TRACY.md in
// this repo for the template.
//
// Tunables (env): AGENT_TIMEOUT_MS (default 20 min), CLAUDE_ARGS / CODEX_ARGS
// (extra CLI flags), AGENT_PRICING_JSON (Codex $/1M tokens by model), AGENT_RUNNER_ID.

import "dotenv/config";
import { spawn } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { claimTask, completeTask, failTask, agentsEnabled } from "../src/agents.js";
import { kbEnabled, kbAdd } from "../src/knowledge.js";

const POLL_MS = Number(process.env.AGENT_POLL_MS || 15000);
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 20 * 60 * 1000);
const RUNNER_ID = process.env.AGENT_RUNNER_ID || `${process.env.USER || "runner"}@${(process.env.HOSTNAME || "local")}`;
const REPOS = (() => { try { return JSON.parse(process.env.AGENT_REPOS || "{}"); } catch { return {}; } })();
const EXTRA = (v) => (v ? String(v).split(/\s+/).filter(Boolean) : []);
const CLAUDE_ARGS = EXTRA(process.env.CLAUDE_ARGS);
const CODEX_ARGS = EXTRA(process.env.CODEX_ARGS);

// Codex reports tokens, not dollars. Price them ($ per 1M tokens) so runs are
// comparable with Claude Code's total_cost_usd. Override via AGENT_PRICING_JSON.
const PRICING = Object.assign(
  { "gpt-5-codex": { in: 1.25, out: 10 }, "gpt-5": { in: 1.25, out: 10 }, "o4-mini": { in: 1.1, out: 4.4 }, default: { in: 1.25, out: 10 } },
  (() => { try { return JSON.parse(process.env.AGENT_PRICING_JSON || "{}"); } catch { return {}; } })(),
);
const priceFor = (model, tin, tout) => {
  const key = Object.keys(PRICING).find((k) => k !== "default" && String(model || "").toLowerCase().startsWith(k)) || "default";
  return (tin * PRICING[key].in + tout * PRICING[key].out) / 1e6;
};

if (!agentsEnabled()) { console.error("agent-runner: DATABASE_URL is required (it's the task queue)."); process.exit(1); }
if (!Object.keys(REPOS).length) console.error("agent-runner: AGENT_REPOS is empty — every task will fail until it's set.");
console.log(`agent-runner ${RUNNER_ID}: polling every ${POLL_MS / 1000}s; repos: ${Object.keys(REPOS).join(", ") || "(none)"}`);

// ---- Prompt assembly ----
function buildPrompt(task, repoPath) {
  const tracyMd = path.join(repoPath, "TRACY.md");
  const guidance = existsSync(tracyMd) ? readFileSync(tracyMd, "utf8").trim() : "";
  return [
    guidance ? `# Repo guidance (TRACY.md)\n\n${guidance}\n\n---\n` : "",
    `# Task from Tracy (Interverse's assistant), requested by ${task.requestedBy || "the team"}`,
    `Category: ${task.category}. Repo: ${task.repo}.`,
    "",
    task.instruction,
    "",
    "When you finish, end your reply with a section that starts with the line `SUMMARY:` followed by 3–8 plain sentences: " +
    "what you changed or found, files touched, how you verified it, and anything the requester must do next. " +
    "Do not push to any remote unless the task explicitly says to.",
  ].join("\n");
}

// ---- Run a CLI with a timeout, capturing stdout/stderr ----
function run(cmd, args, { cwd, input }) {
  return new Promise((resolve) => {
    let out = "", err = "", timedOut = false;
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + "\n" + e.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const summaryOf = (text) => {
  const m = String(text || "").match(/SUMMARY:\s*([\s\S]+)$/);
  return (m ? m[1] : String(text || "")).trim().slice(0, 2000);
};

// ---- Claude Code: `claude -p --output-format json` → cost + usage in one object ----
async function runClaude(task, repoPath) {
  const prompt = buildPrompt(task, repoPath);
  const args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", ...CLAUDE_ARGS];
  const r = await run("claude", args, { cwd: repoPath, input: prompt });
  let j = null;
  try { j = JSON.parse(r.out.trim().split("\n").filter(Boolean).pop() || "null"); } catch { /* fall through */ }
  const usage = j?.usage || {};
  const tokensIn = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const tokensOut = usage.output_tokens || 0;
  const model = j?.modelUsage ? Object.keys(j.modelUsage)[0] : (j?.model || null);
  const result = j?.result || r.out || r.err;
  const ok = !r.timedOut && r.code === 0 && j && !j.is_error;
  return { ok, result, summary: summaryOf(result), tokensIn, tokensOut,
           costUsd: j?.total_cost_usd ?? null, durationMs: j?.duration_ms ?? null, model,
           error: r.timedOut ? "timed out" : ok ? null : (j?.result || r.err || `exit ${r.code}`) };
}

// ---- Codex: `codex exec --json` → JSONL events; usage on turn/thread completion ----
async function runCodex(task, repoPath) {
  const prompt = buildPrompt(task, repoPath);
  const tmp = mkdtempSync(path.join(tmpdir(), "tracy-codex-"));
  const lastMsg = path.join(tmp, "last.md");
  const args = ["exec", "--json", "-o", lastMsg, "--sandbox", "workspace-write", ...CODEX_ARGS, prompt];
  const r = await run("codex", args, { cwd: repoPath });
  let tokensIn = 0, tokensOut = 0, model = null, text = "";
  for (const line of r.out.split("\n")) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const u = ev.usage || ev.info?.total_token_usage || ev.token_usage;
    if (u && (u.input_tokens != null || u.output_tokens != null)) {
      tokensIn = u.input_tokens ?? u.total_input_tokens ?? tokensIn;
      tokensOut = u.output_tokens ?? u.total_output_tokens ?? tokensOut;
    }
    if (ev.model) model = ev.model;
    if (ev.item?.type === "agent_message" && ev.item.text) text = ev.item.text; // last message wins
  }
  try { if (existsSync(lastMsg)) text = readFileSync(lastMsg, "utf8") || text; } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
  const ok = !r.timedOut && r.code === 0;
  const result = text || r.out || r.err;
  return { ok, result, summary: summaryOf(result), tokensIn, tokensOut,
           costUsd: priceFor(model, tokensIn, tokensOut), durationMs: null, model,
           error: r.timedOut ? "timed out" : ok ? null : (r.err || `exit ${r.code}`) };
}

// ---- Main loop ----
async function handle(task) {
  const repoPath = REPOS[task.repo];
  const t0 = Date.now();
  console.log(`[task ${task.id}] ${task.agent} · ${task.category} · ${task.repo}: ${task.instruction.slice(0, 80)}…`);
  if (!repoPath || !existsSync(repoPath)) {
    await failTask(task.id, { error: `Unknown repo '${task.repo}'. Known: ${Object.keys(REPOS).join(", ") || "(none)"}. Add it to AGENT_REPOS on the runner.` });
    console.log(`[task ${task.id}] failed: unknown repo`);
    return;
  }
  let res;
  try {
    res = task.agent === "codex" ? await runCodex(task, repoPath) : await runClaude(task, repoPath);
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  const durationMs = res.durationMs ?? (Date.now() - t0);
  if (res.ok) {
    await completeTask(task.id, { ...res, durationMs });
    console.log(`[task ${task.id}] done in ${(durationMs / 1000).toFixed(0)}s · ${res.tokensIn}+${res.tokensOut} tokens · $${(res.costUsd ?? 0).toFixed(4)}`);
    // Memory first, next time: save the outcome so the same ask is answered from knowledge.
    if (kbEnabled() && res.summary) {
      const content = `[agent:${task.agent} · ${task.category} · ${task.repo}] ${res.summary}`;
      kbAdd({ scope: "global", kind: "agent", question: `[${task.repo}] ${task.instruction}`, content }).catch(() => {});
    }
  } else {
    await failTask(task.id, { ...res, durationMs });
    console.log(`[task ${task.id}] FAILED: ${String(res.error).slice(0, 200)}`);
  }
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("\nagent-runner: stopping after the current task…"); });

while (!stopping) {
  let task = null;
  try { task = await claimTask(RUNNER_ID); } catch (err) { console.error("agent-runner: claim failed:", err.message); }
  if (task) { await handle(task); continue; }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
process.exit(0);
