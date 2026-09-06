#!/usr/bin/env node
// Tracy's agent runner — executes queued code tasks with Claude Code or Codex.
//
// Runs anywhere that has the CLIs installed: your laptop, a small VM, or a
// Render background worker. It polls the agent_tasks queue that deployed Tracy
// writes to, runs the chosen agent non-interactively inside the repo, and
// writes the result + token/cost stats back. Tracy then reports it, and the
// summary is saved to her knowledge base so the same ask is answered from
// memory next time.
//
// Repos come from AGENT_REPOS, a JSON map of name → EITHER a local path OR a
// git URL. With a GitHub URL the runner clones/fetches fresh per task, works
// on a `tracy/task-N` branch, pushes it, and opens a pull request for you to
// review (needs GITHUB_TOKEN) — so nothing has to live on your PC.
//
// Setup and options: docs/AGENT_RUNNER.md. Env reference: .env.example.
//
// Per-repo guidance: if the repo has a TRACY.md at its root, its contents are
// prepended to every task prompt (like CLAUDE.md, but for Tracy's delegated
// work). See TRACY.md in this repo for the template.

import "dotenv/config";
import { claimTask, agentsEnabled } from "../src/agents.js";
import { handle, REPOS, isRemote, GITHUB_TOKEN } from "../src/agentrunner.js";

const POLL_MS = Number(process.env.AGENT_POLL_MS || 15000);
const RUNNER_ID = process.env.AGENT_RUNNER_ID || `${process.env.USER || "runner"}@${(process.env.HOSTNAME || "local")}`;

if (!agentsEnabled()) { console.error("agent-runner: DATABASE_URL is required (it's the task queue)."); process.exit(1); }
if (!Object.keys(REPOS).length) console.error("agent-runner: AGENT_REPOS is empty — every task will fail until it's set.");
if (Object.values(REPOS).some((s) => /github\.com/.test(s)) && !GITHUB_TOKEN) console.error("agent-runner: GitHub repos configured but GITHUB_TOKEN is unset — private clones, pushes, and PRs will fail.");
console.log(`agent-runner ${RUNNER_ID}: polling every ${POLL_MS / 1000}s; repos: ${Object.entries(REPOS).map(([n, s]) => `${n}${isRemote(s) ? " (git)" : ""}`).join(", ") || "(none)"}`);

let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("\nagent-runner: stopping after the current task…"); });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  let task = null;
  try { task = await claimTask(RUNNER_ID); } catch (err) { console.error("agent-runner: claim failed:", err.message); }
  if (task) { await handle(task); continue; }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
process.exit(0);
