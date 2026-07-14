# Tracy — the Interverse AI Assistant

One brain, many surfaces. Tracy is Interverse's assistant *everywhere* — the
desktop, mobile, and inside every app and game Interverse builds (BabyResell
first, then a car parts marketplace, then games and more). This service is her
core: every surface calls the same `POST /chat` endpoint. Nothing in the core
assumes which surface it's talking to.

## Quick start

```bash
cp .env.example .env        # paste your Anthropic API key into .env
npm install
npm start
```

Test it (note the `surface` and `userId` fields):

```bash
curl -X POST localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "surface": "babyresell",
    "userId": "u123",
    "messages": [{"role":"user","content":"I have a Chicco KeyFit 30, about a year old, good condition. What should I charge?"}]
  }'
```

Or talk to her from the terminal (no curl needed):

```bash
node scripts/talk-to-tracy.js --surface babyresell --user alice
```

## Project layout

```
tracy-ai/
├── prompts/
│   ├── tracy_system.md          # CORE identity — who Tracy is on every surface
│   └── surfaces/
│       └── babyresell.md        # per-surface extension (rules + tools for one surface)
├── src/
│   ├── server.js                # Express API + Claude tool-use loop
│   ├── surfaces.js              # resolves a surface → core + surface prompt + tool sets
│   ├── tools.js                 # tool sets, grouped by surface (stubs for now)
│   └── logging.js               # appends each exchange to logs/conversations.jsonl
├── scripts/
│   ├── talk-to-tracy.js         # terminal chat client (seed of the desktop app)
│   ├── run-personality-tests.js # runs the personality/safety suite → results table
│   └── personality-tests.json   # the 12 canonical test scenarios
├── personality-tests.md         # the test scenarios + how to run them
└── .env.example
```

## How it works

1. A surface (an app, a game, the desktop, mobile) sends the conversation to
   `POST /chat` with a `surface` and `userId`.
2. `surfaces.js` composes Tracy's system prompt: **core identity**
   (`prompts/tracy_system.md`) + a note about the current surface + that
   surface's **extension** (`prompts/surfaces/<surface>.md`, if any), and picks
   the tool sets that surface exposes.
3. Claude (as Tracy) decides whether to answer directly or call a tool. Tools
   run (stubs for now — see `src/tools.js`), results go back, and Tracy replies.
4. The exchange is logged to `logs/conversations.jsonl`
   (`{timestamp, userId, surface, messages, reply, toolsUsed}`).

### Surfaces

`surface` can be `"babyresell"`, `"carparts"`, `"desktop"`, `"mobile"`, or
`"game:NAME"` (e.g. `"game:chesswars"`). Unknown surfaces and a missing
`surface` fall back gracefully (default: `desktop`). **Add a surface** by adding
an entry to `SURFACES` in `src/surfaces.js` and, optionally, a
`prompts/surfaces/<name>.md` file. Core = who Tracy is; surface = what she does
there.

## Logging & consent

Every `/chat` exchange is recorded (`{timestamp, userId, surface, messages,
reply, toolsUsed}`) for debugging and future model training. Two backends,
chosen automatically:

- **`DATABASE_URL` set** (e.g. on Render, pointed at managed Postgres) → written
  to a `conversations` table (`src/db.js`). Survives redeploys. Table + indexes
  are created automatically on first write. Falls back to the file if a DB write
  fails.
- **`DATABASE_URL` unset** → appended to `logs/conversations.jsonl` (zero-config
  local dev). `logs/` is gitignored.

**This requires user-consent language in the apps before production** — see the
note at the top of `src/logging.js`. On Render, set `DATABASE_URL` to your
Postgres **Internal Database URL**.

## Personality & safety tests

`personality-tests.md` documents 12 tricky scenarios (expired car seat, rude
user, lowball scammer, crib safety, distress, prompt injection, etc.). With the
server running and a valid key:

```bash
node scripts/run-personality-tests.js   # writes personality-test-results.md
```

## Roadmap

- **Now**: wire the tool stubs in `src/tools.js` to the real BabyResell API
  (left as stubs on purpose — we'll do this together once the API details land).
- **Next**: image input (photograph an item → Tracy drafts the listing).
- **Then**: per-user memory keyed by `userId`; a `carparts` tool set (fitment
  lookup is the killer feature there); more surfaces.
- **Later**: use consented conversation logs to fine-tune a small model for
  high-volume narrow tasks (categorization, pricing), keeping the API model for
  open-ended chat.

## Cost control

- `claude-sonnet-4-6` for quality conversation (set via `TRACY_MODEL`); switch
  high-volume simple tasks to `claude-haiku-4-5` (much cheaper).
- Cap `max_tokens`, keep histories trimmed, and cache the system prompt once
  volume grows.

Docs: https://docs.claude.com/en/api/overview
