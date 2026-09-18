// Update policy, kept free of Electron so it can be tested in plain Node.
//
// Windows: NSIS + electron-updater can download and apply a new build in
// place, unsigned included. macOS: in-place updates need a signed app
// (Squirrel.Mac refuses otherwise), and ours is unsigned, so the honest
// action there is to open the download page. Linux AppImage would work but
// we don't ship it to anyone.

export const RELEASES_URL = "https://github.com/FabianB14/tracy-ai/releases/latest";

/** Can this platform update itself in place? */
export function inPlaceUpdates(platform = process.platform) {
  return platform === "win32";
}

/** Compare "x.y.z" strings; positive if a > b. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/** Turn an updater result into what the window shows. */
export function describeCheck({ current, latest, platform = process.platform, error = null }) {
  if (error) return { state: "error", message: `Couldn't check for updates: ${error}`, current };
  if (!latest || !isNewer(latest, current)) return { state: "current", message: `You're on the latest version (${current}).`, current };
  if (!inPlaceUpdates(platform)) {
    return { state: "available-manual", message: `Version ${latest} is available. This platform can't update in place — download it from the releases page.`, current, latest, url: RELEASES_URL };
  }
  return { state: "available", message: `Version ${latest} is available.`, current, latest };
}
