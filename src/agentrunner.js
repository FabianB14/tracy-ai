// Agent runner library — the logic behind scripts/agent-runner.js.
//
// Executes one queued code task: prepares the repo (a local path, or a fresh
// checkout from a git URL on a `tracy/task-N` branch), runs Claude Code or
// Codex non-interactively with the repo's TRACY.md prepended, then records
// result + tokens + cost + duration, and in GitHub mode pushes the branch and
// opens a pull request. Kept separate from the polling script so it can be
// tested without starting the loop. All config is read from env at import.

import { spawn } from "child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { completeTask, failTask } from "./agents.js";
import { kbEnabled, kbAdd } from "./knowledge.js";

export const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 20 * 60 * 1000);
export const REPOS = (() => { try { return JSON.parse(process.env.AGENT_REPOS || "{}"); } catch { return {}; } })();

// GitHub mode: an AGENT_REPOS value that is a git URL is cloned/fetched fresh
// into AGENT_WORKDIR per task, worked on in a `tracy/task-N` branch, pushed,
// and turned into a pull request — so the runner needs no hand-maintained
// checkouts and can live on a cloud worker instead of your PC. Local paths
// still work as before. (file:// URLs count as remote too — handy for tests.)
export const WORKDIR = process.env.AGENT_WORKDIR || path.join(process.cwd(), ".agent-work");
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const PUSH = (process.env.AGENT_PUSH || "on").toLowerCase() !== "off";
const OPEN_PR = (process.env.AGENT_OPEN_PR || "on").toLowerCase() !== "off";
export const isRemote = (spec) => /^(https?:\/\/|git@|file:\/\/)/.test(String(spec || ""));
const EXTRA = (v) => (v ? String(v).split(/\s+/).filter(Boolean) : []);
const CLAUDE_ARGS = EXTRA(process.env.CLAUDE_ARGS);
const CODEX_ARGS = EXTRA(process.env.CODEX_ARGS);

// Codex reports tokens, not dollars. Price them ($ per 1M tokens) so runs are
// comparable with Claude Code's total_cost_usd. Override via AGENT_PRICING_JSON.
const PRICING = Object.assign(
  { "gpt-5-codex": { in: 1.25, out: 10 }, "gpt-5": { in: 1.25, out: 10 }, "o4-mini": { in: 1.1, out: 4.4 }, default: { in: 1.25, out: 10 } },
  (() => { try { return JSON.parse(process.env.AGENT_PRICING_JSON || "{}"); } catch { return {}; } })(),
);
export const priceFor = (model, tin, tout) => {
  const key = Object.keys(PRICING).find((k) => k !== "default" && String(model || "").toLowerCase().startsWith(k)) || "default";
  return (tin * PRICING[key].in + tout * PRICING[key].out) / 1e6;
};

// ---- Prompt assembly ----
export function buildPrompt(task, repoPath) {
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
export function run(cmd, args, { cwd, input } = {}) {
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

export const summaryOf = (text) => {
  const m = String(text || "").match(/SUMMARY:\s*([\s\S]+)$/);
  return (m ? m[1] : String(text || "")).trim().slice(0, 2000);
};

// ---- Git (GitHub mode) ----
// Auth goes in a per-command header (never written into .git/config), and
// commits are attributed to Tracy so the PR history is honest about the author.
const GIT_ID = ["-c", "user.name=Tracy (Interverse assistant)", "-c", "user.email=tracy@interverse.local"];
function gitAuthArgs(url) {
  if (!GITHUB_TOKEN || !/github\.com/.test(url)) return [];
  const basic = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}
async function git(args, cwd, { auth = "" } = {}) {
  const r = await run("git", [...GIT_ID, ...gitAuthArgs(auth), ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim().slice(0, 400)}`);
  return r.out.trim();
}
// Owner/repo from an https or ssh GitHub URL, for the PR API.
export function parseGithub(url) {
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Fresh, up-to-date checkout on a task branch. Returns { path, branch, base }.
export async function prepareRemoteRepo(name, url, taskId) {
  mkdirSync(WORKDIR, { recursive: true });
  const dir = path.join(WORKDIR, name);
  if (!existsSync(path.join(dir, ".git"))) {
    await git(["clone", "--quiet", url, dir], WORKDIR, { auth: url });
  } else {
    await git(["fetch", "--quiet", "--prune", "origin"], dir, { auth: url });
  }
  let head;
  try { head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir); }
  catch { await git(["remote", "set-head", "origin", "--auto"], dir, { auth: url }).catch(() => {});
          head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir).catch(() => "origin/main"); }
  const base = head.replace(/^origin\//, "");
  await git(["checkout", "--quiet", "-B", base, `origin/${base}`], dir);
  await git(["reset", "--quiet", "--hard", `origin/${base}`], dir);
  await git(["clean", "-fdq"], dir);
  const branch = `tracy/task-${taskId}`;
  await git(["checkout", "--quiet", "-B", branch], dir);
  return { path: dir, branch, base };
}

// After the agent ran: commit anything left uncommitted, push the branch, open
// a PR. Returns { changed, prUrl, branch, note } — never throws (a push/PR
// failure is reported in the summary, not treated as a failed task).
export async function publish(task, url, repoInfo) {
  const { path: dir, branch, base } = repoInfo;
  const out = { changed: false, prUrl: null, branch, note: "" };
  try {
    const dirty = await git(["status", "--porcelain"], dir);
    if (dirty) {
      await git(["add", "-A"], dir);
      await git(["commit", "--quiet", "-m", `Tracy task #${task.id}: ${task.instruction.slice(0, 60).replace(/\s+/g, " ")}`], dir);
    }
    const ahead = await git(["rev-list", "--count", `origin/${base}..HEAD`], dir);
    out.changed = Number(ahead) > 0;
    if (!out.changed) { out.note = "No code changes were made."; return out; }
    if (!PUSH) { out.note = `Changes committed on ${branch} (push disabled).`; return out; }
    await git(["push", "--quiet", "--force-with-lease", "-u", "origin", branch], dir, { auth: url });
    out.note = `Pushed branch ${branch}.`;
    const gh = parseGithub(url);
    if (OPEN_PR && GITHUB_TOKEN && gh) {
      const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "tracy-agent-runner" },
        body: JSON.stringify({
          title: `Tracy task #${task.id}: ${task.instruction.slice(0, 70).replace(/\s+/g, " ")}`,
          head: branch, base,
          body: `Task #${task.id} run by **${task.agent}** (${task.category}) for ${task.requestedBy || "the team"}.\n\n**Ask:** ${task.instruction}\n\nReview before merging — this was produced by an AI coding agent via Tracy.`,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.html_url) { out.prUrl = j.html_url; out.note = `Opened PR: ${j.html_url}`; }
      else out.note += ` (PR not opened: ${j.message || `HTTP ${res.status}`})`;
    }
  } catch (err) {
    out.note = `Publish step problem: ${err.message}`;
  }
  return out;
}

// ---- Claude Code: `claude -p --output-format json` → cost + usage in one object ----
export async function runClaude(task, repoPath) {
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
export async function runCodex(task, repoPath) {
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

// ---- One task, end to end ----
// `runners` lets tests substitute the CLI step; default = the real CLIs.
export async function handle(task, { runners = { claude: runClaude, codex: runCodex } } = {}) {
  const spec = REPOS[task.repo];
  const t0 = Date.now();
  console.log(`[task ${task.id}] ${task.agent} · ${task.category} · ${task.repo}: ${task.instruction.slice(0, 80)}…`);
  if (!spec || (!isRemote(spec) && !existsSync(spec))) {
    await failTask(task.id, { error: `Unknown repo '${task.repo}'. Known: ${Object.keys(REPOS).join(", ") || "(none)"}. Add it to AGENT_REPOS on the runner (a local path or a GitHub URL).` });
    console.log(`[task ${task.id}] failed: unknown repo`);
    return { ok: false, error: "unknown repo" };
  }
  // GitHub mode: fresh checkout on a task branch. Local mode: use the path as is.
  let repoInfo = null, repoPath = spec;
  if (isRemote(spec)) {
    try { repoInfo = await prepareRemoteRepo(task.repo, spec, task.id); repoPath = repoInfo.path; }
    catch (err) {
      await failTask(task.id, { error: `Couldn't prepare ${task.repo} from git: ${err.message}` });
      console.log(`[task ${task.id}] failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
  let res;
  try {
    res = await (runners[task.agent] || runners.claude)(task, repoPath);
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  const durationMs = res.durationMs ?? (Date.now() - t0);
  if (res.ok && repoInfo) {
    const pub = await publish(task, spec, repoInfo);
    res.prUrl = pub.prUrl; res.branch = pub.branch; res.changed = pub.changed;
    res.summary = `${res.summary}\n\n${pub.note}`.trim();
  }
  if (res.ok) {
    await completeTask(task.id, { ...res, durationMs });
    console.log(`[task ${task.id}] done in ${(durationMs / 1000).toFixed(0)}s · ${res.tokensIn}+${res.tokensOut} tokens · $${(res.costUsd ?? 0).toFixed(4)}${res.prUrl ? ` · ${res.prUrl}` : ""}`);
    // Memory first, next time: save the outcome so the same ask is answered from knowledge.
    if (kbEnabled() && res.summary) {
      const content = `[agent:${task.agent} · ${task.category} · ${task.repo}] ${res.summary}`;
      kbAdd({ scope: "global", kind: "agent", question: `[${task.repo}] ${task.instruction}`, content }).catch(() => {});
    }
  } else {
    await failTask(task.id, { ...res, durationMs });
    console.log(`[task ${task.id}] FAILED: ${String(res.error).slice(0, 200)}`);
  }
  return res;
}
