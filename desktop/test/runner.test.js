import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createRunner } from "../lib/runner.js";

// A fake "tracy root" whose scripts/agent-runner.js just echoes its env and
// stays alive, so the manager's start/stop/log plumbing is exercised for real.
function fakeRoot(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-root-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "agent-runner.js"), body);
  return root;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("start passes the env through and stop ends the process", async () => {
  const root = fakeRoot(`console.log("polling as " + process.env.AGENT_RUNNER_ID + " db=" + process.env.DATABASE_URL); setInterval(() => {}, 1000);`);
  const r = createRunner({ execPath: process.execPath, tracyRoot: root, envFn: () => ({ AGENT_RUNNER_ID: "t@x", DATABASE_URL: "pg://q" }) });
  r.start();
  await wait(600);
  assert.equal(r.status().running, true);
  assert.ok(r.logs().some((l) => l.includes("polling as t@x db=pg://q")), r.logs().join("\n"));
  r.stop();
  await wait(400);
  assert.equal(r.status().running, false);
  assert.equal(r.status().wanted, false);
});

test("a crashing runner is restarted, then given up on", async () => {
  const root = fakeRoot(`console.error("boom"); process.exit(1);`);
  const r = createRunner({ execPath: process.execPath, tracyRoot: root, envFn: () => ({}) });
  r.start();
  await wait(500);
  const s = r.status();
  assert.equal(s.running, false);
  assert.ok(s.lastExit && s.lastExit.code === 1);
  assert.ok(r.logs().some((l) => /boom/.test(l)));
  assert.equal(s.wanted, true, "still wants to run — a restart is scheduled");
  r.stop();
});
