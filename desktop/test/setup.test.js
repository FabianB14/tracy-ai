import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { installSkills, installedSkills, fixedPath, registerMcp, mcpRegistered, mcpServerEntry } from "../lib/setup.js";
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


test("registration writes Claude Code's config and reads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
  const configPath = path.join(dir, ".claude.json");
  const args = { execPath: "C:\\Program Files\\Tracy\\Tracy.exe", serverPath: "C:\\Tracy\\resources\\tracy\\mcp\\server.js",
    env: { INTERVERSE_API_URL: "https://api", INTERVERSE_ADMIN_KEY: "ab&c|d", ADMIN_USER_IDS: "me" } };

  assert.equal(mcpRegistered(configPath), false);
  const r = registerMcp({ ...args, configPath });
  assert.equal(r.ok, true, r.out);
  assert.equal(mcpRegistered(configPath), true);

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const e = cfg.mcpServers["tracy-tools"];
  assert.equal(e.type, "stdio");
  assert.equal(e.command, args.execPath);
  assert.deepEqual(e.args, [args.serverPath]);
  assert.equal(e.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(e.env.INTERVERSE_ADMIN_KEY, "ab&c|d", "no shell in the way: values are stored verbatim");
});

test("registration merges into an existing config without touching other keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
  const configPath = path.join(dir, ".claude.json");
  fs.writeFileSync(configPath, JSON.stringify({ hasCompletedOnboarding: true, projects: { "/x": {} }, mcpServers: { other: { command: "o", args: [] } } }));
  const r = registerMcp({ execPath: "/t", serverPath: "/s", env: {}, configPath });
  assert.equal(r.ok, true, r.out);
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg.hasCompletedOnboarding, true);
  assert.deepEqual(cfg.projects, { "/x": {} });
  assert.ok(cfg.mcpServers.other, "existing servers survive");
  assert.ok(cfg.mcpServers["tracy-tools"]);
  // Re-registering is idempotent.
  assert.equal(registerMcp({ execPath: "/t2", serverPath: "/s", env: {}, configPath }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["tracy-tools"].command, "/t2");
});

test("a config that does not parse is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
  const configPath = path.join(dir, ".claude.json");
  fs.writeFileSync(configPath, "{ not json");
  const r = registerMcp({ execPath: "/t", serverPath: "/s", env: {}, configPath });
  assert.equal(r.ok, false);
  assert.match(r.out, /not valid JSON/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "{ not json", "untouched");
});

test("the server entry shape is what Claude Code expects", () => {
  const e = mcpServerEntry({ execPath: "/t", serverPath: "/s", env: { A: "1" } });
  assert.deepEqual(e, { type: "stdio", command: "/t", args: ["/s"], env: { A: "1", ELECTRON_RUN_AS_NODE: "1" } });
});
