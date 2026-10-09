// A stand-in child for tests/isolate.test.js: reports how it was started
// (the page renderer relies on --expose-gc and glibc's malloc settings).
process.once("message", () => {
  process.send({
    ok: true,
    result: {
      gc: typeof globalThis.gc,
      arenas: process.env.MALLOC_ARENA_MAX ?? null,
      mmapThreshold: process.env.MALLOC_MMAP_THRESHOLD_ ?? null,
    },
  }, () => process.exit(0));
});
