import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { installSkills, installedSkills, fixedPath, mcpAddArgs, winQuote } from "../lib/setup.js";
import { plan, COPY } from "../scripts/stage.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the bundled skills install into a target dir, idempotently", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-skills-"));
  const src = path.join(here, "..", "skills");
  const first = installSkills([src], target).sort();
  assert.deepEqual(first, ["interverse-platform", "interverse-unity", "interverse-unreal", "tracy-dev"]);
  assert.ok(fs.existsSync(path.join(target, "tracy-dev", "SKILL.md")));
  const again = installSkills([src], target).sort();
  assert.deepEqual(again, first, "reinstall replaces cleanly");
  assert.deepEqual(installedSkills(target).sort(), first);
});

test("a folder without SKILL.md is not a skill", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "notskills-"));
  fs.mkdirSync(path.join(src, "junk"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-skills-"));
  assert.deepEqual(installSkills([src], target), []);
});

test("fixedPath keeps the current PATH and adds the usual CLI homes", () => {
  const p = fixedPath().split(path.delimiter);
  for (const part of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) assert.ok(p.includes(part));
  assert.ok(p.some((x) => /\.local[\\/]bin$/.test(x)), "~/.local/bin (native Claude Code installer)");
});

test("the staging plan ships the runtime and never the tests or web app", () => {
  const p = plan();
  for (const must of ["src", "scripts", "mcp", "skills", "package.json"]) assert.ok(p.copy.includes(must), must);
  assert.ok(!COPY.includes("tests") && !COPY.includes("web") && !COPY.includes("desktop"));
});


test("mcp add puts the server name before the variadic -e flags and closes them with --", () => {
  const args = mcpAddArgs({ execPath: "C:\\Tracy\\Tracy.exe", serverPath: "C:\\Tracy\\resources\\tracy\\mcp\\server.js",
    env: { INTERVERSE_API_URL: "https://api", INTERVERSE_ADMIN_KEY: "k", ADMIN_USER_IDS: "me" } });
  const name = args.indexOf("tracy-tools"), firstE = args.indexOf("-e"), dash = args.indexOf("--");
  assert.ok(name > -1 && name < firstE, "name must precede -e (0.1.0 bug: -e swallowed the name)");
  assert.ok(dash > firstE, "-- must close the env list");
  assert.equal(args[dash + 1], "C:\\Tracy\\Tracy.exe");
  assert.equal(args[dash + 2], "C:\\Tracy\\resources\\tracy\\mcp\\server.js");
  assert.ok(args.includes("ELECTRON_RUN_AS_NODE=1"));
  for (let i = 0; i < args.length; i++) if (args[i] === "-e") assert.match(args[i + 1], /^[A-Z_]+=/, "every -e is followed by KEY=value");
});

test("winQuote leaves plain args alone and quotes spaces and shell characters", () => {
  assert.equal(winQuote("tracy-tools"), "tracy-tools");
  assert.equal(winQuote("INTERVERSE_API_URL=https://x.onrender.com"), "INTERVERSE_API_URL=https://x.onrender.com");
  assert.equal(winQuote("C:\\Users\\Fabia\\AppData\\Local\\Programs\\Tracy\\Tracy.exe"), "C:\\Users\\Fabia\\AppData\\Local\\Programs\\Tracy\\Tracy.exe");
  assert.equal(winQuote("C:\\Program Files\\Tracy\\Tracy.exe"), '"C:\\Program Files\\Tracy\\Tracy.exe"');
  assert.equal(winQuote("INTERVERSE_ADMIN_KEY=ab&c|d"), '"INTERVERSE_ADMIN_KEY=ab&c|d"');
});
