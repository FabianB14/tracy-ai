import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isNewer, inPlaceUpdates, describeCheck, RELEASES_URL } from "../lib/updates.js";

test("versions compare numerically, not as strings", () => {
  assert.ok(isNewer("0.1.10", "0.1.9"));
  assert.ok(isNewer("0.2.0", "0.1.99"));
  assert.ok(!isNewer("0.1.2", "0.1.2"));
  assert.ok(!isNewer("0.1.1", "0.1.2"));
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
});

test("only Windows updates in place (unsigned mac cannot)", () => {
  assert.equal(inPlaceUpdates("win32"), true);
  assert.equal(inPlaceUpdates("darwin"), false);
  assert.equal(inPlaceUpdates("linux"), false);
});

test("check results say what to do next, in words", () => {
  assert.equal(describeCheck({ current: "0.1.2", latest: "0.1.2", platform: "win32" }).state, "current");
  assert.equal(describeCheck({ current: "0.1.2", latest: null, platform: "win32" }).state, "current");
  const w = describeCheck({ current: "0.1.2", latest: "0.1.3", platform: "win32" });
  assert.equal(w.state, "available"); assert.equal(w.latest, "0.1.3");
  const m = describeCheck({ current: "0.1.2", latest: "0.1.3", platform: "darwin" });
  assert.equal(m.state, "available-manual"); assert.equal(m.url, RELEASES_URL); assert.match(m.message, /download/i);
  const e = describeCheck({ current: "0.1.2", error: "ENOTFOUND" });
  assert.equal(e.state, "error"); assert.match(e.message, /ENOTFOUND/);
});
