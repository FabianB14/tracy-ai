// Settings for Tracy Desktop — what the runner and MCP server need, stored in
// the app's user-data folder. Secrets are encrypted with the OS keychain via
// Electron's safeStorage when available; the store takes encrypt/decrypt as
// functions so the logic here runs (and is tested) in plain Node.

import fs from "fs";
import path from "path";

export const FIELDS = [
  // key, label, secret?, hint
  ["tracyUrl", "Tracy's URL", false, "https://tracy.onrender.com — her chat opens in a window"],
  ["databaseUrl", "Tracy's database URL", true, "Render → the Postgres → Connect → External Database URL. This IS the task queue."],
  ["githubToken", "GitHub token", true, "Fine-grained: Contents + Pull requests (read/write) on the repos below"],
  ["agentRepos", "Repos Tracy may work on", false, 'JSON, name → GitHub URL. Example: {"interverse":"https://github.com/FabianB14/INTERVERSE"}'],
  ["geminiKey", "Gemini API key (optional)", true, "Lets finished tasks be saved to her memory"],
  ["interverseApiUrl", "Interverse API URL", false, "https://<interverse-api host> — for the platform tools"],
  ["interverseAdminKey", "Interverse admin key", true, "The backend's ADMIN_REGISTRATION_KEY"],
  ["adminUserIds", "Your Tracy admin userId", false, "One of ADMIN_USER_IDS on her service — yours, not Josh's"],
];

export const SECRET_KEYS = FIELDS.filter(([, , secret]) => secret).map(([k]) => k);
export const DEFAULTS = { tracyUrl: "", agentRepos: "{}", startAtLogin: true, runnerAutostart: true };

export function createConfigStore({ dir, encrypt = null, decrypt = null }) {
  const file = path.join(dir, "config.json");

  function load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = {}; }
    const cfg = { ...DEFAULTS, ...(raw.plain || {}) };
    if (raw.secrets && decrypt) {
      try { Object.assign(cfg, JSON.parse(decrypt(Buffer.from(raw.secrets, "base64")))); }
      catch { /* keychain changed or corrupt: secrets must be re-entered */ }
    } else if (raw.secretsPlain) {
      Object.assign(cfg, raw.secretsPlain);
    }
    return cfg;
  }

  function save(cfg) {
    const plain = {}, secrets = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (SECRET_KEYS.includes(k)) secrets[k] = v ?? "";
      else plain[k] = v;
    }
    const out = { plain };
    if (encrypt) out.secrets = encrypt(JSON.stringify(secrets)).toString("base64");
    else out.secretsPlain = secrets; // no keychain on this platform: still local-only
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    return load();
  }

  return { load, save, file };
}

/** Env for the task runner (scripts/agent-runner.js). */
export function runnerEnv(cfg, { workDir }) {
  const env = {
    DATABASE_URL: cfg.databaseUrl || "",
    GITHUB_TOKEN: cfg.githubToken || "",
    AGENT_REPOS: normalizeRepos(cfg.agentRepos),
    AGENT_DEFAULT: "claude",
    AGENT_WORKDIR: workDir,
    AGENT_RUNNER_ID: `tracy-desktop@${cfg.adminUserIds || "local"}`,
  };
  if (cfg.geminiKey) env.GEMINI_API_KEY = cfg.geminiKey;
  return env;
}

/** Env for the MCP server (mcp/server.js) — what Claude Code launches. */
export function mcpEnv(cfg) {
  return {
    INTERVERSE_API_URL: cfg.interverseApiUrl || "",
    INTERVERSE_ADMIN_KEY: cfg.interverseAdminKey || "",
    ADMIN_USER_IDS: cfg.adminUserIds || "",
  };
}

/** Accepts the JSON textarea as typed; returns compact valid JSON or "{}". */
export function normalizeRepos(text) {
  try {
    const obj = JSON.parse(text || "{}");
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "{}";
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

/** Which required fields are still empty, for the setup checklist. */
export function missingForRunner(cfg) {
  const need = [["databaseUrl", "Tracy's database URL"], ["githubToken", "GitHub token"]];
  const missing = need.filter(([k]) => !cfg[k]).map(([, label]) => label);
  if (normalizeRepos(cfg.agentRepos) === "{}") missing.push("at least one repo");
  return missing;
}

export function missingForMcp(cfg) {
  return [["interverseApiUrl", "Interverse API URL"], ["interverseAdminKey", "Interverse admin key"], ["adminUserIds", "your admin userId"]]
    .filter(([k]) => !cfg[k]).map(([, label]) => label);
}
