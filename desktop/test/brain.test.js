import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { isDue, localDate, digestFrom, claudeArgs, ALLOWED_TOOLS, winQuote, ensureNodeShim, ensureNodeModulesLink, COMPARE_URL, createBrainLoop } from "../lib/brain.js";
import { brainEnv } from "../lib/config.js";

test("a run is due once per local day, at or after the configured time", () => {
  const at = (h, m) => { const d = new Date(2026, 8, 19, h, m); return d; };
  assert.equal(isDue({ now: at(6, 59), runAt: "07:00" }), false);
  assert.equal(isDue({ now: at(7, 0), runAt: "07:00" }), true);
  assert.equal(isDue({ now: at(22, 30), runAt: "07:00" }), true, "late is still due if it hasn't run today");
  assert.equal(isDue({ now: at(9, 0), runAt: "07:00", lastRunDate: localDate(at(9, 0)) }), false, "already ran today");
  assert.equal(isDue({ now: at(9, 0), runAt: "07:00", lastRunDate: "2026-09-18" }), true, "ran yesterday");
});

test("the digest is the tail of the loop's result, from the JSON envelope or plain text", () => {
  const json = JSON.stringify({ result: "…lots of work…\n\n## Digest\n3 raw notes ingested, 2 concepts researched (0.8, 0.6), 1 promoted.", cost_usd: 0.4 });
  assert.match(digestFrom(json), /^Digest\n3 raw notes/);
  assert.match(digestFrom("plain output ending in a digest: nothing new today"), /nothing new today$/);
  assert.equal(digestFrom(""), "");
});

test("claude is invoked like run-daily.sh, with the prompt on stdin", () => {
  const a = claudeArgs();
  assert.equal(a[0], "-p");
  assert.ok(!a.some((x) => /Daily brain loop/.test(x)), "no prompt in argv");
  assert.equal(a[a.indexOf("--allowedTools") + 1], ALLOWED_TOOLS);
  assert.match(ALLOWED_TOOLS, /brain-notes-pull/, "pulls chat-queued notes");
  assert.match(ALLOWED_TOOLS, /brain-sync/, "syncs entities into Tracy");
  assert.ok(!/git push/.test(ALLOWED_TOOLS), "the loop never pushes; the app does, to its own branch");
  assert.equal(winQuote(ALLOWED_TOOLS)[0], '"', "the tool list needs quoting under cmd.exe");
});

test("the node shim is created and points at the given runtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-bin-"));
  const f = ensureNodeShim(dir, "/apps/Tracy");
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(body, /\/apps\/Tracy/);
});

test("the clone's node_modules links to the app's staged deps, idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-root-"));
  fs.mkdirSync(path.join(root, "node_modules", "pg"), { recursive: true });
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-clone-"));
  ensureNodeModulesLink(clone, root);
  ensureNodeModulesLink(clone, root);
  assert.ok(fs.existsSync(path.join(clone, "node_modules", "pg")));
});

test("brain env carries exactly the database, token and optional Gemini key", () => {
  assert.deepEqual(brainEnv({ databaseUrl: "d", githubToken: "t", interverseAdminKey: "secret" }), { DATABASE_URL: "d", GITHUB_TOKEN: "t" });
  assert.equal(brainEnv({ databaseUrl: "d", githubToken: "t", geminiKey: "g" }).GEMINI_API_KEY, "g");
});

test("a run with missing settings reports what is missing and does not touch git", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-brainwork-"));
  const loop = createBrainLoop({ execPath: process.execPath, tracyRoot: "/nowhere", workDir: work,
    findClaude: () => null, envFn: () => ({ DATABASE_URL: "", GITHUB_TOKEN: "" }) });
  const s = await loop.runOnce();
  assert.equal(s.running, false);
  assert.equal(s.lastRun.ok, false);
  assert.match(s.lastRun.error, /database URL/);
  assert.match(s.lastRun.error, /GitHub token/);
  assert.match(s.lastRun.error, /Claude Code/);
  assert.ok(!fs.existsSync(path.join(work, "tracy-ai")), "no clone attempted");
  assert.equal(s.compareUrl, COMPARE_URL);
});

test("tick runs only when enabled and due", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-brainwork-"));
  let ran = 0;
  const loop = createBrainLoop({ execPath: process.execPath, tracyRoot: "/nowhere", workDir: work,
    findClaude: () => null, envFn: () => { ran++; return { DATABASE_URL: "", GITHUB_TOKEN: "" }; } });
  assert.equal(loop.tick({ enabled: false, runAt: "00:00" }), false);
  assert.equal(ran, 0);
  assert.equal(loop.tick({ enabled: true, runAt: "00:00" }), true, "00:00 is always past, so due");
});
