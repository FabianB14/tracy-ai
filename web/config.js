// Tracy frontend config — defaults only.
// The backend URL and surface can be changed at runtime in Settings (⚙) and are
// persisted to localStorage, so you can point the same static build at any
// deployment without rebuilding.
window.TRACY_CONFIG = {
  // Tracy's backend (the Render service). Override in Settings if you move it.
  backendUrl: "https://tracy-ai.onrender.com",
  // Which surface this client represents. This build is Tracy's desktop/mobile
  // presence, so it defaults to "desktop"; switch to "babyresell" etc. in the UI.
  defaultSurface: "desktop",
};
