// The MCP server is what a desktop agent (OpenClaw, Claude Code) talks to,
// so the contract worth testing is the protocol one: does it hand over
// Tracy's real tools, and does a call reach the real handler?
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "mcp", "server.js");

/** Start the server, run one exchange, return the parsed responses. */
function talk(requests, { env = {}, waitMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [SERVER], {
      env: { ...process.env, ADMIN_USER_IDS: "fabian-admin",
             INTERVERSE_API_URL: "", INTERVERSE_ADMIN_KEY: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", () => {}); // startup notes; stdout is the protocol

    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1" } } });
    requests.forEach((r, i) => setTimeout(() => send(r), 250 + i * 250));

    setTimeout(() => {
      child.kill();
      resolve(out.trim().split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean));
    }, waitMs);
  });
}

test("it speaks MCP and identifies itself", async () => {
  const msgs = await talk([], { waitMs: 700 });
  const init = msgs.find((m) => m.id === 1);
  assert.ok(init, "no initialize response");
  assert.equal(init.result.serverInfo.name, "tracy-tools");
});

test("it exposes Tracy's operator tools with their real schemas", async () => {
  const msgs = await talk([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const tools = msgs.find((m) => m.id === 2)?.result?.tools || [];
  const names = tools.map((t) => t.name);

  for (const expected of ["create_test_kit", "cleanup_test_kit", "set_test_kits",
                          "set_ai_conversion", "set_metadata_quality",
                          "get_ai_lane_status", "get_babyresell_stats"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  // Schemas come from src/tools.js, so they carry the real parameters —
  // this one proves the reuse rather than a hand-copied duplicate.
  const kit = tools.find((t) => t.name === "create_test_kit");
  assert.ok(kit.inputSchema?.properties?.game_ids, "create_test_kit lost game_ids");
  assert.ok(kit.description.length > 50, "descriptions should come through");
  // Tracy's private brain tools are NOT operator tools.
  for (const notHere of ["remember", "vault_get", "vault_store", "brain_note"]) {
    assert.ok(!names.includes(notHere), `${notHere} should not be exposed`);
  }
});

test("a call reaches the real handler and past the admin gate", async () => {
  const msgs = await talk([{ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "get_ai_lane_status", arguments: {} } }]);
  const text = msgs.find((m) => m.id === 3)?.result?.content?.[0]?.text || "";
  // With no backend configured the handler's own note is the right answer —
  // reaching it proves the gate passed and the handler ran.
  assert.match(text, /isn't connected yet/i);
  assert.doesNotMatch(text, /admin-only/i, "the configured admin id should pass the gate");
});

test("without an admin id, admin tools refuse", async () => {
  const msgs = await talk(
    [{ jsonrpc: "2.0", id: 4, method: "tools/call",
       params: { name: "set_test_kits", arguments: { enabled: true } } }],
    { env: { ADMIN_USER_IDS: "", MCP_ADMIN_USER_ID: "" } }
  );
  const text = msgs.find((m) => m.id === 4)?.result?.content?.[0]?.text || "";
  assert.match(text, /admin-only/i);
});

test("an unknown tool is an error, not a crash", async () => {
  const msgs = await talk([{ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "no_such_tool", arguments: {} } }]);
  const r = msgs.find((m) => m.id === 5)?.result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown tool/i);
});
