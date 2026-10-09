// Untrusted documents are read in a child process (DualRep's POST /ai/extract
// and the scanned-page renderer).
//
// Why: the byte limits cap the download, not what it unpacks to. A 100 KB
// .docx can inflate to 100 MB of XML and a 300 KB PDF to a 300 MB page
// stream; read inside Tracy's own process (512 MB on Render's free plan,
// shared with Interverse and /chat) that takes the whole service down, and
// DualRep's worker would send the same file again. Here the reading runs in a
// forked Node process that this one watches: past its memory limit or its
// time limit it is killed, and the caller gets a fixed error. Reading in the
// child also keeps Tracy's event loop free while a long parse or a page
// render runs (so /health and the other callers still answer).
//
// One document at a time: a second request while one is being read gets
// 503 "busy" at once (DualRep's worker puts the job back and tries again a
// minute later), so two big reads never add up past the memory either.
//
// The memory limit is on the child's private memory, and never more than
// the instance has left (see childHeadroomMb): Render's free instance has
// 512 MB for Tracy and its child together.
//
// Node built-ins only, so the tests run without node_modules.

import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

const CHILD = fileURLToPath(new URL("./isolate-child.js", import.meta.url));
const MB = 1024 * 1024;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// The child's private resident memory in bytes (RssAnon + RssShmem from
// /proc: Linux, which is what Render runs). That is what the child itself
// takes from the instance. VmRSS also counts about 70 MB of the node binary
// and libraries mapped from disk, which Tracy maps too (one copy in memory),
// so it made an ordinary scanned page look like it needed 410 MB when it
// took 340. Falls back to VmRSS on a kernel without those fields; null where
// /proc is missing (a Mac): then only the heap flag and the time limit apply.
export async function procRss(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kb = (field) => {
      const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(status);
      return m ? Number(m[1]) * 1024 : null;
    };
    const anon = kb("RssAnon");
    return anon !== null ? anon + (kb("RssShmem") ?? 0) : kb("VmRSS");
  } catch {
    return null;
  }
}

// Where this process's memory limit can be read, from /proc/self/cgroup:
// its own cgroup's file first (v2 "0::/path", v1 "N:memory:/path"), then the
// mount's root (a container with its own cgroup namespace sees "/").
export function cgroupLimitFiles(procCgroup) {
  const files = [];
  for (const line of String(procCgroup || "").split("\n")) {
    const [, controllers, path] = /^\d+:([^:]*):(\/.*)$/.exec(line.trim()) || [];
    if (path === undefined) continue;
    if (controllers === "") files.push(`/sys/fs/cgroup${path === "/" ? "" : path}/memory.max`);
    else if (controllers.split(",").includes("memory")) files.push(`/sys/fs/cgroup/memory${path === "/" ? "" : path}/memory.limit_in_bytes`);
  }
  return [...new Set([...files, "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"])];
}

// The instance's memory limit in bytes (its cgroup), or null when there is
// none to read (a laptop, or "no limit"). Read once.
let instanceLimit;
export async function instanceMemoryLimit(files = null) {
  if (files === null && instanceLimit !== undefined) return instanceLimit;
  let list = files;
  if (list === null) {
    try { list = cgroupLimitFiles(await readFile("/proc/self/cgroup", "utf8")); } catch { list = cgroupLimitFiles(""); }
  }
  let limit = null;
  for (const file of list) {
    try {
      const n = Number((await readFile(file, "utf8")).trim()); // "max" -> NaN
      // cgroup v1 writes a number near 2^63 for "no limit".
      if (Number.isFinite(n) && n > 0 && n < 2 ** 40) { limit = n; break; }
    } catch { /* not this cgroup version */ }
  }
  if (files === null) instanceLimit = limit;
  return limit;
}

// How much private memory a child may take now: the instance's limit, less
// Tracy's own resident memory (which includes the node binary and libraries
// the child shares with it) and a 32 MB margin (the child also maps about
// 20 MB of libraries Tracy does not, such as the canvas). null when the
// instance has no limit to read. Without this, a child at its fixed limit
// next to a busy Tracy could go past 512 MB, and Render restarts the service.
export async function childHeadroomMb({ limitOf = instanceMemoryLimit, rssOf = settledRss } = {}) {
  const limit = await limitOf();
  return limit === null ? null : Math.floor((limit - rssOf()) / MB) - 32;
}

// Tracy's resident memory after a full garbage collection. The downloads of
// earlier requests (25 MB each) stay allocated until V8 collects them, and an
// idle Tracy may not do that for a long time: measured as they were, they
// cost a 600 dpi page its room, and the retry a minute later found the same.
// gc is reached through a fresh context (Tracy itself is not started with
// --expose-gc); without it the measurement is taken as it is.
const collectGarbage = (() => {
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    return typeof gc === "function" ? gc : null;
  } catch {
    return null;
  }
})();
function settledRss() {
  if (collectGarbage) collectGarbage();
  return process.memoryUsage.rss();
}

let busy = false;
export const isBusy = () => busy;

// Runs `op` (see isolate-child.js) on `buffer` in a child process.
//   maxMemoryMb  the child is killed past this much private memory, or past
//                what the instance has left if that is less (headroomOf)
//                -> 413 too_large
//   timeoutMs    the child is killed after this long -> code "isolate_timeout"
//                (no status: each caller decides what a slow read means)
// The child's own errors come back with their name and code only (never a
// message that could quote the file); `password` errors keep a recognisable
// message so callers can answer pdf_encrypted.
export async function runIsolated(op, buffer, args = {}, { maxMemoryMb = 350, timeoutMs = 60_000, child = CHILD, forkImpl = fork, rssOf = procRss, headroomOf = childHeadroomMb, pollMs = 50 } = {}) {
  if (busy) throw fail(503, "busy", "another document is being read; try again shortly");
  busy = true;
  try {
    const room = await headroomOf();
    const limitMb = room === null ? maxMemoryMb : Math.max(Math.min(maxMemoryMb, room), 64);
    return await new Promise((resolve, reject) => {
      let proc;
      try {
        proc = forkImpl(child, [], {
          serialization: "advanced", // Buffers cross as bytes, not JSON
          // --expose-gc: the page renderer collects garbage before each big
          // canvas (see renderPdfPagesJpeg). The malloc settings make glibc
          // hand large freed blocks back at once instead of keeping them for
          // reuse: without them a 4-page batch of 600 dpi scans grew from
          // 340 MB (one page) to 395 MB (no effect where the C library isn't
          // glibc).
          execArgv: [`--max-old-space-size=${limitMb}`, "--expose-gc"],
          env: { ...process.env, MALLOC_ARENA_MAX: "2", MALLOC_MMAP_THRESHOLD_: "131072" },
          stdio: ["ignore", "ignore", "ignore", "ipc"], // nothing from the file reaches the logs
        });
      } catch {
        reject(fail(503, "isolate_unavailable", "the document reader could not start"));
        return;
      }
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        fn(value);
      };
      const timer = setTimeout(() => settle(reject, Object.assign(new Error("the document took too long to read"), { code: "isolate_timeout" })), timeoutMs);
      let polling = false;
      const watch = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        const rss = await rssOf(proc.pid);
        polling = false;
        if (rss !== null && rss > limitMb * MB) settle(reject, fail(413, "too_large", "the file needs too much memory to read"));
      }, pollMs);
      proc.on("message", (m) => {
        if (m && m.ok) return settle(resolve, m.result);
        const e = m && m.error ? m.error : {};
        settle(reject, Object.assign(new Error(e.password ? "password required" : "the document could not be read"), {
          name: typeof e.name === "string" ? e.name : "Error",
          code: typeof e.code === "string" ? e.code : undefined,
        }));
      });
      // Killed by the kernel or crashed (V8 out of heap): treated as unreadable.
      // A tick later, so a result sent just before a normal exit wins.
      proc.on("exit", () => setImmediate(() => settle(reject, Object.assign(new Error("the document reader stopped"), { code: "isolate_exit" }))));
      proc.on("error", () => settle(reject, fail(503, "isolate_unavailable", "the document reader could not start")));
      proc.send({ op, buffer, args });
    });
  } finally {
    busy = false;
  }
}
