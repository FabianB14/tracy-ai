// Tests for src/isolate.js: untrusted documents are read in a child process
// that is killed past its memory or time limit, one at a time. The children
// here are small stand-ins (tests/fixtures/isolate-*.js), so no node_modules.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runIsolated, isBusy } from "../src/isolate.js";

const child = (name) => fileURLToPath(new URL(`./fixtures/isolate-${name}.js`, import.meta.url));
const hasProc = existsSync("/proc/self/status"); // Linux, like Render

test("the child gets the bytes and the arguments, and its answer comes back", async () => {
  const out = await runIsolated("pdfText", Buffer.from("%PDF-1.7 hello"), { first: 3 }, { child: child("echo"), timeoutMs: 10_000 });
  assert.deepEqual(out, { op: "pdfText", bytes: 14, args: { first: 3 } });
  assert.equal(isBusy(), false);
});

test("a child that keeps allocating (a decompression bomb) is killed at the memory limit: 413 too_large", { skip: !hasProc && "no /proc on this host" }, async () => {
  const t0 = Date.now();
  await assert.rejects(
    runIsolated("docxHtml", Buffer.from("PK"), {}, { child: child("hog"), maxMemoryMb: 120, timeoutMs: 20_000, pollMs: 20 }),
    (e) => e.status === 413 && e.code === "too_large",
  );
  assert.ok(Date.now() - t0 < 15_000, "killed long before the time limit");
  assert.equal(isBusy(), false);
});

test("a child that never answers is killed at the time limit", async () => {
  await assert.rejects(
    runIsolated("pdfRender", Buffer.from("%PDF"), {}, { child: child("silent"), timeoutMs: 300 }),
    (e) => e.code === "isolate_timeout" && e.status === undefined,
  );
});

test("a child that dies, or reports an error, is an error without the file's words", async () => {
  await assert.rejects(runIsolated("pdfText", Buffer.from("%PDF"), {}, { child: child("crash"), timeoutMs: 10_000 }), (e) => e.code === "isolate_exit");
  await assert.rejects(
    runIsolated("pdfText", Buffer.from("%PDF"), {}, { child: child("fail"), timeoutMs: 10_000 }),
    (e) => e.name === "PasswordException" && /password/.test(e.message),
  );
});

test("one document at a time: a second read while one runs is 503 busy at once", async () => {
  const first = runIsolated("pdfRender", Buffer.from("%PDF"), {}, { child: child("silent"), timeoutMs: 500 });
  assert.equal(isBusy(), true);
  await assert.rejects(runIsolated("pdfText", Buffer.from("%PDF"), {}, { child: child("echo") }), (e) => e.status === 503 && e.code === "busy");
  await assert.rejects(first, (e) => e.code === "isolate_timeout");
  // Free again afterwards.
  assert.deepEqual((await runIsolated("pdfText", Buffer.from("x"), {}, { child: child("echo"), timeoutMs: 10_000 })).bytes, 1);
});
