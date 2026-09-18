// Admin gating with the door UNLOCKED (no AUTH_SECRET) — the local-dev case.
// Without a door there is no verified identity to require, so the
// self-declared id still works and a laptop session isn't locked out.
delete process.env.AUTH_SECRET;
process.env.ADMIN_USER_IDS = "fabian-admin-id";
delete process.env.INTERVERSE_API_URL;

import { test } from "node:test";
import assert from "node:assert/strict";
// Dynamic: a static import is hoisted above the env setup above.
const { toolSets } = await import("../src/tools.js");

const status = toolSets.interverse_admin.handlers.get_ai_lane_status;

test("self-declared admin id works when auth is off", async () => {
  const dev = await status({}, { userId: "fabian-admin-id", authUser: null });
  assert.ok(!(dev.error && /admin-only/i.test(dev.error)), "dev should not be locked out");
});

test("a non-admin is refused even with auth off", async () => {
  const r = await status({}, { userId: "rando", authUser: null });
  assert.ok(r.error);
  assert.match(r.error, /admin-only/i);
});
