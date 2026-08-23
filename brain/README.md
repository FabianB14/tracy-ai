# Tracy Brain

A self-maintaining knowledge base for Interverse. Ideas go in raw. A daily Claude Code
loop turns them into researched, sourced, confidence-scored entities. Tracy consumes
the entities. The graph builds itself from links.

```
raw/  ->  concepts/  ->  research/  ->  entities/  ->  Tracy
 (inbox)   (the idea)    (sourced)      (the play)
```

## Running it

This folder lives at brain/ inside the Tracy repo and shares its git history.

```bash
cd brain

# Interactive run, watch it work and approve tools:
claude "$(cat loops/daily.md)"

# Headless run with scoped permissions, once you trust it:
./loops/run-daily.sh
```

The loop commits its changes but never pushes. Brain updates ride along with
your normal pushes, so deploys are never triggered by the loop itself.

## Automate it

```bash
crontab -e
# Add (use your real absolute path):
0 7 * * * /full/path/to/tracy/brain/loops/run-daily.sh >> /full/path/to/tracy/brain/loops/daily.log 2>&1
```

The digest at the end of each run lands in daily.log. Read it with coffee.

## Getting thoughts in (the whole point)

The only manual step in this system is dropping text into raw/. Make it frictionless:

- **Voice memos (recommended):** iPhone Shortcuts or an Android automation that
  transcribes a voice memo and saves the text as a .md file into the repo folder
  (synced via iCloud Drive, Syncthing, or a working-copy git client). Name it
  anything. The loop renames nothing and judges nothing in raw/.
- **Desktop:** `echo "idea: ..." > raw/$(date +%F)-idea-slug.md`
- **Phone typing:** any notes app that can save markdown into the synced folder.

Half-sentences are fine. The loop's job is to make sense of them.

## How knowledge gets promoted

1. Raw note gets matched to an existing concept or spawns a new one (status: seed).
2. The loop researches up to 5 concepts a day with real web sources and dates.
3. When research hits confidence >= 0.7 with 3+ independent sources (or the info is
   first-party from you), the concept is distilled into an entity with a "play"
   section: the concrete way Interverse uses it.
4. Entities older than 90 days get automatically re-verified.

Anything you say about your own products is ground truth and skips the research bar.

## Plugging into Tracy

Three tiers, in order:

1. **DONE (file read):** src/brain.js reads brain/entities/ off disk, filters
   on `tracy_ready: true` and confidence >= 0.7, and injects entities whose
   title, id, alias, or tag appears in the message. Zero infrastructure; the
   entities deploy with the app.
2. **DONE (embeddings + Postgres):** entities are embedded (Gemini, same model
   as Tracy's knowledge base; cosine in JS, no pgvector needed) and upserted
   into a brain_entities table. Retrieval also matches by MEANING, so a
   question can find an entity without naming it. The server syncs the table
   at boot; the loop runs `node ../scripts/brain-sync.js` so deployed Tracy
   learns within a minute of a promotion, no redeploy. Tune with
   BRAIN_MIN_CONFIDENCE, BRAIN_MIN_SCORE, BRAIN_MAX_ENTITIES.
3. **DONE (MCP server + write-back):** mcp/brain-server.js exposes the brain to
   any MCP client over stdio: brain_search_entities (keyword + semantic),
   brain_get_entity, brain_list_entities, brain_add_note. Claude Code picks it
   up automatically from .mcp.json at the repo root (or register manually:
   `claude mcp add interverse-brain -- node mcp/brain-server.js`). With
   DATABASE_URL set it reads the same live table deployed Tracy uses; without
   it, it reads brain/entities/ off disk.

   Tracy also writes thoughts back herself: her `brain_note` chat tool queues
   ideas in a brain_raw_notes table (deployed Tracy has no durable disk), and
   the loop's ingest step runs `node ../scripts/brain-notes-pull.js` to turn
   the queue into raw/ files. Tell Tracy "add this to the brain: ..." from any
   surface and the idea enters the same pipeline as your own raw notes.

## Seeing the graph

- `graph/graph.json` regenerates every run: nodes, edges, confidence, dangling links.
  Feed it to any force-directed viewer, or have Tracy traverse it.
- Bonus: this folder is a valid Obsidian vault. Open it in Obsidian and the graph
  view lights up for free, because everything links with [[wikilinks]].

## Cost control

The loop is capped at 5 researched concepts and 60 turns per run on purpose. Raise
the caps in loops/daily.md and loops/run-daily.sh only when the digest shows a real
backlog. An unbounded research loop is how a knowledge base becomes a bill.

## Rules that keep this from becoming slop

See CLAUDE.md. Short version: no source, no promotion. Honest confidence scores.
Raw is immutable. Distill under 300 words. Every entity ends with a play.
