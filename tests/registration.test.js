import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrationHandler, registrationSchema } from '../src/registration.js';
import { buildToolkit } from '../src/tools.js';
import { groqCreate, withGroqFallback, groqDiag } from '../src/groq.js';
import { canAnswerFromKnowledge, cleanBackupHistory, stripBackupBanner } from '../src/chatpolicy.js';

const input = { game_id: 'gravegold', game_name: 'Gravegold', developer_name: 'Fabian', studio_name: 'Interverse' };
const context = { authUser: { userId: 'fabian', role: 'admin' }, userId: 'spoofed' };
function setup(overrides = {}) {
  const requests = [], stored = [];
  const deps = {
    isAdmin: ctx => ctx.authUser?.userId === 'fabian', configured: () => true, vaultReady: () => true,
    prepareVault: async () => {},
    request: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { success: true, data: { game_id: 'gravegold', api_key: 'issued-secret' } }; },
    store: async value => { stored.push(value); return { id: 42 }; },
    ...overrides,
  };
  return { run: createRegistrationHandler(deps), requests, stored };
}

test('registration sends confirmed identity and stores issued key outside model output', async () => {
  const s = setup();
  const result = await s.run(input, context);
  assert.equal(result.registered, true);
  assert.equal(result.credential_saved, true);
  assert.equal(result.vault_id, 42);
  assert.equal(s.requests[0].path, '/games/register');
  assert.deepEqual(s.requests[0].body, { game_id: 'gravegold', game_name: 'Gravegold', developer_name: 'Fabian', game_metadata: { studio_name: 'Interverse', updated_by: 'tracy:fabian' } });
  assert.equal(s.stored[0].secret, 'issued-secret');
  assert.equal(s.stored[0].recipient, 'fabian');
  assert.equal(s.stored[0].oneTime, false);
  assert.ok(!JSON.stringify(result).includes('issued-secret'));
});

test('registration rejects unauthenticated and spoofed admin identities before network calls', async () => {
  for (const ctx of [{ userId: 'fabian' }, { authUser: { userId: 'other' }, userId: 'fabian' }]) {
    const s = setup();
    assert.match((await s.run(input, ctx)).error, /authenticated/);
    assert.equal(s.requests.length, 0);
  }
});

test('missing config, unhealthy storage and invalid input never create a game', async () => {
  for (const overrides of [ { configured: () => false }, { vaultReady: () => false }, { prepareVault: async () => { throw new Error('db secret'); } } ]) {
    const s = setup(overrides);
    assert.ok((await s.run(input, context)).error);
    assert.equal(s.requests.length, 0);
  }
  for (const bad of [{ ...input, game_id: '../other' }, { ...input, studio_name: '' }, { ...input, developer_name: 23 }, null]) {
    const s = setup();
    assert.ok((await s.run(bad, context)).error);
    assert.equal(s.requests.length, 0);
  }
});

test('duplicate, auth, network and storage failures are explicit without retries or secrets', async () => {
  for (const status of [400, 403, 500, undefined]) {
    let count = 0;
    const s = setup({ request: async () => { count++; throw Object.assign(new Error('private details'), { status }); } });
    const result = await s.run(input, context);
    assert.ok(result.error);
    assert.equal(count, 1);
    assert.ok(!JSON.stringify(result).includes('private details'));
    if (status === 500 || !status) assert.equal(result.outcome, 'unknown');
  }
  const s = setup({ store: async () => { throw new Error('issued-secret'); } });
  const result = await s.run(input, context);
  assert.equal(result.registered, true);
  assert.equal(result.credential_saved, false);
  assert.match(result.error, /do not register again/);
  assert.ok(!JSON.stringify(result).includes('issued-secret'));
});

test('concurrent calls do not submit duplicate registrations', async () => {
  let unblock;
  const s = setup({ prepareVault: () => new Promise(resolve => { unblock = resolve; }) });
  const first = s.run(input, context);
  const duplicate = await s.run(input, context);
  assert.match(duplicate.error, /in progress/);
  unblock();
  await first;
  assert.equal(s.requests.length, 1);
});

test('registration is exposed only on the operator toolkit', () => {
  assert.ok(buildToolkit(['interverse_admin']).schemas.some(t => t.name === registrationSchema.name));
  assert.ok(!buildToolkit([]).schemas.some(t => t.name === registrationSchema.name));
});

test('Groq can complete registration after Claude billing failure without seeing the key', async () => {
  const s = setup();
  let round = 0;
  const client = withGroqFallback({ messages: { create: async () => { throw new Error('credit balance too low'); } } }, {
    env: { GROQ_API_KEY: 'test' },
    create: params => groqCreate(params, { env: { GROQ_API_KEY: 'test' }, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(!options.body.includes('issued-secret'));
      const message = ++round === 1 ? { tool_calls: [{ id: 'reg', type: 'function', function: { name: registrationSchema.name, arguments: JSON.stringify(input) } }] }
        : { content: 'Gravegold is registered; credentials are in your vault.' };
      if (round === 2) assert.equal(JSON.parse(body.messages.at(-1).content).vault_id, 42);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: round === 1 ? 'tool_calls' : 'stop', message }] }) };
    } }),
  });
  const params = { system: 'Register only when asked.', messages: [{ role: 'user', content: 'Register Gravegold, developer Fabian, studio Interverse.' }], tools: [registrationSchema], max_tokens: 1024 };
  const first = await client.messages.create(params);
  const result = await s.run(first.content[0].input, context);
  params.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'reg', content: JSON.stringify(result) }] });
  const final = await client.messages.create(params);
  assert.equal(client.provider, 'groq');
  assert.match(final.content[0].text, /registered/);
  assert.equal(s.requests.length, 1);
});

test('admin action requests bypass cached replies and duplicated backup banners are stripped', () => {
  assert.equal(canAnswerFromKnowledge('admin'), false);
  assert.equal(canAnswerFromKnowledge('desktop'), true);
  const old = '*(Running on backup — Out of credit.)*\n*(Running on backup — Out of credit.)*\nCannot register.';
  assert.equal(stripBackupBanner(old), 'Cannot register.');
  assert.equal(cleanBackupHistory([{ role: 'assistant', content: old }])[0].content, 'Cannot register.');
  assert.equal(cleanBackupHistory([{ role: 'user', content: old }])[0].content, old);
});

test('Groq diagnostics classify errors without storing provider content', async () => {
  const client = withGroqFallback({ messages: { create: async () => { throw new Error('credit balance'); } } }, {
    env: { GROQ_API_KEY: 'test-secret' },
    create: params => groqCreate(params, { env: { GROQ_API_KEY: 'test-secret' }, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'tool_use_failed', message: 'private prompt', failed_generation: 'private tool data' } }) }) }),
  });
  await assert.rejects(client.messages.create({ system: '', messages: [], max_tokens: 20 }));
  assert.equal(groqDiag().lastAttempt.kind, 'tool_call');
  assert.equal(client.fallbackFailure.kind, 'tool_call');
  assert.ok(!JSON.stringify(groqDiag()).includes('private'));
  assert.ok(!JSON.stringify(groqDiag()).includes('test-secret'));
});

test('backup cleanup preserves null entries for the existing message sanitizer', () => {
  assert.deepEqual(cleanBackupHistory([null, { role: 'assistant', content: [null, { type: 'text', text: 'Hi' }] }]), [null, { role: 'assistant', content: [null, { type: 'text', text: 'Hi' }] }]);
});

test('registration preparation narrows only Groq Admin requests, retaining history and forced-tool schema', async () => {
  const { prepareRegistrationCall, registrationReply } = await import('../src/registration.js');
  const p = { system: 'Long product prompt', messages: [{ role: 'user', content: 'Register Gravegold, developer Fabian, studio Interverse.' }], tools: [registrationSchema, { name: 'other_tool' }], max_tokens: 2048 };
  const prepared = prepareRegistrationCall(p, 'admin');
  assert.equal(prepared.tools.length, 1);
  assert.equal(prepared.tools[0].name, 'register_interverse_game');
  assert.equal(prepared.messages, p.messages);
  assert.equal(prepared.max_tokens, 1024);
  assert.equal(prepareRegistrationCall(p, 'desktop'), p);
  const unrelated = { ...p, messages: [{ role: 'user', content: 'What is the weather?' }] };
  assert.equal(prepareRegistrationCall(unrelated, 'admin'), unrelated);
  const followup = { ...p, messages: [...p.messages, { role: 'user', content: 'Yes, go ahead.' }] };
  assert.equal(prepareRegistrationCall(followup, 'admin').tools.length, 1);
  const result = await setup().run(input, context);
  assert.match(registrationReply(result), /Registered Gravegold/);
  assert.ok(!registrationReply(result).includes('issued-secret'));
  assert.match(registrationReply({ registered: true, credential_saved: false, error: 'Storage failed; do not retry.' }), /Storage failed/);
});
