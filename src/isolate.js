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
// Node built-ins only, so the tests run without node_modules.

import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./isolate-child.js", import.meta.url));
const MB = 1024 * 1024;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// The child's resident memory in bytes, from /proc (Linux, which is what
// Render runs). null where /proc is missing (a Mac): then only the heap flag
// and the time limit apply.
export async function procRss(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

let busy = false;
export const isBusy = () => busy;

// Runs `op` (see isolate-child.js) on `buffer` in a child process.
//   maxMemoryMb  the child is killed past this resident size -> 413 too_large
//   timeoutMs    the child is killed after this long -> code "isolate_timeout"
//                (no status: each caller decides what a slow read means)
// The child's own errors come back with their name and code only (never a
// message that could quote the file); `password` errors keep a recognisable
// message so callers can answer pdf_encrypted.
export async function runIsolated(op, buffer, args = {}, { maxMemoryMb = 350, timeoutMs = 60_000, child = CHILD, forkImpl = fork, rssOf = procRss, pollMs = 50 } = {}) {
  if (busy) throw fail(503, "busy", "another document is being read; try again shortly");
  busy = true;
  try {
    return await new Promise((resolve, reject) => {
      let proc;
      try {
        proc = forkImpl(child, [], {
          serialization: "advanced", // Buffers cross as bytes, not JSON
          execArgv: [`--max-old-space-size=${maxMemoryMb}`],
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
        if (rss !== null && rss > maxMemoryMb * MB) settle(reject, fail(413, "too_large", "the file needs too much memory to read"));
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
