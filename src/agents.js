// Agent tasks — Tracy delegates coding work to Claude Code or Codex.
//
// Deployed Tracy can't run CLIs against your repos, so this is a queue:
//   Tracy (chat tool)  →  agent_tasks table  →  scripts/agent-runner.js on a
//   machine with the repos + CLIs  →  result + usage back into the table  →
//   Tracy reports it, saves what was learned, and rates the run.
//
// Every run records tokens, cost, duration, and success, plus a 1–5 rating,
// per agent and per task category. The router uses those stats to pick the
// best agent for the job (cheapest agent with a strong track record), with a
// configurable default until there's enough data. DB-only: the queue IS the
// transport between the server and the runner, so a file fallback is pointless.

import { dbEnabled, query } from "./db.js";

export const CATEGORIES = ["bugfix", "feature", "refactor", "review", "explore", "test", "docs", "other"];
export const AGENTS = ["claude", "codex"];
const DEFAULT_AGENT = (process.env.AGENT_DEFAULT || "claude").toLowerCase();
const MIN_SAMPLES = Number(process.env.AGENT_MIN_SAMPLES || 3);

export function agentsEnabled() { return dbEnabled(); }

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id            BIGSERIAL PRIMARY KEY,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        requested_by  TEXT,
        surface       TEXT,
        repo          TEXT NOT NULL,
        instruction   TEXT NOT NULL,
        category      TEXT NOT NULL DEFAULT 'other',
        agent_pref    TEXT NOT NULL DEFAULT 'auto',
        agent         TEXT,
        route_reason  TEXT,
        status        TEXT NOT NULL DEFAULT 'queued',
        runner        TEXT,
        started_at    TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ,
        result        TEXT,
        summary       TEXT,
        tokens_in     INTEGER,
        tokens_out    INTEGER,
        cost_usd      REAL,
        duration_ms   INTEGER,
        model         TEXT,
        error         TEXT,
        rating        INTEGER,
        rating_note   TEXT
      );
      ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS pr_url TEXT;
      CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks (status, id);
      CREATE INDEX IF NOT EXISTS agent_tasks_user_idx   ON agent_tasks (requested_by, id DESC);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const norm = (s, allowed, dflt) => { const v = String(s || "").toLowerCase().trim(); return allowed.includes(v) ? v : dflt; };

// ---- Stats + routing ----

// Per (agent, category) aggregates from finished runs.
export async function getAgentStats() {
  if (!agentsEnabled()) return [];
  await ensureSchema();
  const { rows } = await query(`
    SELECT agent, category,
           count(*)::int                                          AS runs,
           sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END)::int  AS successes,
           avg(cost_usd)::real                                    AS avg_cost,
           avg(tokens_in + tokens_out)::real                      AS avg_tokens,
           avg(duration_ms)::real                                 AS avg_duration_ms,
           avg(rating)::real                                      AS avg_rating,
           count(rating)::int                                     AS rated
    FROM agent_tasks
    WHERE agent IS NOT NULL AND status IN ('done', 'failed')
    GROUP BY agent, category ORDER BY agent, category`);
  return rows.map((r) => ({
    agent: r.agent, category: r.category, runs: r.runs, successes: r.successes,
    successRate: r.runs ? r.successes / r.runs : 0,
    avgCost: r.avg_cost == null ? null : Number(r.avg_cost),
    avgTokens: r.avg_tokens == null ? null : Math.round(r.avg_tokens),
    avgDurationMs: r.avg_duration_ms == null ? null : Math.round(r.avg_duration_ms),
    avgRating: r.avg_rating == null ? null : Number(r.avg_rating),
    rated: r.rated,
  }));
}

// Score an agent for a category from its stats: quality first (success rate
// and rating), then cost. Returns null when there isn't enough data.
export function scoreFor(stats, agent, category) {
  const exact = stats.filter((s) => s.agent === agent && s.category === category);
  const pool = exact.length && exact[0].runs >= MIN_SAMPLES ? exact : stats.filter((s) => s.agent === agent);
  const runs = pool.reduce((a, s) => a + s.runs, 0);
  if (runs < MIN_SAMPLES) return null;
  const w = (f) => pool.reduce((a, s) => a + (f(s) ?? 0) * s.runs, 0) / runs;
  const success = w((s) => s.successRate);                       // 0..1
  const rating = w((s) => (s.avgRating == null ? 3.5 : s.avgRating)) / 5; // 0..1, neutral prior
  const cost = w((s) => s.avgCost ?? 0);                         // USD
  return { score: 0.5 * success + 0.35 * rating - 0.15 * Math.min(cost, 2) / 2, success, rating: rating * 5, cost, runs, scoped: exact.length && exact[0].runs >= MIN_SAMPLES };
}

// Pick an agent for a task. Honors an explicit preference; otherwise compares
// scores when there's data, else the default. Returns { agent, reason }.
export async function chooseAgent(category, pref = "auto") {
  const p = norm(pref, AGENTS, "auto");
  if (p !== "auto") return { agent: p, reason: "requested explicitly" };
  const stats = await getAgentStats();
  const scored = AGENTS.map((a) => ({ agent: a, s: scoreFor(stats, a, category) })).filter((x) => x.s);
  if (scored.length < 1) return { agent: DEFAULT_AGENT, reason: `default (fewer than ${MIN_SAMPLES} runs recorded yet)` };
  if (scored.length === 1) return { agent: scored[0].agent, reason: `only agent with ${MIN_SAMPLES}+ runs on record` };
  scored.sort((a, b) => b.s.score - a.s.score);
  const [best, next] = scored;
  const fmt = (x) => `${x.agent}: ${(x.s.success * 100).toFixed(0)}% success, rating ${x.s.rating.toFixed(1)}/5, ~$${x.s.cost.toFixed(3)}/run (${x.s.runs} runs${x.s.scoped ? ` in ${category}` : ", all categories"})`;
  return { agent: best.agent, reason: `${fmt(best)} beat ${fmt(next)}` };
}

// ---- Task lifecycle (server side) ----

export async function createTask({ requestedBy, surface, repo, instruction, category, agentPref }) {
  if (!agentsEnabled()) throw new Error("Agent tasks need DATABASE_URL (the queue is the transport to the runner).");
  await ensureSchema();
  const cat = norm(category, CATEGORIES, "other");
  const { agent, reason } = await chooseAgent(cat, agentPref);
  const { rows } = await query(
    `INSERT INTO agent_tasks (requested_by, surface, repo, instruction, category, agent_pref, agent, route_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [requestedBy || null, surface || null, String(repo).trim(), String(instruction).trim(), cat,
     norm(agentPref, AGENTS, "auto"), agent, reason]);
  return { id: rows[0].id, agent, reason, category: cat };
}

const toTask = (r) => r && ({
  id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, requestedBy: r.requested_by,
  repo: r.repo, instruction: r.instruction, category: r.category, agent: r.agent, routeReason: r.route_reason,
  status: r.status, summary: r.summary, result: r.result, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  costUsd: r.cost_usd == null ? null : Number(r.cost_usd), durationMs: r.duration_ms, model: r.model,
  error: r.error, rating: r.rating, ratingNote: r.rating_note, runner: r.runner, prUrl: r.pr_url || null,
  startedAt: r.started_at, finishedAt: r.finished_at,
});

export async function getTask(id) {
  if (!agentsEnabled()) return null;
  await ensureSchema();
  const { rows } = await query("SELECT * FROM agent_tasks WHERE id = $1", [Number(id)]);
  return toTask(rows[0]);
}

export async function listTasks({ requestedBy, limit = 10 } = {}) {
  if (!agentsEnabled()) return [];
  await ensureSchema();
  const { rows } = requestedBy
    ? await query("SELECT * FROM agent_tasks WHERE requested_by = $1 ORDER BY id DESC LIMIT $2", [requestedBy, limit])
    : await query("SELECT * FROM agent_tasks ORDER BY id DESC LIMIT $1", [limit]);
  return rows.map(toTask);
}

export async function rateTask(id, rating, note) {
  if (!agentsEnabled()) return null;
  await ensureSchema();
  const r = Math.max(1, Math.min(5, Math.round(Number(rating))));
  const { rows } = await query(
    "UPDATE agent_tasks SET rating = $1, rating_note = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [r, note || null, Number(id)]);
  return toTask(rows[0]);
}

export async function cancelTask(id) {
  if (!agentsEnabled()) return false;
  await ensureSchema();
  const { rowCount } = await query(
    "UPDATE agent_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'queued'", [Number(id)]);
  return rowCount > 0;
}

// ---- Runner side ----

// Atomically claim the oldest queued task. Returns the task or null.
export async function claimTask(runnerId) {
  await ensureSchema();
  const { rows } = await query(
    `UPDATE agent_tasks SET status = 'running', runner = $1, started_at = now(), updated_at = now()
     WHERE id = (SELECT id FROM agent_tasks WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [runnerId]);
  return toTask(rows[0]);
}

export async function completeTask(id, { result, summary, tokensIn, tokensOut, costUsd, durationMs, model, prUrl }) {
  await ensureSchema();
  await query(
    `UPDATE agent_tasks SET status = 'done', result = $1, summary = $2, tokens_in = $3, tokens_out = $4,
       cost_usd = $5, duration_ms = $6, model = $7, pr_url = $8, finished_at = now(), updated_at = now() WHERE id = $9`,
    [result ?? null, summary ?? null, tokensIn ?? null, tokensOut ?? null, costUsd ?? null, durationMs ?? null, model ?? null, prUrl ?? null, Number(id)]);
}

export async function failTask(id, { error, result, tokensIn, tokensOut, costUsd, durationMs, model } = {}) {
  await ensureSchema();
  await query(
    `UPDATE agent_tasks SET status = 'failed', error = $1, result = $2, tokens_in = $3, tokens_out = $4,
       cost_usd = $5, duration_ms = $6, model = $7, finished_at = now(), updated_at = now() WHERE id = $8`,
    [String(error || "unknown error").slice(0, 4000), result ?? null, tokensIn ?? null, tokensOut ?? null,
     costUsd ?? null, durationMs ?? null, model ?? null, Number(id)]);
}
