// A stand-in child for tests/isolate.test.js: like a decompression bomb, it
// keeps allocating (and touching) memory and never answers.
const kept = [];
process.once("message", () => {
  setInterval(() => kept.push(Buffer.alloc(16 * 1024 * 1024, 1)), 10);
});
