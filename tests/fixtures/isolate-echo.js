// A stand-in child for tests/isolate.test.js: answers with what it was sent.
process.once("message", (msg) => {
  process.send({ ok: true, result: { op: msg.op, bytes: msg.buffer.byteLength, args: msg.args } }, () => process.exit(0));
});
