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

// Lazily construct the client the first time it's needed. Dynamic import means a
// missing package can't crash the server at startup — only a call would fail,
// and only when Gemini is actually configured and used.
let _clientPromise = null;
async function getClient() {
  if (!KEY) throw new Error("gemini-not-configured");
  if (!_clientPromise) {
    _clientPromise = import("@google/genai").then(({ GoogleGenAI }) => new GoogleGenAI({ apiKey: KEY }));
  }
  return _clientPromise;
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
