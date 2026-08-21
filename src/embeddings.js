// Text embeddings via Gemini — the vector representation Tracy's knowledge base
// uses to find "what have I learned that's relevant to this?".
//
// Gated on GEMINI_API_KEY (reuses the same key as the Gemini tools). Lazily
// imports the SDK so a missing key/package can't crash startup.
//
//   GEMINI_EMBED_MODEL   default: gemini-embedding-2
//     Google retires embedding models on a schedule (text-embedding-004 died
//     2026-01-14, gemini-embedding-001 died 2026-07-14), so when embeds start
//     404ing, bump this. Vectors from different models are NOT comparable —
//     the server detects a model change at boot and re-embeds every stored
//     vector automatically (see kbReembedIfModelChanged in knowledge.js).
//   GEMINI_EMBED_DIM     optional outputDimensionality (e.g. 768) to shrink
//     stored vectors; unset = the model's default size. Cosine similarity is
//     scale-invariant, so no renormalization is needed either way.

const KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";
const DIM = Number(process.env.GEMINI_EMBED_DIM || 0) || null;

export function embeddingsConfigured() { return Boolean(KEY); }

// The model id in use — stored as a marker next to the vectors so a model
// change is detectable (mixed-model cosine scores are meaningless).
export function embedModelId() { return DIM ? `${MODEL}@${DIM}` : MODEL; }

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
    const req = { model: MODEL, contents: input };
    if (DIM) req.config = { outputDimensionality: DIM };
    const resp = await withTimeout(ai.models.embedContent(req), 15000);
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
