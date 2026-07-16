// Text embeddings via Gemini — the vector representation Tracy's knowledge base
// uses to find "what have I learned that's relevant to this?".
//
// Gated on GEMINI_API_KEY (reuses the same key as the Gemini tools). Lazily
// imports the SDK so a missing key/package can't crash startup.
//   GEMINI_EMBED_MODEL   default: text-embedding-004 (768-dim, free-tier friendly)

const KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_EMBED_MODEL || "text-embedding-004";

export function embeddingsConfigured() { return Boolean(KEY); }

let _clientPromise = null;
async function getClient() {
  if (!KEY) throw new Error("no-gemini-key");
  if (!_clientPromise) _clientPromise = import("@google/genai").then(({ GoogleGenAI }) => new GoogleGenAI({ apiKey: KEY }));
  return _clientPromise;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}

// Embed a string → number[] (or null on any failure — callers degrade gracefully).
export async function embed(text) {
  if (!KEY) return null;
  const input = String(text || "").trim().slice(0, 8000);
  if (!input) return null;
  try {
    const ai = await getClient();
    const resp = await withTimeout(ai.models.embedContent({ model: MODEL, contents: input }), 15000);
    // SDK shapes vary a little across versions — accept the common ones.
    const values =
      (resp && resp.embeddings && resp.embeddings[0] && resp.embeddings[0].values) ||
      (resp && resp.embedding && resp.embedding.values) ||
      (resp && resp.embeddings && resp.embeddings.values) ||
      null;
    return Array.isArray(values) ? values : null;
  } catch (err) {
    console.error("embed failed:", err.message);
    return null;
  }
}
