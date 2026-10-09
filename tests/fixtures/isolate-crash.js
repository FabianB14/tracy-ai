// A stand-in child for tests/isolate.test.js: dies without answering.
process.once("message", () => process.exit(3));
