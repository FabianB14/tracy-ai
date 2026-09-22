// Optional free-plan fallback. No SDK dependency; credentials stay server-side.
import { classifyModelError, worthFallingBack } from "./apierrors.js";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const URL = "https://api.groq.com/openai/v1/chat/completions";

export function groqDiag(env = process.env) {
  return {
    configured: Boolean(env.GROQ_API_KEY?.trim()),
    model: env.GROQ_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: 20000,
  };
}

// Refuse unsupported blocks instead of silently losing photos, documents, or
// Anthropic server-tool results. Those turns can still use the Gemini backup.
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some(b => b.type !== "text")) {
    throw new Error("Groq fallback requires text content");
  }
  return content.map(b => b.text).join("\n");
}

export function toGroqRequest(params, model = DEFAULT_MODEL) {
  const tools = (params.tools || []).filter(t => t.input_schema).map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages = [{ role: "system", content: textContent(params.system || "") +
    "\nOnly the provided tools are available. Never claim to use an unavailable tool. " +
    "Prior tool results record actions already performed; do not repeat those actions." }];
  for (const message of params.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content;
    if (!Array.isArray(blocks) || blocks.some(b => !["text", "tool_use", "tool_result"].includes(b.type))) {
      throw new Error("Groq fallback cannot represent this conversation");
    }
    const calls = blocks.filter(b => b.type === "tool_use");
    const results = blocks.filter(b => b.type === "tool_result");
    const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
    if ((calls.length && message.role !== "assistant") || (results.length && message.role !== "user")) {
      throw new Error("Invalid tool history");
    }
    for (const result of results) {
      messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: textContent(result.content) });
    }
    if (calls.length || text) {
      const out = { role: message.role, content: text || null };
      if (calls.length) out.tool_calls = calls.map(b => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
      messages.push(out);
    }
  }
  const body = { model, messages, max_completion_tokens: params.max_tokens };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (tools.length) body.tools = tools;
  if (params.tool_choice?.type === "tool") {
    if (!tools.some(t => t.function.name === params.tool_choice.name)) throw new Error("Unavailable forced tool");
    body.tool_choice = { type: "function", function: { name: params.tool_choice.name } };
  } else if (params.tool_choice) {
    body.tool_choice = params.tool_choice.type === "any" ? "required" : params.tool_choice.type;
  }
  return body;
}

export async function groqCreate(params, { env = process.env, fetchImpl = fetch } = {}) {
  const config = groqDiag(env);
  if (!config.configured) throw new Error("Groq is not configured");
  const body = toGroqRequest(params, config.model);
  const response = await fetchImpl(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
  });
  // Do not echo upstream bodies (they may contain prompts, tool data or keys).
  if (!response.ok) throw new Error(`Groq request failed (HTTP ${response.status})`);
  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) throw new Error("Incomplete Groq response");
  const content = [];
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  const ids = new Set();
  for (const call of choice.message?.tool_calls || []) {
    if (!call.id || ids.has(call.id) || call.type !== "function" ||
        !body.tools?.some(t => t.function.name === call.function?.name)) throw new Error("Invalid Groq tool call");
    ids.add(call.id);
    const input = JSON.parse(call.function.arguments);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Groq tool input");
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const calls = content.filter(b => b.type === "tool_use");
  if (!content.length || (choice.finish_reason === "tool_calls" && !calls.length)) throw new Error("Empty Groq response");
  if (params.tool_choice?.type === "tool" &&
      (calls.length !== 1 || calls[0].name !== params.tool_choice.name)) throw new Error("Groq did not return the required tool");
  return {
    model: data.model || config.model, content,
    stop_reason: calls.length ? "tool_use" : "end_turn",
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

// One wrapper per request, shared across that request's tool rounds. Switching
// providers retries only inference with existing results, never the tool loop.
export function withGroqFallback(primary, { byok = false, env = process.env, create = groqCreate } = {}) {
  let provider = "anthropic";
  let primaryError;
  return {
    get provider() { return provider; },
    messages: { async create(params) {
      if (provider === "anthropic") {
        try { return await primary.messages.create(params); }
        catch (err) {
          const failure = classifyModelError(err);
          if (!groqDiag(env).configured || !worthFallingBack(failure.kind) || (byok && failure.kind === "auth")) throw err;
          primaryError = err;
        }
      }
      try {
        const result = await create(params, { env });
        provider = "groq";
        return result;
      } catch {
        // Preserve the primary classification for the existing Gemini/error path.
        throw primaryError;
      }
    } },
  };
}
