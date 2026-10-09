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
│       ├── babyresell.md        # per-surface extension (rules + tools for one surface)
│       └── dualrep.md           # DualRep's study jobs (used by the dualrep_* tasks, not /chat)
├── src/
│   ├── server.js                # Express API + Claude tool-use loop
│   ├── surfaces.js              # resolves a surface → core + surface prompt + tool sets
│   ├── tools.js                 # tool sets, grouped by surface (stubs for now)
│   ├── logging.js               # appends each exchange to logs/conversations.jsonl
│   ├── aitasks.js               # AI task lane: task registry, runTask, per-caller secrets
│   ├── tasks/                   # task definitions + validators (dualrep.js, schema.js)
│   ├── extract.js               # POST /ai/extract: per-page text from PDFs, docx, web pages
│   └── pdf.js                   # pdf-parse helpers (whole text, per page, page images)
├── tests/                       # npm test (node --test, no network)
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

## AI task lane (service-to-service)

Tracy isn't only a chat brain. Other backends can call her for **structured AI
tasks** over a machine-to-machine lane — no conversation, just guaranteed-shape
JSON in and out. Two callers today: the **INTERVERSE backend** (`convert_asset`,
cross-game asset conversion) and **DualRep** (the `dualrep_*` study tasks and
`POST /ai/extract`, see [DualRep lane](#dualrep-lane)).

- **Auth**: one secret per caller, sent as `X-Service-Secret`.
  `SERVICE_SECRET` is Interverse's, `SERVICE_SECRET_DUALREP` is DualRep's. An
  unset secret locks that caller out, and **each caller can run only its own
  tasks** — a wrong secret and someone else's task both get the same
  `403 {"error":"forbidden"}`. The two values must differ (Tracy warns at boot
  if they don't).
- **Endpoint**: `POST /ai/tasks/convert_asset` with header
  `X-Service-Secret: <SERVICE_SECRET>` and body
  `{"request_id": "...", "input": {source_game, target_game, asset, target_catalog, previous_errors}}`
  (`request_id` and the last two input fields optional; `previous_errors`
  carries validator rejections from a prior attempt so the retry fixes them).
- **Response**: `200 {"ok":true, "task", "output", "model", "usage",
  "latency_ms", "request_id"?}`. The output shape is guaranteed — a forced tool
  call (`convert_asset`) or structured outputs (`dualrep_*`), validated before
  it's returned. Failures: `{"ok":false, "error", "code", "errors"?,
  "request_id"?}` with `403` (secret/caller), `400` (`unknown_task`,
  `bad_input` + `errors[]`), `413`/`415`/`422` (a file in the input can't be
  read), `503` (not available on this server) or `502` (`model_error`,
  `refused`, `truncated`, `no_output`, or `invalid_output` + `errors[]`, at most
  50, ready to send back as `previous_errors`).
- **Env**: `TRACY_TASK_MODEL` (the "fast" tier, default `claude-haiku-4-5` —
  `convert_asset` runs here, exactly as before: forced tool, temperature 0,
  1024 tokens) and `TRACY_TASK_MODEL_STRONG` (the "strong" tier, default
  `claude-sonnet-5-5`). Either can name any Claude model: Tracy leaves out
  temperature, forced tool choice and effort where a model rejects them.

`/chat` is untouched — this lane has its own auth and its own route. Each
`convert_asset` call is logged through the same training-data pipeline as chat
(`src/logging.js`); DualRep's tasks log metadata only (below). Add a task by
adding an entry to `TASKS` in `src/aitasks.js` (the fields are listed there:
`caller`, `tier`, `schema` or `tool`, `checkInput`, `checkOutput`, …); run the
tests with `npm test`.

### DualRep lane

[DualRep](https://github.com/FabianB14/DualRep) (study + strength training)
turns a person's course PDFs, documents, links and photos of handwritten notes
into a study plan and quiz cards. Its Supabase Edge Function worker runs the
pipeline one short step at a time and calls Tracy for the AI parts. Tracy
stores nothing on disk: files live in memory (the last Storage file for up to
10 minutes, see below), and every DualRep call logs **one metadata line**
(caller, task, request id, status, code, model, token counts, latency) — never
the material, the answer or an error's text.
DualRep's tasks **never fall back to Groq** (private, possibly copyrighted
uploads stay with Anthropic).

**Endpoints** (header `X-Service-Secret: <SERVICE_SECRET_DUALREP>`; any other
caller gets 403):

| Call | What it does |
|---|---|
| `POST /ai/extract` | `{url, kind: "pdf"\|"doc"\|"link", first_page?, max_pages?, request_id?}` → per-page text chunks. `url` is a signed Storage URL (a `link` may be any public https page). Returns `{ok, kind, format, bytes, total_pages, first_page, last_page, title, pages:[{page, chars, letters, needs_transcription, chunks:[{ordinal, title, content}]}], latency_ms}`. A docx or web page is one entry with `page: null`. Pages without a text layer come back `needs_transcription: true`. When `last_page < total_pages`, call again with `first_page = last_page + 1` (a slow parse stops early and says so in `last_page`). Errors: 400 `bad_input`/`bad_url`, 413 `too_large` (also a file that needs more than `EXTRACT_MAX_MEMORY_MB` to read, or more than 3 million characters of text), 415 `unsupported_type`, 422 `fetch_failed`/`timeout`/`pdf_encrypted`/`pdf_unreadable`/`doc_unreadable`/`no_text`, 503 `busy` (another file is being read: try again shortly) / `pdf_unavailable`/`doc_unavailable`. |
| `POST /ai/tasks/dualrep_transcribe_notes` | One photo of handwritten notes (`{image_url, page, subject?, previous_errors?}`) → `{status: "draft", page: {page, blank, transcript, legibility, uncertain[], diagrams[]}}`. Anthropic fetches the photo from the signed URL. JPEG/PNG/WebP only (the app converts HEIC). A URL that isn't https on one of `DUALREP_STORAGE_HOSTS` is 400 `bad_url`, as on `/ai/extract`. |
| `POST /ai/tasks/dualrep_transcribe_pdf_pages` | 1–4 scanned pages of a PDF (`{pdf_url, pages, subject?, previous_errors?}`) → `{status: "draft", pages: [...]}`. Tracy renders only those pages, one at a time, to JPEG in a child process (1568 px wide, or a 2576 px long edge for a page taller than that: the API refuses an image edge over 8000 px), within `DUALREP_RENDER_BUDGET_MS` (else 503 `render_timeout`), so a big scan isn't billed in full on every call and the model keeps most of the time. 413 `page_too_large` when a page needs more memory to render than the child may have, or its image is over the API's 10 MB. 503 `busy` while another file is read. |
| `POST /ai/tasks/dualrep_build_outline` | `{plan, existing_topics?, chunks: [{id, page, title?, excerpt ≤ 400}] (1–300), max_topics ≤ 40}` → `{topics: [{key, title, summary, existing_topic_id, chunk_ids}], unassigned_chunk_ids}`. Every chunk appears exactly once. The model sees short aliases (`c1`, `c2`, …) instead of your ids, so the answer stays small; you get your own ids back. |
| `POST /ai/tasks/dualrep_build_cards` | One topic: `{plan, topic, chunks: [{id, page, content}] (1–40), existing_cards?, card_types, max_cards ≤ 20}` → `{cards: [{key, card_type, question, answer, source_chunk_id, page, quote}], links: [{from_key, to, relation, note}]}`. |

The validators are the guardrails: transcriptions are always drafts for the
person to check (Tracy can't mark one confirmed); every card cites a chunk id
and page DualRep sent, and its `quote` must really be in that chunk; outline
topics may only use input chunk ids. Their messages name fields and indexes,
never content (they reach DualRep's job table and the phone).

**Models.** The four tasks run on the strong tier (`TRACY_TASK_MODEL_STRONG`,
default `claude-sonnet-5-5`) with structured outputs (`output_config.format`),
no temperature, a per-task time budget of 90–105 s and no SDK retries. The
budget covers the whole task: time spent preparing the input (downloading and
rendering scanned PDF pages) comes off the model call's share, so the answer
always reaches DualRep's worker, which waits 110 s per call (about 150 s per
run) and retries itself. On Claude Sonnet 5.5 and
Opus 5.x Tracy also sends `fallbacks: "default"`: if Anthropic's safety
classifiers decline a request (for example `cyber` or `frontier_llm` on course
material about security or AI), Anthropic re-runs it on another Claude model in
the same call. `TRACY_TASK_FALLBACKS=off` turns that off. A decline that
remains comes back as `502 code: "refused"` (with `category`), an answer cut
off at `max_tokens` as `code: "truncated"` — send less material rather than
retrying as is.

**Reading files safely.** The byte limits cap the download, not what a file
unpacks to (a 100 KB .docx can hold 100 MB of text). So PDFs and .docx files
are read, and scanned pages rendered, in a child process (`src/isolate.js`)
that Tracy stops past its time limit, or once its private memory passes
`EXTRACT_MAX_MEMORY_MB` (350) or what the instance has left (its cgroup
memory limit less Tracy's own memory, measured after a garbage collection, and
32 MB; Render's free plan has 512 MB for everything), whichever is less. The file then fails with 413 `too_large`
(a scanned page that is too detailed to render: 413 `page_too_large`) and
Tracy, Interverse and `/chat` stay up. The node binary and libraries the
child shares with Tracy don't count. A scanned page renders in about 230 MB
(a 12 MP scan) to 340 MB (a 600 dpi copier page, a 24 MP photo), whatever the
file size and however many pages the call has: the child collects garbage
before each full-resolution canvas and hands freed memory back to the system.
One file is read at a time: a second request meanwhile gets 503 `busy`. The last Storage file read is
kept in memory for up to 10 minutes and revalidated with `If-None-Match` on the
next request for it (Storage still checks the new signed URL and answers 304 if
it is unchanged), so the 50 batches of a 200-page scan don't download 25 MB
each against DualRep's Supabase egress.

**Costs** (estimates, not measured; from DualRep's Phase 2 research, re-check
against real `usage` once it runs):

| Model (`TRACY_TASK_MODEL_STRONG`) | Outline + cards for a 100-page course PDF | One handwritten page |
|---|---|---|
| `claude-sonnet-5-5` (default; $2 / $10 per million tokens in / out) | about $1.10 (likely $0.80–$1.80) | about $0.03 |
| `claude-haiku-5-5` ($0.10 / $0.50) | about $0.06 | about $0.002 |
| `claude-haiku-4-5` ($1 / $5; reads photos at lower resolution) | about $0.34 | about $0.006 |

Switching models is one Render variable; quality on DualRep's material has not
been compared yet. DualRep shares this Anthropic account, so its spend counts
against the same monthly limit.

**Set up on Render** (Tracy service → Environment; saving redeploys):

1. `SERVICE_SECRET_DUALREP` — a long random string. PowerShell:
   `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`
   (or `openssl rand -hex 32`). Put the same value in DualRep's GitHub secret
   `TRACY_SERVICE_SECRET`. It must differ from `SERVICE_SECRET`.
2. `DUALREP_STORAGE_HOSTS` — `<project-ref>.supabase.co` (from DualRep's
   Supabase URL). Without it every pdf, docx and photo job is refused.
3. Optional: `TRACY_TASK_MODEL_STRONG` (`claude-haiku-5-5` to save money).
4. `NODE_VERSION` — `22` (PDF reading needs Node ≥ 22.3 or 20.16–20.x; Render's
   default depends on when the service was created).
5. Merge the tracy-ai pull request (Render deploys `main`), then open `/diag`:
   `dualrepLane` should say `configured: true`, `storageHostsSet: true` and
   `storageHostsLookValid: true` (it shows yes/no and the strong model only,
   never a secret or a host).

The whole founder walkthrough, in order and click by click (Render, then
DualRep's GitHub secrets, its **Deploy backend** workflow, PowerSync and the
app), with a troubleshooting table, is in DualRep's
[`docs/SETUP.md` §17](https://github.com/FabianB14/DualRep/blob/main/docs/SETUP.md#17-phase-2-the-study-engine-on-your-phone) (on DualRep's
`main` once its Phase 2 pull request is merged; until then on its branch
`claude/bold-fermi-oglgch`).

Other knobs (all optional, in `.env.example`): `TRACY_TASK_EFFORT_STRONG`,
`TRACY_TASK_EFFORT_FAST`, `TRACY_TASK_TIMEOUT_MS`, `TRACY_TASK_FALLBACKS`, `DUALREP_RENDER_WIDTH`,
`EXTRACT_MAX_BYTES` (25 MiB), `EXTRACT_MAX_LINK_BYTES` (5 MiB),
`EXTRACT_MAX_PAGES` (100), `EXTRACT_TIMEOUT_MS` (20 s), `EXTRACT_BUDGET_MS`
(60 s), `EXTRACT_MIN_PAGE_CHARS` (10), `EXTRACT_MAX_MEMORY_MB` (350),
`EXTRACT_MAX_TEXT_CHARS` (3,000,000), `DUALREP_RENDER_BUDGET_MS` (45 s). On Render's free plan (0.1 CPU, sleeps
after 15 idle minutes) the first call after a sleep can take about a minute;
DualRep's worker wakes Tracy with `GET /health` first and retries on its next
run. If big PDFs are slow, lower `EXTRACT_MAX_PAGES` or move to a paid plan.

### Toggling the AI lane from chat (admins)

Admins on the `admin` surface (allow-listed in `ADMIN_USER_IDS`) can flip the
INTERVERSE backend's AI conversion on and off by just asking Tracy — "turn on
AI conversion", "is the AI lane on?" — via the `interverse_admin` tools, which
call the backend's `/admin/config` endpoints. Instant, no redeploy; the toggle
overrides the backend's env flag. Needs two env vars on Tracy's server:
`INTERVERSE_API_URL` (the backend's base URL) and `INTERVERSE_ADMIN_KEY` (the
backend's `ADMIN_REGISTRATION_KEY`).

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

## Per-user memory

Tracy remembers people across sessions. On each `/chat`, memory for that `userId`
is loaded and injected into her prompt ("What you remember about this user"), and
she saves durable facts herself via a core `remember` tool (available on every
surface). Memory is **global per user** — the same Tracy remembers you whether
you're on BabyResell, the desktop, or a game.

- **`DATABASE_URL` set** → `user_memory` table in Postgres (`src/memory.js`).
- **unset** → `logs/memory.json` (zero-config local dev).

Same consent caveat as logging. Tracy is instructed to save only useful,
non-sensitive facts (never passwords or payment details).

## Access control (optional)

By default the site is open. To require an **access key**, set `AUTH_SECRET` on
the server — then `/chat` is locked and visitors must redeem a key for a session
token (stored per-browser; a new browser must redeem again). The page and
`/health` stay public so the key-entry screen can load.

- **Keys** come from `ACCESS_KEYS` (comma-separated env) and/or a Postgres
  `access_keys` table. Generate managed, revocable keys:
  ```bash
  node scripts/genkey.js "Alice"   # needs DATABASE_URL; prints the key once
  ```
- Keys are stored **hashed** (SHA-256), never in plaintext. Session tokens are
  stateless HMACs signed with `AUTH_SECRET` (rotate it to invalidate all tokens;
  deactivating a DB key invalidates its tokens within ~60s).
- Enabling: on Render set `AUTH_SECRET` (e.g. `openssl rand -hex 32`) and either
  `ACCESS_KEYS` or generate DB keys. Revoke a DB key by setting `active=false`.

## Bring your own key (BYOK)

A team member can paste their own Anthropic API key in **Settings** → "Your
Anthropic API key". When set, their `/chat` requests are sent with an
`X-Anthropic-Key` header and Tracy uses *that* key for the request — so usage
bills their account instead of the shared server key. The key is stored only in
their browser, used per-request, and never logged. Blank = the shared key.
(An Anthropic **API key** from console.anthropic.com — not a Claude Pro/Max
subscription.)

## Native apps (Android + iOS)

The `web/` app is wrappable into native apps with Capacitor, which unlocks
**reliable voice on iPhone** (native speech APIs instead of Safari's limited Web
Speech). The same code runs as web *and* native: in the app,
`web/native/bridge.js` (bundled to `web/native.bundle.js`) provides native
speech-to-text and text-to-speech via `window.TracyNative`; in a browser it's
inert and Tracy falls back to the Web Speech API. See **[MOBILE.md](MOBILE.md)**
for the full build steps (Android Studio / Xcode, permissions).

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

## Claude fallback with Groq's free plan

Set `GROQ_API_KEY` in the server environment (Render service `tracy`) using a
[Groq Free Plan key](https://console.groq.com/keys). Optionally set `GROQ_MODEL`;
the default is `openai/gpt-oss-120b`. No dependency or Anthropic SDK upgrade
is needed. Keep the key out of browser code and version control. Unset it to
turn this fallback off. Restart/redeploy after changing the environment.

Claude remains primary. On model-call failures (including exhausted credit,
rate limits and outages), Groq resumes the existing chat tool loop with completed
tool results. It uses the same surface tool handlers and authorization gates.
The switch lasts for that request; the next request tries Claude again. Rejected
user-supplied Anthropic keys and oversized requests retain their existing errors.
If Groq is unavailable, the existing Gemini text backup remains available when
configured. Existing knowledge-base and PartOut Gemini-first routing is unchanged.

`/ai/tasks/:task` also falls back to Groq, preserves forced-tool output validation
and the service-secret gate, and reports the actual response model. It never
substitutes a text-only Gemini answer for a structured task result. The
exception is DualRep: its `dualrep_*` tasks (`allowFallback: false`) and
`/ai/extract` never use Groq.

Chat responses identify Groq backup and use `path: "groq-fallback"`; these answers
are excluded from knowledge caching. `/diag` reports `modelFallback.configured`,
`model` and `timeoutMs` without exposing credentials. Requests have a 20-second
Groq timeout, with no automatic Groq retries. Images, documents and Anthropic-only
server-tool history bypass this text-model fallback rather than losing content;
Gemini may still handle them. Anthropic built-in web search is not available to
Groq, though configured local `web_research` tools remain available.

The free plan has [usage limits](https://console.groq.com/docs/rate-limits), not
unlimited service. Verify your account is on the Free Plan; the integration does
not enforce account billing settings. Prompts and tool results are sent to Groq
only when fallback is attempted. Use a provider/account appropriate for your data.

Validation: `node --test "tests/*.test.js"`. The Groq tests mock both providers,
exercise failover between tool rounds, reject malformed tool calls, and cover the
structured task lane without making billable model calls. A live smoke test
requires your server-side Groq key.

### Game registration from Admin chat

Authenticated Interverse admins can ask `register_interverse_game` to register a
real game, including when Groq is answering. Provide the game ID/name, developer
and studio. This tool requires `INTERVERSE_API_URL`, `INTERVERSE_ADMIN_KEY`,
`DATABASE_URL` and `VAULT_SECRET`. The issued game key goes directly into the
operator's encrypted vault; it is never returned to the model or included in the
registration reply. Missing/unhealthy storage blocks registration before the
write. If registration succeeds but storage fails, the reply requires operator
recovery and forbids automatic re-registration. Duplicate/uncertain writes are
not retried. No license, mint, transfer, or production wallet is created.

Use the Admin surface with a personal access key bound to an `ADMIN_USER_IDS`
identity. Admin replies always reach the live model/tool path instead of replaying
cached knowledge answers. Old backup banners are removed from assistant history;
Groq is explicitly told it has the currently supplied tools. Gemini remains a
text-only final fallback and cannot perform registrations.

`/diag` now reports `interverseAdmin.registrationStorageReady` and a process-local
`modelFallback.lastAttempt` (time, success, or fixed error category/HTTP status).
These fields contain no keys, prompts, tool data or provider error bodies. If a
Groq request fails, the text backup identifies that failure instead of attributing
every failure solely to Claude credit. `lastAttempt` resets at restart and refers
to the latest attempt across the service, not a particular user.

The default Groq model is now `openai/gpt-oss-120b`. Groq retired self-serve
`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on August 16, 2026. Those
specific legacy settings are automatically mapped to `openai/gpt-oss-120b` and
`openai/gpt-oss-20b`; other explicit model overrides are preserved. See
[Groq's migration notice](https://console.groq.com/docs/deprecations).
GPT-OSS uses low reasoning effort, excludes reasoning from the response, and
requests one local tool at a time.

On startup, when Groq is configured, Tracy makes one small synthetic forced-tool
check (512 maximum completion tokens) with no user data and no real handler.
`/diag` exposes `modelFallback.modelCheck`; `ok: true` proves a live tool-call
response, not just an environment variable. `configuredModel` shows the optional
environment override and `model` shows the resolved replacement. This check uses
a small amount of provider quota and can incur usage charges on paid accounts.

Direct Admin game-registration requests use a compact Groq instruction set and
only the registration schema, retaining the whole conversation. Claude receives
its original context. The handler's result is rendered directly once registration
finishes, avoiding a second model call merely to confirm it. This reduces the
chance of the free-plan token limit interrupting confirmation after the write.
