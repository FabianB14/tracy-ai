// Surface resolution — how Tracy adapts to where she's running.
//
// One brain, many surfaces. The CORE prompt (prompts/tracy_system.md) is who
// Tracy is everywhere. Each surface (an app, a game, the desktop, mobile) can
// layer a prompt extension (prompts/surfaces/<name>.md) and its own tool sets on
// top. Nothing here assumes a web client or a specific product.
//
// To add a surface: add an entry to SURFACES below and (optionally) drop a
// prompts/surfaces/<prompt>.md file next to babyresell.md. A surface with no
// prompt file and no tool sets still works — Tracy just runs as a general
// Interverse assistant on it.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");
const SURFACES_DIR = path.join(PROMPTS_DIR, "surfaces");

// Core identity, read once at startup.
const CORE_PROMPT = readFileSync(path.join(PROMPTS_DIR, "tracy_system.md"), "utf-8");

// Which surface Tracy defaults to when a request doesn't name one. The desktop
// is her "home base" — a general Interverse assistant with no app-specific tools.
const DEFAULT_SURFACE = "desktop";

// Per-surface config.
//   prompt    — basename of prompts/surfaces/<prompt>.md (optional; omit if none yet)
//   toolSets  — names of tool sets from src/tools.js this surface exposes
// Surfaces listed without a prompt file just get the core identity plus a note
// about which surface they're on.
const SURFACES = {
  babyresell: { prompt: "babyresell", toolSets: ["babyresell"] },
  carparts:   { prompt: "carparts",   toolSets: [] }, // fitment tools TBD
  desktop:    { prompt: "desktop",    toolSets: [] },
  mobile:     { prompt: "mobile",     toolSets: [] },
  // `game:NAME` requests resolve to this generic game surface, with NAME passed
  // through to the prompt. See resolveSurface().
  game:       { prompt: "game",       toolSets: [] },
};

// Cache surface-extension file contents (null = no file, don't re-check).
const promptCache = new Map();

function loadSurfacePrompt(promptName) {
  if (!promptName) return null;
  if (promptCache.has(promptName)) return promptCache.get(promptName);

  const file = path.join(SURFACES_DIR, `${promptName}.md`);
  const contents = existsSync(file) ? readFileSync(file, "utf-8") : null;
  promptCache.set(promptName, contents);
  return contents;
}

// Resolve a raw surface string into everything /chat needs.
// Returns: { id, systemPrompt, toolSets }
//   id         — normalized surface id (e.g. "babyresell", "game:chesswars")
//   systemPrompt — core identity + surface extension + a "current surface" note
//   toolSets   — tool-set names to build a toolkit from
export function resolveSurface(rawSurface) {
  const id = String(rawSurface || DEFAULT_SURFACE).trim() || DEFAULT_SURFACE;

  // `game:NAME` namespace → generic "game" surface, NAME injected into context.
  let configKey = id;
  let gameName = null;
  if (id.toLowerCase().startsWith("game:")) {
    gameName = id.slice(id.indexOf(":") + 1).trim() || "an Interverse game";
    configKey = "game";
  }

  const config = SURFACES[configKey] || { prompt: null, toolSets: [] };
  const extension = loadSurfacePrompt(config.prompt);

  // Compose: core identity, then a dynamic note telling Tracy her current
  // surface, then the surface's own extension (if any).
  const parts = [CORE_PROMPT.trim()];

  let surfaceNote = `## Current surface\nYou are currently running on the \`${id}\` surface.`;
  if (gameName) {
    surfaceNote += ` You are embedded inside the game "${gameName}". Be helpful in the context of that game while staying the same Tracy.`;
  }
  parts.push(surfaceNote);

  if (extension) parts.push(extension.trim());

  return {
    id,
    systemPrompt: parts.join("\n\n---\n\n"),
    toolSets: config.toolSets,
  };
}
