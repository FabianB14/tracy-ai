# Daily brain loop

Work through these steps in order. Follow CLAUDE.md rules at all times. Today's date
is available via `date +%Y-%m-%d`.

## 1. Ingest

List files in raw/ (excluding raw/archive/). For each file:

- Identify the core idea or ideas. One raw file can feed multiple concepts.
- Match against existing concepts/ using titles, aliases, tags, and plain judgment.
- If a match exists: append the new material to that concept's Notes section
  (newest first, dated), add the raw file path to raw_sources, bump `updated`.
- If no match: create a new concept from _templates/concept.md with status `seed`.
  Write "Why it matters to Interverse" yourself based on what you know of the
  business. If you honestly cannot, set status `parked` and say why.
- Move the processed raw file to raw/archive/.

## 2. Research

Select up to 5 concepts. Priority order: status `researching` before `seed`, then
`priority: high` first, then most recently updated. Skip `parked` and `promoted`.

For each selected concept:

- Web search for current, credible information answering its open questions.
- Write research/r-SLUG-DATE.md from _templates/research.md. Every claim gets a
  source URL and access date. Prefer primary sources.
- Score confidence honestly. Note every contradiction you find.
- Update the concept: new open questions, status (`seed` becomes `researching`,
  `researching` becomes `verified` if the bar is met), bump `updated`.

## 3. Promote

For every concept whose latest research recommends promote_to_entity AND meets
the confidence bar in CLAUDE.md rule 2:

- Create or update the matching entities/ file from _templates/entity.md.
- Distill: summary under 300 words, sourced key facts, and a concrete "The play"
  section for Interverse.
- Set tracy_ready: true only if you would personally bet on the contents.
- Set the concept's status to `promoted`. The concept file stays put.

## 4. Maintain

- Any entity with last_verified older than 90 days: set its linked concept back
  to status `researching` so tomorrow's run re-verifies it.
- Regenerate INDEX.md completely: concepts grouped by status, entities grouped by
  type with confidence and tracy_ready flags, a "needs Fabian" section for anything
  you parked or could not resolve, and a list of orphan files (no links in or out).
- Run: node graph/build-graph.js
- Run: node ../scripts/brain-sync.js
  (Pushes tracy_ready entities into deployed Tracy's database. Prints "skipped"
  when DATABASE_URL is not set locally; that is fine, the server also syncs at
  boot.)
- If anything changed: git add . && git commit -m "brain: daily loop DATE (counts)"

## 5. Digest

End your output with a short plain-text digest:

- What came in (raw files processed, concepts touched or created)
- What got researched and the confidence scores
- What got promoted to entities
- What needs Fabian's eyes and why

Keep the digest under 200 words. It gets read on a phone.
