// Tracy Desktop — Electron main process.
//
// A tray app that turns Tracy into a full-time agent on this PC: it runs her
// task runner (scripts/agent-runner.js) in the background with Electron's own
// Node, serves her tools to Claude Code over MCP, installs the bundled skills,
// and opens her chat in a window. Nothing here talks to a model — the runner
// hands work to Claude Code, which runs on the person's own subscription.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, safeStorage, dialog } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { createConfigStore, runnerEnv, mcpEnv, brainEnv, missingForRunner, missingForMcp, FIELDS } from "./lib/config.js";
import { createBrainLoop } from "./lib/brain.js";
import { createRunner } from "./lib/runner.js";
import * as setup from "./lib/setup.js";
import electronUpdater from "electron-updater";
import { describeCheck, inPlaceUpdates, RELEASES_URL } from "./lib/updates.js";
const { autoUpdater } = electronUpdater;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where Tracy's own code lives: the staged copy inside the packaged app, or
// the repo root when running from source.
const TRACY_ROOT = app.isPackaged ? path.join(process.resourcesPath, "tracy") : path.join(__dirname, "..");
const SKILL_DIRS = app.isPackaged
  ? [path.join(TRACY_ROOT, "skills")]
  : [path.join(TRACY_ROOT, "skills"), path.join(__dirname, "skills")];
const ICON = path.join(__dirname, "build", "icon.png");

if (!app.requestSingleInstanceLock()) app.quit();

let tray = null, statusWin = null, settingsWin = null, chatWin = null;
let store, runner, brain;

function userDir() { return app.getPath("userData"); }

function makeStore() {
  const enc = safeStorage.isEncryptionAvailable();
  return createConfigStore({
    dir: userDir(),
    encrypt: enc ? (s) => safeStorage.encryptString(s) : null,
    decrypt: enc ? (b) => safeStorage.decryptString(b) : null,
  });
}

function makeRunner() {
  return createRunner({
    execPath: process.execPath,
    tracyRoot: TRACY_ROOT,
    envFn: () => ({ ...runnerEnv(store.load(), { workDir: path.join(userDir(), "agent-work") }), PATH: setup.fixedPath() }),
    onChange: () => { refreshTray(); statusWin?.webContents.send("runner:changed"); },
  });
}

function makeBrain() {
  return createBrainLoop({
    execPath: process.execPath,
    tracyRoot: TRACY_ROOT,
    workDir: path.join(userDir(), "brain-work"),
    findClaude: setup.findClaude,
    envFn: () => brainEnv(store.load()),
    pathFn: setup.fixedPath,
    onChange: () => { statusWin?.webContents.send("brain:changed"); refreshTray(); },
  });
}

function win(opts) {
  return new BrowserWindow({
    width: 760, height: 640, icon: ICON, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
    ...opts,
  });
}

function openStatus() {
  if (statusWin) return statusWin.focus();
  statusWin = win({ title: "Tracy — status" });
  statusWin.loadFile(path.join(__dirname, "ui", "status.html"));
  statusWin.once("ready-to-show", () => statusWin.show());
  statusWin.on("closed", () => { statusWin = null; });
}

function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = win({ title: "Tracy — settings", width: 680, height: 760 });
  settingsWin.loadFile(path.join(__dirname, "ui", "settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => { settingsWin = null; });
}

function openChat() {
  const url = store.load().tracyUrl;
  if (!url) { openSettings(); return; }
  if (chatWin) return chatWin.focus();
  chatWin = new BrowserWindow({ width: 480, height: 780, icon: ICON, title: "Tracy", autoHideMenuBar: true });
  chatWin.loadURL(url);
  chatWin.on("closed", () => { chatWin = null; });
}

function refreshTray() {
  if (!tray) return;
  const s = runner.status();
  const b = brain ? brain.status() : { running: false };
  tray.setToolTip(`Tracy — runner ${s.running ? "running" : "stopped"}${b.running ? ", brain loop running" : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Tracy", click: openChat },
    { label: "Status & setup", click: openStatus },
    { label: "Settings", click: openSettings },
    { type: "separator" },
    s.running
      ? { label: "Stop runner", click: () => runner.stop() }
      : { label: "Start runner", click: () => startRunnerChecked() },
    { type: "separator" },
    ...(updateState.state === "available" || updateState.state === "available-manual" || updateState.state === "ready"
      ? [{ label: updateState.state === "ready" ? `Restart to update to ${updateState.latest}` : `Update to ${updateState.latest} available…`,
           click: openStatus }, { type: "separator" }]
      : []),
    { label: "Quit Tracy", click: () => { runner.stop(); app.exit(0); } },
  ]));
}

function startRunnerChecked() {
  const missing = missingForRunner(store.load());
  if (missing.length) {
    dialog.showMessageBox({ type: "info", message: "Finish setup first", detail: `Still needed: ${missing.join(", ")}.` });
    openSettings();
    return runner.status();
  }
  return runner.start();
}

// ---- IPC: the windows talk to main through these ----
ipcMain.handle("config:fields", () => FIELDS);
ipcMain.handle("config:get", () => store.load());
ipcMain.handle("config:set", (_e, cfg) => {
  const saved = store.save(cfg);
  app.setLoginItemSettings({ openAtLogin: Boolean(saved.startAtLogin) });
  refreshTray();
  return saved;
});
ipcMain.handle("runner:start", () => startRunnerChecked());
ipcMain.handle("runner:stop", () => runner.stop());
ipcMain.handle("runner:status", () => runner.status());
ipcMain.handle("runner:logs", () => runner.logs());
ipcMain.handle("setup:check", () => {
  const cfg = store.load();
  const claudePath = setup.findClaude();
  return {
    claudePath,
    claudeVersion: setup.claudeVersion(claudePath),
    skillsInstalled: setup.installedSkills(),
    skillsAvailable: SKILL_DIRS.flatMap((d) => { try { return fs.readdirSync(d); } catch { return []; } }),
    mcpRegistered: setup.mcpRegistered(),
    missingRunner: missingForRunner(cfg),
    missingMcp: missingForMcp(cfg),
    tracyRoot: TRACY_ROOT,
  };
});
ipcMain.handle("setup:openLogin", () => { setup.openLoginTerminal(); return true; });
ipcMain.handle("setup:installSkills", () => setup.installSkills(SKILL_DIRS));
ipcMain.handle("setup:registerMcp", () => {
  const cfg = store.load();
  const missing = missingForMcp(cfg);
  if (missing.length) return { ok: false, out: `Still needed in Settings: ${missing.join(", ")}.` };
  return setup.registerMcp({ execPath: process.execPath, serverPath: path.join(TRACY_ROOT, "mcp", "server.js"), env: mcpEnv(cfg) });
});
ipcMain.handle("tasks:recent", async () => {
  const cfg = store.load();
  if (!cfg.databaseUrl) return { error: "no database URL" };
  try {
    process.env.DATABASE_URL = cfg.databaseUrl; // db.js reads it when the pool is made
    const agents = await import(pathToFileURL(path.join(TRACY_ROOT, "src", "agents.js")).href);
    const tasks = await agents.listTasks({ limit: 15 });
    return { tasks };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});
ipcMain.handle("brain:status", () => brain.status());
ipcMain.handle("brain:run", () => brain.runOnce({ reason: "manual" }));
ipcMain.handle("brain:openMerge", () => shell.openExternal(brain.status().compareUrl));
ipcMain.handle("open:external", (_e, url) => shell.openExternal(url));
ipcMain.handle("open:chat", () => openChat());
ipcMain.handle("open:settings", () => openSettings());
ipcMain.handle("open:docs", () => shell.openExternal("https://github.com/FabianB14/tracy-ai/blob/main/desktop/README.md"));

// ---- Updates ----
// Feed: electron-builder's generic provider pointed at GitHub's
// releases/latest/download redirect (see package.json "publish"), so any tag
// name works and no API token is needed. The app only ever downloads when
// asked; a found update is announced in the tray and the status window.
let updateState = { state: "idle", current: app.getVersion() };
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  statusWin?.webContents.send("update:changed", updateState);
  refreshTray();
}
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on("download-progress", (p) => setUpdate({ state: "downloading", percent: Math.round(p.percent) }));
autoUpdater.on("update-downloaded", (info) => setUpdate({ state: "ready", latest: info.version }));
autoUpdater.on("error", (err) => setUpdate({ state: "error", message: `Update failed: ${err?.message || err}` }));

async function checkForUpdates({ quiet = false } = {}) {
  if (!app.isPackaged) { setUpdate(describeCheck({ current: app.getVersion(), latest: null })); return updateState; }
  if (!quiet) setUpdate({ state: "checking", message: "Checking…" });
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r?.updateInfo?.version || null;
    setUpdate(describeCheck({ current: app.getVersion(), latest }));
  } catch (err) {
    if (quiet) setUpdate({ state: "idle" });
    else setUpdate(describeCheck({ current: app.getVersion(), error: err?.message || String(err) }));
  }
  return updateState;
}

ipcMain.handle("update:state", () => updateState);
ipcMain.handle("update:check", () => checkForUpdates());
ipcMain.handle("update:download", async () => {
  if (!inPlaceUpdates()) { shell.openExternal(RELEASES_URL); return updateState; }
  setUpdate({ state: "downloading", percent: 0 });
  try { await autoUpdater.downloadUpdate(); } catch (err) { setUpdate({ state: "error", message: `Download failed: ${err?.message || err}` }); }
  return updateState;
});
ipcMain.handle("update:install", () => { runner.stop(); setImmediate(() => autoUpdater.quitAndInstall(false, true)); return true; });
ipcMain.handle("update:releases", () => shell.openExternal(RELEASES_URL));

app.on("second-instance", openStatus);
app.on("window-all-closed", () => { /* stay in the tray */ });

app.whenReady().then(() => {
  store = makeStore();
  runner = makeRunner();
  brain = makeBrain();
  const img = nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.on("click", openStatus);
  refreshTray();

  const cfg = store.load();
  const firstRun = !fs.existsSync(store.file);
  if (firstRun) { openSettings(); openStatus(); }
  else if (cfg.runnerAutostart && !missingForRunner(cfg).length) runner.start();
  if (!firstRun) openStatus();

  // Brain loop: once a day at the configured time, only when the runner
  // settings are complete (it needs the same database URL and token).
  setInterval(() => {
    const c = store.load();
    if (missingForRunner(c).length) return;
    brain.tick({ enabled: c.brainEnabled !== false, runAt: c.brainRunAt || "07:00" });
  }, 60_000);

  setTimeout(() => checkForUpdates({ quiet: true }), 20_000);
  setInterval(() => checkForUpdates({ quiet: true }), 6 * 60 * 60 * 1000);
});
