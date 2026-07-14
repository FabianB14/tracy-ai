// Tracy — Interverse Assistant backend
// One brain, many surfaces: the desktop app, the mobile app, and every app and
// game Interverse builds all call this same POST /chat endpoint. The core never
// assumes which surface it's talking to — that comes in on each request.
//
// Run:  npm install && npm start
// Test: curl -X POST localhost:3000/chat -H "Content-Type: application/json" \
//         -d '{"surface":"babyresell","userId":"u123","messages":[{"role":"user","content":"What should I charge for a Chicco KeyFit 30 in good condition?"}]}'

import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { buildToolkit } from "./tools.js";
import { resolveSurface } from "./surfaces.js";
import { logConversation } from "./logging.js";
import { getMemories, formatMemoryBlock } from "./memory.js";
import { authEnabled, requireAuth, handleAuth } from "./auth.js";
import { babyresellDiag, pingStats } from "./babyresell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const MODEL = process.env.TRACY_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 5;

const app = express();

// CORS: Tracy's frontends (GitHub Pages / Vercel / a wrapped desktop or mobile
// app) live on different origins than this API, so browsers need CORS to call
// /chat. Set CORS_ORIGINS to a comma-separated allowlist in production
// (e.g. "https://you.github.io,https://tracy.vercel.app"); unset = allow all,
// which is fine until auth is added.
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : undefined;
app.use(cors(CORS_ORIGINS ? { origin: CORS_ORIGINS } : undefined));

app.use(express.json({ limit: "2mb" }));

// Serve the frontend (web/) from this same server, so one URL gives both the
// UI and the API: GET / → Tracy's chat app, POST /chat → the API. You can still
// deploy web/ separately to GitHub Pages / Vercel — this is just a convenience
// so the backend URL isn't a bare "Cannot GET /".
app.use(express.static(path.join(__dirname, "..", "web")));

// POST /chat
// Body: {
//   messages: [{ role:"user"|"assistant", content:"..." }],  // required
//   surface?: string,   // "babyresell" | "carparts" | "desktop" | "mobile" | "game:NAME"
//   userId?:  string,   // caller's user id, for logging/personalization
// }
// Redeem an access key for a session token (see src/auth.js).
app.post("/auth", handleAuth);

// The client keeps conversation history and sends the whole thing each turn.
// requireAuth is a no-op unless AUTH_SECRET is configured.
app.post("/chat", requireAuth, async (req, res) => {
  try {
    const { messages, surface, userId } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Bring-your-own-key: a team member can supply their own Anthropic API key
    // (from Settings, sent as the X-Anthropic-Key header) so usage bills THEIR
    // account. It is used only for this request and never logged. Falls back to
    // the shared server key when absent.
    const byok = (req.headers["x-anthropic-key"] || "").trim();
    const client = byok.startsWith("sk-ant-") ? new Anthropic({ apiKey: byok }) : anthropic;

    // Resolve where Tracy is: core identity + surface prompt + this surface's tools.
    const resolved = resolveSurface(surface);
    const toolkit = buildToolkit(resolved.toolSets, { userId, surface: resolved.id });

    // Per-user memory: load what Tracy remembers about this user and inject it
    // into her system prompt so she recalls them across sessions. Best-effort —
    // a memory-store hiccup must never block a reply.
    let systemPrompt = resolved.systemPrompt;
    if (userId) {
      try {
        const memoryBlock = formatMemoryBlock(await getMemories(userId));
        if (memoryBlock) systemPrompt += "\n\n---\n\n" + memoryBlock;
      } catch (err) {
        console.error("memory load failed:", err.message);
      }
    }

    const convo = [...messages];
    const toolsUsed = [];
    let response;

    // Tool-use loop: keep going until Tracy answers in plain text.
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const params = {
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: convo,
      };
      // Only send tools when this surface actually has some.
      if (toolkit.schemas.length > 0) params.tools = toolkit.schemas;

      response = await client.messages.create(params);

      if (response.stop_reason !== "tool_use") break;

      // Execute every tool Claude asked for, append results, loop again.
      convo.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolsUsed.push(block.name);
        let result;
        try {
          result = await toolkit.run(block.name, block.input);
        } catch (err) {
          result = { error: String(err) };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      convo.push({ role: "user", content: toolResults });
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Log the exchange (see src/logging.js — needs user-consent language in the
    // apps before production).
    logConversation({
      userId,
      surface: resolved.id,
      messages,
      reply: text,
      toolsUsed,
    });

    res.json({ reply: text, surface: resolved.id, toolsUsed });
  } catch (err) {
    console.error(err);
    // If a user supplied their own key and it was rejected, tell them plainly.
    // Use 400 (not 401) so the frontend doesn't mistake it for the access gate.
    const hadKey = (req.headers["x-anthropic-key"] || "").trim().startsWith("sk-ant-");
    if (hadKey && (err?.status === 401 || err?.status === 403)) {
      return res.status(400).json({ error: "Your Anthropic API key was rejected. Check it in Settings, or clear it to use the shared key." });
    }
    res.status(500).json({ error: "Tracy hit a snag. Try again in a moment." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, assistant: "Tracy", authRequired: authEnabled() }));

// GET /diag?userId=<your Tracy userId>
// One-shot admin wiring check. Open it in a browser to see, in plain yes/no,
// exactly which layer is (or isn't) connecting BabyResell — without exposing
// any secret or any business number. Steps it verifies, in order:
//   1. adminUserIdsSet   — is ADMIN_USER_IDS configured at all?
//   2. userIdIsAdmin     — does the userId you pass match that allowlist?
//   3. babyresell.*      — is BABYRESELL_API_URL + a credential present?
//   4. livePing          — can Tracy actually reach BabyResell with the key?
// If userIdIsAdmin is false, the live ping is skipped (same default-deny as the
// real tools) so this can't be used to probe your stats.
app.get("/diag", async (req, res) => {
  const allow = (process.env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const userId = String(req.query.userId || "").trim();
  const userIdIsAdmin = allow.length > 0 && userId !== "" && allow.includes(userId);

  const br = babyresellDiag();
  const out = {
    adminSurfaceAvailable: true,
    adminUserIdsSet: allow.length > 0,
    adminUserIdsCount: allow.length,
    youPassedUserId: userId || null,
    userIdIsAdmin,
    babyresell: br,
  };

  // Only ping live if the caller proved they're an allow-listed admin AND the
  // connection is configured — mirrors the tool's own gate.
  if (userIdIsAdmin && br.configured) {
    out.livePing = await pingStats();
  } else if (!br.configured) {
    out.livePing = { ok: false, reason: "babyresell-not-configured (set BABYRESELL_API_URL + a credential)" };
  } else {
    out.livePing = { ok: false, reason: "skipped (pass ?userId=<an ADMIN_USER_IDS value> to run the live check)" };
  }

  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tracy is listening on :${PORT}`));
