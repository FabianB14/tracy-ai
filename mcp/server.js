#!/usr/bin/env node
// Tracy's tools as an MCP server — for an agent running on YOUR machine.
//
// Why this exists: talking to hosted Tracy spends Anthropic API credit,
// because her brain is an API call. An agent on your desktop (OpenClaw,
// Claude Code) already has a brain you pay for another way — a Claude
// subscription. This server hands that agent Tracy's TOOLS without her
// brain, so operator work (test kits, platform switches, BabyResell
// numbers) costs no API credit at all.
//
// It reuses the exact schemas and handlers from src/tools.js, so the tools
// here can never drift from the ones Tracy uses in chat. Nothing here calls
// a model: every handler is a direct HTTP call to the INTERVERSE admin API
// or the BabyResell API, authenticated by the keys in this process's env.
//
// Setup and config: see mcp/README.md.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { toolSets, getAdminIds } from "../src/tools.js";

// Which of Tracy's tool sets this server exposes. Operator surface only:
// platform switches, test kits, BabyResell reads. Deliberately NOT the
// memory/vault/knowledge tools — those belong to Tracy's own brain and a
// desktop agent has its own.
const EXPOSED = ["interverse_admin", "babyresell", "babyresell_admin"];

// The admin gate in src/tools.js checks an id against ADMIN_USER_IDS. This
// process runs on the operator's own machine and holds the admin key in its
// own env, so the identity is configuration, not a claim over the network:
// use the first configured admin id (or MCP_ADMIN_USER_ID to pick one).
const ADMIN_ID = process.env.MCP_ADMIN_USER_ID || getAdminIds()[0] || "";

function buildRegistry() {
  const tools = [];
  const handlers = {};
  for (const name of EXPOSED) {
    const set = toolSets[name];
    if (!set) continue;
    for (const schema of set.schemas) {
      if (!set.handlers[schema.name]) continue; // schema with no handler: skip
      tools.push({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.input_schema,
      });
      handlers[schema.name] = set.handlers[schema.name];
    }
  }
  return { tools, handlers };
}

const { tools, handlers } = buildRegistry();

const server = new Server(
  { name: "tracy-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }

  // Same context shape Tracy's chat path passes. authUser is set because the
  // caller is whoever runs this process locally — the admin key in this env
  // is the real credential.
  const context = {
    userId: ADMIN_ID,
    authUser: ADMIN_ID ? { userId: ADMIN_ID, role: "admin" } : null,
    surface: "mcp",
  };

  try {
    const result = await handler(args || {}, context);
    // Handlers return plain objects, including {error} / {note} for failures
    // they handled themselves — pass those through as text so the agent can
    // explain them rather than crashing.
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: Boolean(result && result.error),
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} failed: ${err?.message || err}` }],
    };
  }
});

// Startup complaints go to stderr: stdout is the MCP protocol channel, and
// anything written there corrupts the stream.
if (!ADMIN_ID) {
  console.error(
    "[tracy-tools] No admin id: set ADMIN_USER_IDS (or MCP_ADMIN_USER_ID). " +
    "Admin tools will refuse until one is set."
  );
}
if (!process.env.INTERVERSE_API_URL || !process.env.INTERVERSE_ADMIN_KEY) {
  console.error(
    "[tracy-tools] INTERVERSE_API_URL / INTERVERSE_ADMIN_KEY not set — " +
    "platform and test-kit tools will report 'not connected'."
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[tracy-tools] ready — ${tools.length} tools exposed`);
