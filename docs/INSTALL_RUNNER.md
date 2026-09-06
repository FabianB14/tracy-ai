# Install Tracy's runner on your PC

Tracy (Interverse's assistant) can hand real coding tasks to an AI coding
agent — Claude Code or Codex — and report back with the result, what it cost,
and a pull request to review. Tracy herself runs in the cloud and can't run
those tools, so a small program called the **runner** does it on a PC:

```
you → Tracy: "have the agent fix the login bug in partout"
                    │
                    ▼
        Tracy's database (task queue)
                    │
                    ▼   ← the runner on your PC picks it up
   clones the repo → runs Claude Code / Codex → pushes a branch → opens a PR
                    │
                    ▼
   Tracy: "Done. Here's the summary, cost, and the PR link."
```

The runner uses **your own** Claude and ChatGPT logins, so tasks run on the
subscriptions you already have — no API bills. It only ever pushes to
`tracy/task-N` branches; `main` is never touched.

## Before you start, have these ready

1. **Tracy's database URL** — from Fabian, or Render → the Postgres →
   *Connect → External Database URL*.
2. **A GitHub token** — GitHub → your avatar → *Settings → Developer settings →
   Personal access tokens → Fine-grained → Generate*. Repository access:
   *Only select repositories* (the ones Tracy may work on). Permissions →
   Repository: **Contents: Read and write**, **Pull requests: Read and write**.
3. **The Gemini API key** (optional) — same one Tracy uses; lets finished
   tasks be saved to her memory. Ask Fabian.
4. Logins for **Claude** (claude.ai) and/or **ChatGPT** (for Codex).

## Install (about 10 minutes)

**Windows:** install [Git for Windows](https://git-scm.com) and
[Node.js LTS](https://nodejs.org) if you don't have them, then open **Git Bash**.
**Mac:** install Node.js LTS; use Terminal.

```bash
cd ~
git clone https://github.com/FabianB14/tracy-ai.git
cd tracy-ai
npm install
npm run runner:setup
```

The setup asks for the items above, writes them to a private `.env` file in
that folder (never leaves your PC, never goes to git), and installs the agents
you choose. Then log in once each:

```bash
claude          # opens a browser login for your Claude account — type /exit when it's in
codex login     # ChatGPT account
```

## Run it

```bash
npm run runner
```

You'll see `agent-runner …: polling every 15s; repos: …`. **Leave that window
open** — that's the runner working. If you close it, Tracy's tasks simply wait
in the queue and run when you start it again. To stop: Ctrl-C.

## Try it

In Tracy (signed in with your personal access key — Settings → Identity &
access), say:

> Have the agent add a short comment at the top of PartOut's README explaining what the app does.

Watch the runner window. Then ask Tracy *"what's the status of that task?"* —
you'll get the summary, tokens, cost, duration, which agent ran it, and a
GitHub pull-request link. Review and merge the PR like any other.

Other things to say to her:

- *"Use Codex to review the vault code in tracy-ai for security issues."*
- *"Rate task 12 a 4 — it worked but skipped a test."* (ratings teach Tracy
  which agent is best for which kind of job)
- *"Which agent is better for bug fixes?"*

## If something's off

| Symptom | Fix |
|---|---|
| `DATABASE_URL is required` | Re-run `npm run runner:setup` and paste the database URL. |
| Task fails with *Unknown repo* | The repo isn't in your setup list — re-run setup and add its GitHub URL. |
| Task fails cloning / pushing | Token missing a permission or the repo isn't selected on it. Regenerate the token. |
| `claude: command not found` after install | Close and reopen Git Bash so PATH refreshes. |
| Agent errors about login | Run `claude` or `codex login` again. |

## Alternative: run it in the cloud instead (no PC)

If nobody wants a window open, the runner can be a **Render Background
Worker** so tasks run 24/7. The trade-off: without a browser to log in, the
agents use API keys and bill per token instead of your subscriptions. Steps
are in `docs/AGENT_RUNNER.md` ("Running it in the cloud").
