// Tests for the AI task lane (src/aitasks.js). Zero dependencies on purpose:
// node:test + node:assert only, no express, no Anthropic SDK, no src/server.js
// — so `npm test` runs green without node_modules installed.

import test from "node:test";
import assert from "node:assert/strict";
import { TASKS, taskModel, runTask, requireServiceSecret } from "../src/aitasks.js";

const GOOD_OUTPUT = {
  accepted: true,
  model_id: "plasma_rifle",
  name: "Plasma Rifle",
  properties: { damage: 120 },
  reasoning: "Closest energy weapon in the target catalog with comparable damage.",
};

const SAMPLE_INPUT = {
  source_game: { id: "spacewars", name: "Space Wars" },
  target_game: { id: "chesswars", name: "Chess Wars" },
  asset: { type: "weapon", name: "Laser Blaster", properties: { damage: 100, weight: 3 } },
  target_catalog: { items: [{ model_id: "plasma_rifle", name: "Plasma Rifle" }], stat_keys: ["damage"] },
};

// A fake Anthropic client that records the params it was called with and
// returns a canned response.
function fakeClient(response) {
  const calls = [];
  return {
    calls,
    messages: {
      create(params) {
        calls.push(params);
        return Promise.resolve(response);
      },
    },
  };
}

function toolUseResponse(input) {
  return {
    content: [{ type: "tool_use", name: "emit_conversion", input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// ---- runTask ----

test("runTask rejects an unknown task with status 400", async () => {
  await assert.rejects(
    runTask("frobnicate", {}, { client: fakeClient({}), model: "m" }),
    (err) => err.status === 400 && /unknown task/.test(err.message),
  );
});

test("runTask rejects non-object input with status 400", async () => {
  for (const bad of [undefined, null, "hi", 42, ["a"]]) {
    await assert.rejects(
      runTask("convert_asset", bad, { client: fakeClient({}), model: "m" }),
      (err) => err.status === 400,
    );
  }
});

test("runTask happy path: forced tool call, temperature 0, output/model/usage", async () => {
  const client = fakeClient(toolUseResponse(GOOD_OUTPUT));
  const result = await runTask("convert_asset", SAMPLE_INPUT, { client, model: "test-model" });

  assert.deepEqual(result.output, GOOD_OUTPUT);
  assert.equal(result.model, "test-model");
  assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 1 });

  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.model, "test-model");
  assert.equal(params.temperature, 0);
  assert.deepEqual(params.tool_choice, { type: "tool", name: "emit_conversion" });
  assert.equal(params.tools.length, 1);
  assert.equal(params.tools[0].name, "emit_conversion");
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, "user");
});

test("runTask throws 502 when the response has no tool_use block", async () => {
  const client = fakeClient({ content: [{ type: "text", text: "I refuse to use tools" }], usage: {} });
  await assert.rejects(
    runTask("convert_asset", SAMPLE_INPUT, { client, model: "m" }),
    (err) => err.status === 502 && /tool_use/.test(err.message),
  );
});

test("runTask throws 502 with validator errors when the output is bad", async () => {
  const client = fakeClient(toolUseResponse({ model_id: "x", properties: {}, reasoning: "r" })); // no name
  await assert.rejects(
    runTask("convert_asset", SAMPLE_INPUT, { client, model: "m" }),
    (err) => err.status === 502 && /name/.test(err.message),
  );
});

// ---- checkOutput ----

test("checkOutput accepts a valid output", () => {
  assert.deepEqual(TASKS.convert_asset.checkOutput(GOOD_OUTPUT), []);
  // string property values and tags are fine too
  assert.deepEqual(
    TASKS.convert_asset.checkOutput({ ...GOOD_OUTPUT, properties: { rarity: "epic", damage: 5 }, tags: ["weapon"] }),
    [],
  );
});

test("checkOutput flags missing fields", () => {
  const errors = TASKS.convert_asset.checkOutput({});
  assert.ok(errors.some((e) => e.includes("model_id")));
  assert.ok(errors.some((e) => e.includes("name")));
  assert.ok(errors.some((e) => e.includes("reasoning")));
  assert.ok(errors.some((e) => e.includes("properties")));
});

test("checkOutput flags non-finite numbers and bad property values", () => {
  for (const bad of [Infinity, -Infinity, NaN, null, [1], { nested: 1 }, true]) {
    const errors = TASKS.convert_asset.checkOutput({ ...GOOD_OUTPUT, properties: { damage: bad } });
    assert.ok(errors.some((e) => e.includes("properties.damage")), `expected error for ${String(bad)}`);
  }
});

test("checkOutput flags bad tags but allows their absence", () => {
  assert.ok(TASKS.convert_asset.checkOutput({ ...GOOD_OUTPUT, tags: "weapon" }).length > 0);
  assert.ok(TASKS.convert_asset.checkOutput({ ...GOOD_OUTPUT, tags: [1, 2] }).length > 0);
  assert.deepEqual(TASKS.convert_asset.checkOutput({ ...GOOD_OUTPUT }), []);
});

test("checkOutput rejects a non-object output outright", () => {
  assert.ok(TASKS.convert_asset.checkOutput(null).length > 0);
  assert.ok(TASKS.convert_asset.checkOutput("nope").length > 0);
});

// ---- prompts ----

test("buildUser carries the input only as JSON", () => {
  const user = TASKS.convert_asset.buildUser(SAMPLE_INPUT);
  assert.ok(user.includes(JSON.stringify(SAMPLE_INPUT)), "input JSON must appear verbatim");
  // The untrusted asset name must not leak into the framing text outside the
  // JSON block: strip the JSON and check what's left.
  const framing = user.replace(JSON.stringify(SAMPLE_INPUT), "");
  assert.ok(!framing.includes("Laser Blaster"));
});

test("buildSystem states the hard rules", () => {
  const sys = TASKS.convert_asset.buildSystem(SAMPLE_INPUT);
  assert.ok(sys.includes("emit_conversion"));
  assert.ok(/untrusted/i.test(sys));
  assert.ok(/previous_errors/.test(sys));
});

// ---- taskModel ----

test("taskModel defaults to claude-haiku-4-5 and honors TRACY_TASK_MODEL", () => {
  const saved = process.env.TRACY_TASK_MODEL;
  try {
    delete process.env.TRACY_TASK_MODEL;
    assert.equal(taskModel(), "claude-haiku-4-5");
    process.env.TRACY_TASK_MODEL = "claude-sonnet-4-6";
    assert.equal(taskModel(), "claude-sonnet-4-6");
  } finally {
    if (saved === undefined) delete process.env.TRACY_TASK_MODEL;
    else process.env.TRACY_TASK_MODEL = saved;
  }
});

// ---- requireServiceSecret ----

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

test("requireServiceSecret fails closed when SERVICE_SECRET is unset", () => {
  const saved = process.env.SERVICE_SECRET;
  try {
    delete process.env.SERVICE_SECRET;
    const res = fakeRes();
    let nextCalled = false;
    requireServiceSecret({ headers: { "x-service-secret": "anything" } }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "forbidden" });
    assert.equal(nextCalled, false);
  } finally {
    if (saved === undefined) delete process.env.SERVICE_SECRET;
    else process.env.SERVICE_SECRET = saved;
  }
});

test("requireServiceSecret rejects a wrong or missing header with 403", () => {
  const saved = process.env.SERVICE_SECRET;
  try {
    process.env.SERVICE_SECRET = "s3cret";
    for (const headers of [{ "x-service-secret": "wrong" }, {}]) {
      const res = fakeRes();
      let nextCalled = false;
      requireServiceSecret({ headers }, res, () => { nextCalled = true; });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, { error: "forbidden" });
      assert.equal(nextCalled, false);
    }
  } finally {
    if (saved === undefined) delete process.env.SERVICE_SECRET;
    else process.env.SERVICE_SECRET = saved;
  }
});

test("requireServiceSecret calls next() on a matching secret", () => {
  const saved = process.env.SERVICE_SECRET;
  try {
    process.env.SERVICE_SECRET = "s3cret";
    const res = fakeRes();
    let nextCalled = false;
    requireServiceSecret({ headers: { "x-service-secret": "s3cret" } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  } finally {
    if (saved === undefined) delete process.env.SERVICE_SECRET;
    else process.env.SERVICE_SECRET = saved;
  }
});

test("runTask maps upstream model-call failures to 502, never the upstream status", async () => {
  const upstream = new Error("rate limited");
  upstream.status = 429; // Anthropic SDK APIError shape (401/429/529/…)
  const client = { messages: { create: async () => { throw upstream; } } };
  await assert.rejects(
    () => runTask("convert_asset", { asset: {} }, { client, model: "test-model" }),
    (err) => err.status === 502 && /model call failed/.test(err.message),
  );
});

test("checkOutput requires accepted boolean and typed v2 fields", () => {
  const t = TASKS.convert_asset;
  const missingAccepted = { ...GOOD_OUTPUT };
  delete missingAccepted.accepted;
  assert.ok(t.checkOutput(missingAccepted).some((e) => /accepted/.test(e)));
  assert.ok(
    t.checkOutput({ ...GOOD_OUTPUT, anim_tags: "swing_2h" }).some((e) => /anim_tags/.test(e))
  );
  assert.ok(
    t.checkOutput({ ...GOOD_OUTPUT, restyled_name: 42 }).some((e) => /restyled_name/.test(e))
  );
  assert.deepEqual(
    t.checkOutput({ ...GOOD_OUTPUT, restyled_name: "Dragon Sword // Mk-Neon", style_notes: "neon edges", anim_tags: ["swing_2h"] }),
    []
  );
});

test("checkOutput allows a refusal-shaped output", () => {
  const refusal = { ...GOOD_OUTPUT, accepted: false, refusal_reason: "firearms banned in target world" };
  assert.deepEqual(TASKS.convert_asset.checkOutput(refusal), []);
});
