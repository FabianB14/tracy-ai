# TRACY.md — guidance for Tracy's delegated work in this repo

Tracy (Interverse's assistant) delegates coding tasks to an AI agent (Claude
Code or Codex) that runs inside this repo. This file is prepended to every such
task, the way CLAUDE.md guides Claude Code. Keep it short and concrete: what
the agent must know to do good work here without asking.

## What this repo is
Tracy's backend + web app. Node/Express (ESM), Anthropic + Gemini SDKs, Postgres
with file fallbacks under logs/. Frontend is plain HTML/JS in web/ (a PWA).
brain/ is the Interverse knowledge base (see brain/README.md); mcp/ is its MCP
server.

## Conventions
- Match the existing style: small modules in src/, comments explain *why*, no
  frameworks or build steps for the web app.
- Anything that talks to an external service must degrade gracefully when its
  env var is unset (see src/gemini.js for the pattern).
- Never commit secrets. .env is gitignored; .env.example documents every var.
- Bump the service-worker cache name in web/sw.js whenever web/ changes.

## How to verify
- `node --check` every changed JS file.
- For server changes, start with `npm start` and hit the endpoint with curl.
- There is no test suite yet; if you add behavior, add a small script under
  scripts/ or an inline node check that proves it.

## Do not
- Do not push to any remote. Commit locally and stop.
- Do not change deploy config (Render/Vercel) or rotate keys.
- Do not edit brain/ contents except via the brain's own loop/tools.

## Done means
The change works, is verified as above, and your final message ends with
`SUMMARY:` listing files touched, how you verified, and what the requester
should do next.
