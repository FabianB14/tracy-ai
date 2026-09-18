import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createConfigStore, runnerEnv, mcpEnv, normalizeRepos, missingForRunner, missingForMcp, SECRET_KEYS } from "../lib/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tracy-cfg-"));
const xor = (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a));

test("secrets are stored encrypted and round-trip", () => {
  const dir = tmp();
  const store = createConfigStore({ dir, encrypt: xor, decrypt: (b) => xor(b).toString() });
  store.save({ tracyUrl: "https://t", databaseUrl: "postgres://secret", githubToken: "ghp_x" });
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.ok(!JSON.stringify(raw).includes("postgres://secret"), "secret must not be on disk in the clear");
  assert.ok(!JSON.stringify(raw.plain).includes("ghp_x"));
  const back = store.load();
  assert.equal(back.databaseUrl, "postgres://secret");
  assert.equal(back.tracyUrl, "https://t");
});

test("without a keychain, secrets still save (plainly, locally) and load", () => {
  const store = createConfigStore({ dir: tmp() });
  store.save({ interverseAdminKey: "adm" });
  assert.equal(store.load().interverseAdminKey, "adm");
});

test("every secret field is classified as one", () => {
  for (const k of ["databaseUrl", "githubToken", "geminiKey", "interverseAdminKey"]) assert.ok(SECRET_KEYS.includes(k), k);
  assert.ok(!SECRET_KEYS.includes("adminUserIds"));
});

test("runner env carries exactly what the runner reads", () => {
  const env = runnerEnv({ databaseUrl: "db", githubToken: "tok", agentRepos: '{"x":"https://g/x"}', adminUserIds: "me" }, { workDir: "/w" });
  assert.equal(env.DATABASE_URL, "db");
  assert.equal(env.GITHUB_TOKEN, "tok");
  assert.equal(env.AGENT_REPOS, '{"x":"https://g/x"}');
  assert.equal(env.AGENT_DEFAULT, "claude");
  assert.equal(env.AGENT_WORKDIR, "/w");
  assert.ok(!("GEMINI_API_KEY" in env), "optional key absent when unset");
  assert.ok(!("INTERVERSE_ADMIN_KEY" in env), "the admin key never reaches the runner");
});

test("mcp env is only the three operator values", () => {
  const env = mcpEnv({ interverseApiUrl: "u", interverseAdminKey: "k", adminUserIds: "me", databaseUrl: "db" });
  assert.deepEqual(env, { INTERVERSE_API_URL: "u", INTERVERSE_ADMIN_KEY: "k", ADMIN_USER_IDS: "me" });
});

test("repo JSON is normalized and garbage becomes {}", () => {
  assert.equal(normalizeRepos(' { "a" : "https://x" } '), '{"a":"https://x"}');
  assert.equal(normalizeRepos("not json"), "{}");
  assert.equal(normalizeRepos("[1]"), "{}");
});

test("checklists name what is missing in plain words", () => {
  assert.deepEqual(missingForRunner({}), ["Tracy's database URL", "GitHub token", "at least one repo"]);
  assert.deepEqual(missingForRunner({ databaseUrl: "d", githubToken: "t", agentRepos: '{"a":"b"}' }), []);
  assert.deepEqual(missingForMcp({ interverseApiUrl: "u" }), ["Interverse admin key", "your admin userId"]);
});
