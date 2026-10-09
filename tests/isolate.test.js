// Tests for src/isolate.js: untrusted documents are read in a child process
// that is killed past its memory or time limit, one at a time. The children
// here are small stand-ins (tests/fixtures/isolate-*.js), so no node_modules.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolated, isBusy, procRss, instanceMemoryLimit, childHeadroomMb, cgroupLimitFiles } from "../src/isolate.js";

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

test("the limit is on the child's private memory, not the node binary and libraries it shares with Tracy", { skip: !hasProc && "no /proc on this host" }, async () => {
  const status = readFileSync("/proc/self/status", "utf8");
  const kb = (field) => Number((new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(status) || [0, 0])[1]) * 1024;
  if (!/^RssAnon:/m.test(status)) return; // a kernel without the split: VmRSS is all there is
  const rss = await procRss(process.pid);
  // RssAnon + RssShmem, about 70 MB less than VmRSS for a Node process (its file-backed pages).
  assert.ok(rss < kb("VmRSS"), "less than VmRSS");
  assert.ok(Math.abs(rss - (kb("RssAnon") + kb("RssShmem"))) < 16 * 1024 * 1024, "RssAnon + RssShmem");
});

test("a child never gets more memory than the instance has left", { skip: !hasProc && "no /proc on this host" }, async () => {
  let seen = 0;
  const rssOf = async (pid) => { const r = await procRss(pid); if (r) seen = Math.max(seen, r); return r; };
  await assert.rejects(
    runIsolated("docxHtml", Buffer.from("PK"), {}, { child: child("hog"), maxMemoryMb: 600, headroomOf: async () => 120, rssOf, timeoutMs: 20_000, pollMs: 20 }),
    (e) => e.status === 413 && e.code === "too_large",
  );
  assert.ok(seen < 300 * 1024 * 1024, `killed near the 120 MB headroom, not at 600 MB (saw ${Math.round(seen / 1048576)} MB)`);
  assert.equal(isBusy(), false);
});

test("the headroom is the instance's memory limit less Tracy's own memory and a margin", async () => {
  const MB = 1024 * 1024;
  assert.equal(await childHeadroomMb({ limitOf: async () => 512 * MB, rssOf: () => 130 * MB }), 350);
  assert.equal(await childHeadroomMb({ limitOf: async () => null, rssOf: () => 130 * MB }), null, "no limit to read: the configured one applies");
  assert.ok(Number.isInteger(await childHeadroomMb({ limitOf: async () => 4096 * MB })), "Tracy's own memory, measured after a collection");
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  assert.equal(await instanceMemoryLimit([file("v2", "536870912\n")]), 512 * MB, "cgroup v2 memory.max");
  assert.equal(await instanceMemoryLimit([file("v2max", "max\n"), file("v1", "9223372036854771712\n")]), null, "no limit (v2 'max', v1's huge number)");
  assert.equal(await instanceMemoryLimit([join(dir, "missing"), file("v1b", "1073741824")]), 1024 * MB, "cgroup v1 when there is no v2 file");
  // The process's own cgroup first, then the root a container with its own cgroup namespace sees.
  assert.deepEqual(cgroupLimitFiles("0::/\n"), ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  assert.deepEqual(cgroupLimitFiles("0::/kubepods/pod1/c1\n").slice(0, 1), ["/sys/fs/cgroup/kubepods/pod1/c1/memory.max"]);
  assert.deepEqual(cgroupLimitFiles("5:cpu:/x\n4:memory:/docker/abc\n").slice(0, 1), ["/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes"]);
});

test("the child can collect garbage and hands freed memory back (the page renderer depends on it)", async () => {
  assert.deepEqual(
    await runIsolated("pdfRender", Buffer.from("%PDF"), {}, { child: child("env"), timeoutMs: 10_000 }),
    { gc: "function", arenas: "2", mmapThreshold: "131072" },
  );
});
