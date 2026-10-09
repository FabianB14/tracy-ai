// A stand-in child for tests/isolate.test.js: reports a password error the way isolate-child.js does.
process.once("message", () => {
  process.send({ ok: false, error: { name: "PasswordException", code: null, password: true } }, () => process.exit(0));
});
