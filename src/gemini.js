// Gemini provider — the "other brain" for the tasks Gemini is better at.
//
// Tracy stays a Claude assistant (writing, code, calibrated reasoning). Gemini
// is exposed to her as TOOLS she can call when a task fits it best:
//   • web_research  — Google Search grounding for current events / live info
//   • analyze_media — watch a YouTube link (or audio/video URL) and report back
//
// Everything here is gated on GEMINI_API_KEY and lazily imported, so if the key
// is unset (or the @google/genai package isn't installed) Tracy runs exactly as
// before — no crash, the tools simply aren't offered.
//
// Config (env — never committed):
//   GEMINI_API_KEY   your Google AI Studio key (https://aistudio.google.com/apikey)
//   GEMINI_MODEL     model to use (default: gemini-2.5-flash — fast, free-tier friendly)

const KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function geminiConfigured() {
  return Boolean(KEY);
}

// Lazily construct clients the first time they're needed. Dynamic import means a
// missing package can't crash the server at startup — only a call would fail,
// and only when Gemini is actually configured and used.
//
// Clients are cached per API key: the server's own GEMINI_API_KEY, plus any
// bring-your-own keys callers pass in (e.g. a PartOut user's Gemini key, so the
// mechanic's generation bills THEIR account, not Tracy's).
let _genaiModule = null;
const _clients = new Map();
async function getClient(apiKey) {
  const key = (apiKey || KEY || "").trim();
  if (!key) throw new Error("gemini-not-configured");
  if (_clients.has(key)) return _clients.get(key);
  if (!_genaiModule) _genaiModule = import("@google/genai");
  const p = _genaiModule.then(({ GoogleGenAI }) => new GoogleGenAI({ apiKey: key }));
  _clients.set(key, p);
  return p;
}

// Map Tracy's message history ([{role, content}] where content is a string or
// an array of Anthropic content blocks) into Gemini `contents`, so a Gemini
// answer keeps the full conversation (and any attached photos), not just the
// last line.
function toGeminiContents(history) {
  const out = [];
  for (const m of history || []) {
    if (!m) continue;
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "text" && b.text) parts.push({ text: b.text });
        else if (b?.type === "image" && b.source?.data) {
          parts.push({ inlineData: { mimeType: b.source.media_type || "image/jpeg", data: b.source.data } });
        }
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

// Don't let a slow/hung Gemini call block Tracy's reply.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

// Pull the text out of a Gemini response (SDK exposes a .text getter; fall back
// to walking candidates if the shape differs across SDK versions).
function extractText(res) {
  if (res && typeof res.text === "string") return res.text;
  const parts = res?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p?.text).filter(Boolean).join("\n");
}

// Current-events / live web research via Gemini + Google Search grounding.
export async function webResearch(query) {
  try {
    const ai = await getClient();
    const res = await withTimeout(
      ai.models.generateContent({
        model: MODEL,
        contents: String(query || ""),
        config: { tools: [{ googleSearch: {} }] },
      }),
      25000,
    );
    const gm = res?.candidates?.[0]?.groundingMetadata;
    const sources = (gm?.groundingChunks || [])
      .map((c) => c.web && { title: c.web.title, uri: c.web.uri })
      .filter(Boolean)
      .slice(0, 8);
    return { source: "gemini_google_search", answer: extractText(res), sources };
  } catch (err) {
    return { error: `Web research (Gemini) failed: ${err.message}` };
  }
}

// Chat completion via Gemini — used by the knowledge confidence gate and the
// PartOut hybrid path to answer without calling Claude.
//   system  — the system prompt (surface identity + retrieved knowledge)
//   user    — the latest user text (used when no history is given)
//   opts    — { apiKey?, history? }
//     apiKey  : a caller's own Gemini key (bring-your-own); falls back to the
//               server key. This is what keeps the mechanic's cost on the user.
//     history : full [{role, content}] conversation, so Gemini answers with
//               context (and any attached photos), not just the last line.
export async function geminiChat(system, user, opts = {}) {
  const { apiKey, history } = opts;
  try {
    const ai = await getClient(apiKey);
    const contents = history && history.length
      ? toGeminiContents(history)
      : String(user || "");
    const res = await withTimeout(
      ai.models.generateContent({
        model: MODEL,
        contents,
        config: { systemInstruction: String(system || "") },
      }),
      20000,
    );
    return extractText(res) || null;
  } catch (err) {
    console.error("geminiChat failed:", err.message);
    return null;
  }
}

// Analyze a media URL with Gemini. Best with YouTube links (and other public
// video/audio URLs Gemini can fetch by URI). Returns a written analysis.
export async function analyzeMedia(url, question) {
  try {
    const ai = await getClient();
    const parts = [
      { fileData: { fileUri: String(url || "") } },
      { text: String(question || "Describe this and summarize the key points.") },
    ];
    const res = await withTimeout(
      ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }] }),
      60000,
    );
    return { source: "gemini", answer: extractText(res) };
  } catch (err) {
    return { error: `Media analysis (Gemini) failed: ${err.message}. Works best with a YouTube or public video/audio URL.` };
  }
}
