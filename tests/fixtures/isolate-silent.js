// A stand-in child for tests/isolate.test.js: never answers (a parse that hangs).
process.once("message", () => setInterval(() => {}, 1000));
