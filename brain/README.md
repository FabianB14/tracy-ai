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

Three tiers, do them in order:

1. **Now (file read):** Tracy's backend reads ../brain/entities/ off disk. Load
   frontmatter of all entities at startup, pull full files on demand, filter on
   `tracy_ready: true` and confidence. The entities deploy with the app, so this
   works in production with zero infrastructure.
2. **Soon (pgvector):** Tracy already runs Postgres for memory. Enable the
   pgvector extension, add a brain_entities table with an embedding column, and
   a sync script that embeds each promoted entity and upserts it. The loop runs
   the sync on promote, so deployed Tracy learns daily without a redeploy.
   Retrieval is top-k with a confidence filter, matching her confidence-gating.
3. **Later (MCP server):** Wrap the brain in a small MCP server exposing
   search_entities, get_entity, and add_raw_note. Then Tracy, Claude Code, and any
   future surface all query the same brain through one interface, and Tracy can
   write thoughts back into raw/ herself.

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
