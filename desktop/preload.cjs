// CommonJS on purpose: renderer preloads run sandboxed, where ESM is not
// supported. This is the only bridge the windows have to the main process.
const { contextBridge, ipcRenderer } = require("electron");
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld("tracy", {
  fields: call("config:fields"), getConfig: call("config:get"), setConfig: call("config:set"),
  runnerStart: call("runner:start"), runnerStop: call("runner:stop"), runnerStatus: call("runner:status"), runnerLogs: call("runner:logs"),
  setupCheck: call("setup:check"), openLogin: call("setup:openLogin"), installSkills: call("setup:installSkills"), registerMcp: call("setup:registerMcp"),
  recentTasks: call("tasks:recent"), openExternal: call("open:external"), openChat: call("open:chat"), openSettings: call("open:settings"), openDocs: call("open:docs"),
  onRunnerChanged: (fn) => ipcRenderer.on("runner:changed", fn),
  brainStatus: call("brain:status"), brainRun: call("brain:run"), brainOpenMerge: call("brain:openMerge"),
  onBrainChanged: (fn) => ipcRenderer.on("brain:changed", fn),
  updateState: call("update:state"), updateCheck: call("update:check"), updateDownload: call("update:download"),
  updateInstall: call("update:install"), openReleases: call("update:releases"),
  onUpdateChanged: (fn) => ipcRenderer.on("update:changed", (_e, s) => fn(s)),
});
