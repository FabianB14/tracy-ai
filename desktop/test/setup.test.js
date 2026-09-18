import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { installSkills, installedSkills, fixedPath } from "../lib/setup.js";
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
