#!/usr/bin/env node
// Pull queued brain notes out of Postgres into brain/raw/ files.
//
// Deployed Tracy can't write durable files (Render's disk is ephemeral), so
// her brain_note tool queues notes in a brain_raw_notes table. This script —
// run on the machine that runs the daily loop, BEFORE the ingest step — turns
// each queued note into a brain/raw/DATE-slug.md file and removes it from the
// queue. The loop then ingests them like any other raw note.
//
// Usage: node scripts/brain-notes-pull.js     (needs DATABASE_URL)

import "dotenv/config";
import { pullRawNotes, writeRawNoteFile } from "../src/brain.js";

const notes = await pullRawNotes();
if (!notes.length) {
  console.log("brain-notes-pull: queue empty (or no DATABASE_URL)");
} else {
  for (const n of notes) {
    const header = `note from ${n.source || "tracy"} on ${new Date(n.ts).toISOString().slice(0, 10)}:\n\n`;
    const file = writeRawNoteFile(header + n.text, `tracy-note-${n.id}`);
    console.log(`brain-notes-pull: wrote ${file}`);
  }
  console.log(`brain-notes-pull: ${notes.length} note(s) moved into brain/raw/`);
}
process.exit(0);
