# Tracy's code tasks: Claude Code & Codex runner

Tracy can delegate coding work to an AI coding agent and report back with the
result, what it cost, and how long it took. Because deployed Tracy has no
access to your repos or CLIs, the work runs on **a machine you control** (your
laptop, a small VM) through a queue:

```
you → Tracy: "have the agent fix the login bug in partout"
        │
        ▼
   agent_tasks (Postgres)  ◄──── scripts/agent-runner.js polls, claims, runs
        │                              │  claude -p … --output-format json
        │                              │  codex exec --json …
        ▼                              ▼
   Tracy reports: summary, tokens, $, duration, which agent
   + summary saved to her knowledge base (memory first next time)
   + you rate it 1–5 → the router learns which agent is best per task type
```

## Two ways to point it at repos

**GitHub mode (recommended):** give `AGENT_REPOS` GitHub URLs. For each task
the runner clones (or fetches) the repo fresh, works on a `tracy/task-N`
branch, commits as "Tracy (Interverse assistant)", pushes the branch, and
opens a **pull request** for you to review. Nothing is edited in place and
nothing needs to live on your PC — which also means the runner can run in
the cloud (below).

```
AGENT_REPOS={"tracy-ai":"https://github.com/FabianB14/tracy-ai","partout":"https://github.com/FabianB14/PartOut"}
GITHUB_TOKEN=github_pat_…      # fine-grained: Contents + Pull requests (read/write) on those repos
```

Tracy's task report includes the PR link. `AGENT_PUSH=off` keeps changes on
the local branch only; `AGENT_OPEN_PR=off` pushes without a PR.

**Local mode:** give it paths to checkouts on the machine instead. The agent
edits in place and commits (never pushes); you push. Handy for hands-on work.

## One-time setup (on the runner machine)

1. Install the CLIs you'll allow: [Claude Code](https://code.claude.com)
   (`claude`) and/or [Codex CLI](https://developers.openai.com/codex) (`codex`),
   each logged in (or with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set).
2. In a tracy-ai clone, `npm install`, then create `.env` with:
   ```
   DATABASE_URL=postgresql://…            # Tracy's Postgres (External URL from Render)
   GEMINI_API_KEY=…                       # optional: lets results be saved to her memory
   AGENT_REPOS=…                          # GitHub URLs (above) or local paths
   GITHUB_TOKEN=…                         # GitHub mode only
   ```
   Only repos listed in `AGENT_REPOS` can be touched. Anything else fails
   with a clear message.
3. Start it:
   ```
   node scripts/agent-runner.js
   ```
   Leave it running (tmux, a service, or just a terminal). It polls every 15s.

## Running it in the cloud (no PC involved)

With GitHub mode the runner is just a Node process with two CLIs, so it can
be a **Render Background Worker** next to Tracy's web service — tasks then
run 24/7 whether your laptop is open or not:

1. Render → New → **Background Worker** → same repo (`tracy-ai`), branch `main`.
2. Build command:
   `npm install && npm install -g @anthropic-ai/claude-code @openai/codex`
3. Start command: `node scripts/agent-runner.js`
4. Environment: `DATABASE_URL` (the *Internal* URL works here), `GEMINI_API_KEY`,
   `AGENT_REPOS` (GitHub URLs), `GITHUB_TOKEN`, plus API keys for the agents:
   `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`. In a container Codex's
   sandbox may not initialize; set `CODEX_ARGS=--sandbox danger-full-access`
   (the checkout is a throwaway clone, so this is contained).
5. `AGENT_WORKDIR=/tmp/agent-work` keeps checkouts on the ephemeral disk.

Cost note: a cloud worker bills the agents' usage to your API keys (that's what
the per-task cost stats measure), rather than a desktop subscription.

## Using it from Tracy

- *"Have the agent add a loading spinner to the PartOut scan screen."*
- *"Use Codex to review the vault code in tracy-ai for security issues."*
- *"What's the status of task 12?"* / *"Rate task 12 a 4 — it worked but missed a test."*
- *"Which agent is better for bug fixes?"* → `agent_stats`

Tasks require a **verified identity** (your personal access key) because they
run real tools against real repos.

## TRACY.md — per-repo guidance

Put a `TRACY.md` at a repo's root and the runner prepends it to every task
prompt: conventions, how to verify, what not to touch, what "done" means. It's
the equivalent of CLAUDE.md for Tracy's delegated work, and works for both
agents. `tracy-ai/TRACY.md` is a template to copy.

## Giving the agents the brain (MCP)

Both agents can query Interverse's brain while they work — search entities,
read "the play", drop a raw note — through the brain's MCP server
(`mcp/brain-server.js`).

- **Claude Code:** automatic. `.mcp.json` at the tracy-ai repo root registers
  `interverse-brain`; approve it once when prompted.
- **Codex:** register it once (global, applies to every repo Codex runs in):
  ```
  codex mcp add interverse-brain -- node /abs/path/tracy-ai/mcp/brain-server.js
  ```
  or in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.interverse-brain]
  command = "node"
  args = ["/abs/path/tracy-ai/mcp/brain-server.js"]
  [mcp_servers.interverse-brain.env]
  DATABASE_URL = "postgresql://…"   # optional: live table + semantic search
  GEMINI_API_KEY = "…"              # optional: semantic search
  ```
  Verify with `/mcp` inside a Codex session, or `codex mcp list`.

Codex reads `AGENTS.md` the way Claude Code reads `CLAUDE.md`. The runner
already prepends `TRACY.md` to every task for both agents, so you don't need
an AGENTS.md — but if a repo has one, Codex honors it too.

## How routing works

Each run records agent, category, tokens, cost (Claude Code reports USD
directly; Codex tokens are priced via `AGENT_PRICING_JSON`), duration,
success, and your rating. After `AGENT_MIN_SAMPLES` runs, the router scores
each agent per category — success rate and rating weigh most, cost pulls
down — and picks the best. Until then it uses `AGENT_DEFAULT`. Ask Tracy for
`agent_stats` any time to see the numbers and the current recommendation.

## Safety

- Local mode: the runner never pushes; agents commit locally at most, you
  push. GitHub mode: it pushes only to `tracy/task-N` branches and opens a PR
  — `main` is never touched, and you review every merge.
- Claude Code runs with `--permission-mode acceptEdits`; Codex with
  `--sandbox workspace-write`. Tighten or loosen via `CLAUDE_ARGS`/`CODEX_ARGS`.
- A task times out after `AGENT_TIMEOUT_MS` (20 min) and is marked failed.
