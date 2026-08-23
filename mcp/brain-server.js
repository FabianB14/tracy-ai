#!/usr/bin/env node
// Interverse Brain MCP server (tier 3 of "plugging the brain into Tracy").
//
// Exposes the brain to ANY MCP client — Claude Code on Fabian's machine, other
// agents, future surfaces — through one interface:
//   brain_search_entities  find entities by name or meaning
//   brain_get_entity       full entity content by id
//   brain_list_entities    everything the brain currently knows
//   brain_add_note         drop a thought into raw/ for the daily loop
//
// Run it next to the repo (stdio transport — it IS a local server):
//   node mcp/brain-server.js
// Registered for Claude Code via .mcp.json at the repo root, or manually:
//   claude mcp add interverse-brain -- node mcp/brain-server.js
//
// Env is optional: with DATABASE_URL it reads the same live table deployed
// Tracy uses (freshest view, plus semantic search when GEMINI_API_KEY is set);
// without it, it reads brain/entities/ off disk with keyword search.
//
// IMPORTANT: stdio servers must keep stdout protocol-clean — everything here
// logs to stderr only (src modules already use console.error).

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchBrain,
  listBrainEntities,
  getEntityById,
  writeRawNoteFile,
} from "../src/brain.js";

const server = new McpServer({ name: "interverse-brain", version: "1.0.0" });

server.registerTool(
  "brain_search_entities",
  {
    title: "Search brain entities",
    description:
      "Search Interverse's curated knowledge base (the brain) by name or meaning. " +
      "Returns entity summaries with ids — call brain_get_entity for full content. " +
      "Semantic (by-meaning) matching is active when the server has DATABASE_URL + GEMINI_API_KEY; " +
      "otherwise matching is by title/alias/tag keywords.",
    inputSchema: {
      query: z.string().min(2).describe("What to look for, e.g. 'how do we make money on the car app?'"),
      k: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, k }) => {
    const results = await searchBrain(query, { k: k || 5 });
    const text = results.length
      ? results.map((r) => `- ${r.id} — ${r.title} (${r.match}${r.score != null ? ` ${r.score}` : ""}, confidence ${r.confidence})\n  ${r.snippet.replace(/\n/g, " ").slice(0, 200)}…`).join("\n")
      : "No entities matched. Try brain_list_entities to see what the brain knows, or rephrase the query.";
    return { content: [{ type: "text", text }], structuredContent: { results } };
  },
);

server.registerTool(
  "brain_get_entity",
  {
    title: "Get a brain entity",
    description: "Fetch one entity's full content (summary, key facts, and 'the play') by its id, e.g. 'e-product-partout'.",
    inputSchema: {
      id: z.string().min(2).describe("Entity id from brain_search_entities or brain_list_entities"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const e = await getEntityById(id);
    if (!e) {
      return {
        content: [{ type: "text", text: `No entity with id '${id}'. Use brain_list_entities to see valid ids.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `# ${e.title} (${e.id}, confidence ${e.confidence})\n\n${e.body}` }],
      structuredContent: { entity: e },
    };
  },
);

server.registerTool(
  "brain_list_entities",
  {
    title: "List brain entities",
    description: "List every entity the brain currently serves (id, title, confidence). The brain's full pipeline lives in brain/README.md.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const entities = await listBrainEntities();
    const text = entities.length
      ? entities.map((e) => `- ${e.id} — ${e.title} (confidence ${e.confidence})`).join("\n")
      : "The brain has no eligible entities yet (tracy_ready + confidence >= threshold).";
    return { content: [{ type: "text", text }], structuredContent: { entities } };
  },
);

server.registerTool(
  "brain_add_note",
  {
    title: "Add a raw note to the brain",
    description:
      "Drop a thought, idea, or fact into the brain's inbox (brain/raw/). The daily loop will turn it " +
      "into a researched concept and, when it clears the confidence bar, a Tracy-ready entity. " +
      "Half-sentences are fine — the loop's job is to make sense of them. Writes a file next to this repo.",
    inputSchema: {
      text: z.string().min(3).max(20000).describe("The note. Plain text or markdown."),
      slug: z.string().max(60).optional().describe("Optional short kebab-case name for the file, e.g. 'partout-fleet-idea'"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text, slug }) => {
    const file = writeRawNoteFile(text, slug);
    return {
      content: [{ type: "text", text: `Saved to ${file}. The next daily loop run will ingest it.` }],
      structuredContent: { file },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("interverse-brain MCP server running (stdio)");
