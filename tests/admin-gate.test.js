// Admin gating with the door LOCKED (AUTH_SECRET set).
// auth.js reads AUTH_SECRET once at import, so this scenario owns its own
// file — node --test gives each file a fresh process. The unlocked-door
// (local dev) case lives in admin-gate-dev.test.js for the same reason.
process.env.AUTH_SECRET = "a-long-random-signing-secret";
process.env.ADMIN_USER_IDS = "fabian-admin-id";
delete process.env.INTERVERSE_API_URL; // stop before any network call

import { test } from "node:test";
import assert from "node:assert/strict";
// Dynamic: a static import is hoisted above the env setup above.
const { toolSets } = await import("../src/tools.js");

const ADMIN = "fabian-admin-id";
const status = toolSets.interverse_admin.handlers.get_ai_lane_status;
const setKits = toolSets.interverse_admin.handlers.set_test_kits;

test("a self-declared admin id is not enough", async () => {
  const spoofed = await status({}, { userId: ADMIN, authUser: null });
  assert.ok(spoofed.error, "expected refusal for an unverified caller");
  assert.match(spoofed.error, /admin-only/i);
});

test("the key-verified identity passes the gate", async () => {
  const real = await status({}, { userId: "someone-else", authUser: { userId: ADMIN } });
  assert.ok(!(real.error && /admin-only/i.test(real.error)), "should clear the admin gate");
  assert.ok(real.note || real.error, "expected the not-configured note past the gate");
});

test("a verified non-admin is still refused", async () => {
  const r = await setKits({ enabled: true }, { userId: "rando", authUser: { userId: "rando" } });
  assert.ok(r.error);
  assert.match(r.error, /admin-only/i);
});

test("a write tool refuses a spoofed id too", async () => {
  const r = await setKits({ enabled: true }, { userId: ADMIN, authUser: null });
  assert.ok(r.error);
  assert.match(r.error, /admin-only/i);
});
