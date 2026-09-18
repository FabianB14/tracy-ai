import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModelError, worthFallingBack } from "../src/apierrors.js";

// Shape of an Anthropic SDK error: HTTP status plus a typed body.
const apiErr = (status, message, type = "invalid_request_error") =>
  Object.assign(new Error(message), { status, error: { type: "error", error: { type, message } } });

test("out of credit is named, not guessed at", () => {
  const c = classifyModelError(apiErr(400, "Your credit balance is too low to access the Anthropic API"));
  assert.equal(c.kind, "out_of_credit");
  assert.equal(c.retryable, false);
  assert.match(c.message, /out of credit/i);
  assert.match(c.message, /Console/i, "should say where to fix it");
});

test("a spend cap reads as a cap, not as empty credit", () => {
  const c = classifyModelError(apiErr(400, "You have exceeded your monthly spend limit"));
  assert.equal(c.kind, "spend_cap");
  assert.match(c.message, /spend limit/i);
});

test("billing 400s are not mistaken for a bad request", () => {
  // Both arrive as HTTP 400 — the message is what separates them.
  assert.equal(classifyModelError(apiErr(400, "credit balance is too low")).kind, "out_of_credit");
  assert.equal(classifyModelError(apiErr(400, "messages: at least one message is required")).kind, "unknown");
});

test("auth, model and rate-limit failures each say what to check", () => {
  assert.equal(classifyModelError(apiErr(401, "invalid x-api-key", "authentication_error")).kind, "auth");
  assert.match(classifyModelError(apiErr(404, "model: nope", "not_found_error")).message, /TRACY_MODEL/);
  const rl = classifyModelError(apiErr(429, "rate limited", "rate_limit_error"));
  assert.equal(rl.kind, "rate_limit");
  assert.equal(rl.retryable, true);
});

test("overload and network failures are retryable", () => {
  assert.equal(classifyModelError(apiErr(529, "overloaded", "overloaded_error")).retryable, true);
  assert.equal(classifyModelError(apiErr(503, "service unavailable")).kind, "overloaded");
  const net = classifyModelError(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }));
  assert.equal(net.kind, "network");
  assert.equal(net.retryable, true);
});

test("Tracy's own database failure is not blamed on the model", () => {
  const c = classifyModelError(new Error('relation "memories" does not exist'));
  assert.equal(c.kind, "database");
  assert.match(c.message, /database/i);
});

test("an unknown failure still points at the logs, and never says 'snag'", () => {
  const c = classifyModelError(new Error("something weird"));
  assert.equal(c.kind, "unknown");
  assert.match(c.message, /logs/i);
  assert.doesNotMatch(c.message, /snag/i);
});

test("every message is plain prose a person can act on", () => {
  const kinds = [
    apiErr(400, "credit balance is too low"),
    apiErr(401, "bad key", "authentication_error"),
    apiErr(429, "slow down", "rate_limit_error"),
    apiErr(529, "overloaded", "overloaded_error"),
    new Error("boom"),
  ].map(classifyModelError);
  for (const c of kinds) {
    assert.ok(c.message.length > 20, "no terse codes");
    assert.doesNotMatch(c.message, /\|/, "no markdown tables — replies are spoken/phone-rendered");
    assert.ok(/[.!]$/.test(c.message.trim()), "a full sentence");
  }
});

test("only an oversized request skips the fallback", () => {
  assert.equal(worthFallingBack("too_large"), false);
  for (const k of ["out_of_credit", "rate_limit", "overloaded", "auth", "unknown"]) {
    assert.equal(worthFallingBack(k), true, `${k} should try the backup model`);
  }
});
