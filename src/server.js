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
import Anthropic from "@anthropic-ai/sdk";
import { buildToolkit } from "./tools.js";
import { resolveSurface } from "./surfaces.js";
import { logConversation } from "./logging.js";
import { getMemories, formatMemoryBlock } from "./memory.js";

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

// POST /chat
// Body: {
//   messages: [{ role:"user"|"assistant", content:"..." }],  // required
//   surface?: string,   // "babyresell" | "carparts" | "desktop" | "mobile" | "game:NAME"
//   userId?:  string,   // caller's user id, for logging/personalization
// }
// The client keeps conversation history and sends the whole thing each turn.
app.post("/chat", async (req, res) => {
  try {
    const { messages, surface, userId } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

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

      response = await anthropic.messages.create(params);

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
    res.status(500).json({ error: "Tracy hit a snag. Try again in a moment." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, assistant: "Tracy" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tracy is listening on :${PORT}`));
