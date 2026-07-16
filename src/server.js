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
import { getAdminIds } from "./tools.js";
import { getSubscription, setSubscription, listDigestSubscribers, markSent, localNow, isDue } from "./subscriptions.js";
import { buildDigest, knownApps, APPS } from "./digest.js";
import { sendEmail, emailConfigured } from "./email.js";
import { pushConfigured, getPublicKey, savePushSub, removePushSub, sendPushToUser } from "./push.js";

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
    const { messages, surface, userId, tz } = req.body;
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
    const toolkit = buildToolkit(resolved.toolSets, { userId, surface: resolved.id, tz });

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

      // Record server-side tool calls (e.g. web_search) for logging/visibility.
      // These run on Anthropic's side, so there's nothing to execute here.
      for (const block of response.content) {
        if (block.type === "server_tool_use") toolsUsed.push(block.name);
      }

      // A long server-tool turn (e.g. several web searches) can stop with
      // "pause_turn". Resume by re-sending the conversation as-is — no extra
      // user message; the API continues where it left off.
      if (response.stop_reason === "pause_turn") {
        convo.push({ role: "assistant", content: response.content });
        continue;
      }

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
  const allow = getAdminIds();
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

// --- Notification subscriptions (daily check-in digests) ---

// GET /subscription?userId=... — load a user's digest prefs + the app list.
app.get("/subscription", requireAuth, async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "userId required" });
  const sub = await getSubscription(userId);
  res.json({
    apps: knownApps(),
    emailReady: emailConfigured(),
    subscription: sub || { email: "", apps: [], digest: false },
  });
});

// POST /subscription — save a user's digest prefs. Body: {userId, email, apps[], digest}.
app.post("/subscription", requireAuth, async (req, res) => {
  const { userId, email, apps, digest, time, tz } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  // Merge with existing so omitted fields (e.g. a time set via chat) are kept.
  const cur = (await getSubscription(userId)) || {};
  const ok = await setSubscription(userId, {
    email: email !== undefined ? email : cur.email,
    apps: apps !== undefined ? apps : cur.apps,
    digest: digest !== undefined ? digest : cur.digest,
    time: time !== undefined ? time : cur.time,
    tz: tz !== undefined ? tz : cur.tz,
  });
  res.json({ ok });
});

// POST /subscription/test — send THIS user their digest right now, to verify
// email works without waiting for the scheduled run.
app.post("/subscription/test", requireAuth, async (req, res) => {
  const userId = String((req.body && req.body.userId) || "").trim();
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!emailConfigured()) return res.status(400).json({ error: "Email isn't set up on the server yet (EMAIL_API_KEY / EMAIL_FROM)." });
  const sub = await getSubscription(userId);
  if (!sub || !sub.email) return res.status(400).json({ error: "Add your email and save first." });
  const apps = sub.apps && sub.apps.length ? sub.apps : Object.keys(APPS);
  try {
    const { subject, text, html } = await buildDigest(apps);
    const r = await sendEmail({ to: sub.email, subject: "[Test] " + subject, text, html });
    return r.ok ? res.json({ ok: true, to: sub.email }) : res.status(502).json({ error: r.error });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Push notifications (to the installed app on a phone/desktop) ---

// GET /push/config — public VAPID key + whether push is set up on the server.
app.get("/push/config", (_req, res) => res.json({ configured: pushConfigured(), publicKey: getPublicKey() }));

// POST /push/subscribe — save this device's push subscription for a user.
app.post("/push/subscribe", requireAuth, async (req, res) => {
  const { userId, subscription } = req.body || {};
  if (!userId || !subscription || !subscription.endpoint) return res.status(400).json({ error: "userId + subscription required" });
  const ok = await savePushSub(userId, subscription);
  res.json({ ok });
});

// POST /push/unsubscribe — forget a device (by its endpoint).
app.post("/push/unsubscribe", requireAuth, async (req, res) => {
  const endpoint = (req.body && req.body.endpoint) || "";
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  await removePushSub(endpoint);
  res.json({ ok: true });
});

// POST /push/test — send a test push to the current user's devices now.
app.post("/push/test", requireAuth, async (req, res) => {
  const userId = String((req.body && req.body.userId) || "").trim();
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!pushConfigured()) return res.status(400).json({ error: "Push isn't set up on the server yet (VAPID keys)." });
  const sent = await sendPushToUser(userId, { title: "Tracy", body: "Push notifications are working 🎉", url: "/" });
  res.json(sent ? { ok: true, sent } : { error: "No registered devices for this user (enable notifications on a device first)." });
});

// POST /tasks/daily — send digests to everyone whose local send-time has passed
// today and who hasn't been sent yet. Run this FREQUENTLY (e.g. hourly): each
// user is delivered once per day, at/after their chosen time in their timezone.
// Delivers by EMAIL (if they set one) and/or PUSH (if they enabled it on a
// device). Protect with a shared secret so only your scheduler can trigger it:
//   header  X-Tasks-Secret: <TASKS_SECRET>   (or ?secret=... query param)
app.post("/tasks/daily", async (req, res) => {
  const secret = process.env.TASKS_SECRET || "";
  const given = req.get("X-Tasks-Secret") || req.query.secret || "";
  if (!secret || given !== secret) return res.status(403).json({ error: "forbidden" });
  if (!emailConfigured() && !pushConfigured()) return res.json({ ok: false, note: "no-delivery-channel (set EMAIL_* and/or VAPID_*)" });

  const subs = await listDigestSubscribers();
  const results = [];
  for (const s of subs) {
    const now = localNow(s.tz);
    if (!isDue(s, now)) continue; // not yet their time today, or already sent
    try {
      const { subject, text, html, summary } = await buildDigest(s.apps);
      let delivered = false;
      const out = { userId: s.userId };
      if (s.email && emailConfigured()) {
        const r = await sendEmail({ to: s.email, subject, text, html });
        if (r.ok) { delivered = true; out.email = true; } else out.emailError = r.error;
      }
      if (pushConfigured()) {
        const n = await sendPushToUser(s.userId, { title: subject, body: summary, url: "/" });
        if (n > 0) { delivered = true; out.push = n; }
      }
      if (delivered) await markSent(s.userId, now.date);
      out.delivered = delivered;
      results.push(out);
    } catch (err) {
      results.push({ userId: s.userId, error: err.message });
    }
  }
  res.json({ ok: true, considered: subs.length, delivered: results.filter((r) => r.delivered).length, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tracy is listening on :${PORT}`));
