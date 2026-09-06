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

## One-time setup (on the runner machine)

1. Clone the repos you want Tracy to work on. Install the CLIs you'll allow:
   [Claude Code](https://code.claude.com) (`claude`) and/or
   [Codex CLI](https://developers.openai.com/codex) (`codex`), each logged in.
2. In the tracy-ai clone, `npm install`, then create `.env` with:
   ```
   DATABASE_URL=postgresql://…            # Tracy's Postgres (External URL from Render)
   GEMINI_API_KEY=…                       # optional: lets results be saved to her memory
   AGENT_REPOS={"tracy-ai":"/home/you/tracy-ai","partout":"/home/you/PartOut","baby-resell-app":"/home/you/baby-resell-app"}
   ```
   Only repos listed in `AGENT_REPOS` can be touched. Anything else fails
   with a clear message.
3. Start it:
   ```
   node scripts/agent-runner.js
   ```
   Leave it running (tmux, a service, or just a terminal). It polls every 15s.

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

## How routing works

Each run records agent, category, tokens, cost (Claude Code reports USD
directly; Codex tokens are priced via `AGENT_PRICING_JSON`), duration,
success, and your rating. After `AGENT_MIN_SAMPLES` runs, the router scores
each agent per category — success rate and rating weigh most, cost pulls
down — and picks the best. Until then it uses `AGENT_DEFAULT`. Ask Tracy for
`agent_stats` any time to see the numbers and the current recommendation.

## Safety

- The runner never pushes. Agents commit locally at most; you push.
- Claude Code runs with `--permission-mode acceptEdits`; Codex with
  `--sandbox workspace-write`. Tighten or loosen via `CLAUDE_ARGS`/`CODEX_ARGS`.
- A task times out after `AGENT_TIMEOUT_MS` (20 min) and is marked failed.
