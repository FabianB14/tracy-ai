import test from 'node:test';
import assert from 'node:assert/strict';
import { groqDiag, toGroqRequest, groqCreate, withGroqFallback } from '../src/groq.js';
import { runTask } from '../src/aitasks.js';

const env = { GROQ_API_KEY: 'test-secret' };
const tool = { name: 'lookup', description: 'Look up a record', input_schema: { type: 'object', properties: { id: { type: 'string' } } } };
const params = { system: 'You are Tracy', max_tokens: 2048, messages: [{ role: 'user', content: 'hello' }], tools: [tool] };
const answer = { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' };
const primaryFailure = Object.assign(new Error('overloaded'), { status: 529 });
const failing = { messages: { create: async () => { throw primaryFailure; } } };
const completion = (message = { content: 'hello' }, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }], model: 'llama-3.3-70b-versatile', usage: { prompt_tokens: 4, completion_tokens: 2 } });
const toolCall = (name = 'lookup', args = '{"id":"abc"}') => ({ id: 'c1', type: 'function', function: { name, arguments: args } });
const mocked = data => async () => ({ ok: true, json: async () => data });

test('Claude succeeds without contacting Groq', async () => {
  const client = withGroqFallback({ messages: { create: async () => answer } }, { env, create: () => assert.fail('fallback called') });
  assert.equal(await client.messages.create(params), answer);
  assert.equal(client.provider, 'anthropic');
});

test('fallback is disabled without a key; oversized and rejected BYOK requests do not switch', async () => {
  for (const [status, config] of [[529, { env: {} }], [413, { env }], [401, { env, byok: true }]]) {
    const error = Object.assign(new Error('failed'), { status });
    const client = withGroqFallback({ messages: { create: async () => { throw error; } } }, { ...config, create: () => assert.fail('fallback called') });
    await assert.rejects(client.messages.create(params), e => e === error);
  }
});

test('billing, rate limit, auth and outage errors switch to Groq', async () => {
  for (const error of [Object.assign(new Error('credit balance too low'), { status: 400 }), ...[401, 429, 500, 529].map(status => Object.assign(new Error('failed'), { status }))]) {
    const client = withGroqFallback({ messages: { create: async () => { throw error; } } }, { env, create: async () => answer });
    assert.equal(await client.messages.create(params), answer);
    assert.equal(client.provider, 'groq');
  }
});

test('switch mid-loop preserves completed tool results and stays on Groq for this request', async () => {
  let primaryCalls = 0;
  const seen = [];
  const primary = { messages: { create: async () => { if (++primaryCalls === 1) return answer; throw primaryFailure; } } };
  const client = withGroqFallback(primary, { env, create: async p => { seen.push(toGroqRequest(p)); return answer; } });
  await client.messages.create(params);
  const next = { ...params, messages: [...params.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'done', name: 'lookup', input: { id: 'abc' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'done', content: '{"already_done":true}' }] },
  ] };
  await client.messages.create(next);
  await client.messages.create(next);
  assert.equal(primaryCalls, 2);
  assert.equal(seen[0].messages.at(-1).tool_call_id, 'done');
  assert.equal(seen[0].messages.at(-1).content, '{"already_done":true}');
});

test('a failed backup preserves the primary error for Gemini and public error handling', async () => {
  const client = withGroqFallback(failing, { env, create: async () => { throw new Error('secret upstream body'); } });
  await assert.rejects(client.messages.create(params), e => e === primaryFailure);
});

test('images and unsupported blocks are refused before making a Groq request', async () => {
  for (const type of ['image', 'document', 'server_tool_use', 'web_search_tool_result']) {
    await assert.rejects(groqCreate({ ...params, messages: [{ role: 'user', content: [{ type }] }] }, { env, fetchImpl: () => assert.fail('request sent') }));
  }
});

test('request uses fixed endpoint, header authentication, bounded timeout and local tools only', async () => {
  const result = await groqCreate({ ...params, tools: [...params.tools, { type: 'web_search_20250305', name: 'web_search' }] }, { env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].function.name, 'lookup');
    assert.equal(body.model, 'llama-3.3-70b-versatile');
    assert.equal(body.max_completion_tokens, 2048);
    return { ok: true, json: async () => completion() };
  } });
  assert.equal(result.content[0].text, 'hello');
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
});

test('tool calls become Anthropic blocks, including forced tool support', async () => {
  const p = { ...params, temperature: 0, tool_choice: { type: 'tool', name: 'lookup' } };
  assert.deepEqual(toGroqRequest(p).tool_choice, { type: 'function', function: { name: 'lookup' } });
  const result = await groqCreate(p, { env, fetchImpl: mocked(completion({ tool_calls: [toolCall()] }, 'tool_calls')) });
  assert.deepEqual(result.content, [{ type: 'tool_use', id: 'c1', name: 'lookup', input: { id: 'abc' } }]);
  assert.equal(result.stop_reason, 'tool_use');
});

test('malformed, unknown, duplicate, truncated and absent required tool calls fail closed', async () => {
  for (const data of [
    completion({ tool_calls: [toolCall('unknown')] }, 'tool_calls'),
    completion({ tool_calls: [toolCall('lookup', '{bad')] }, 'tool_calls'),
    completion({ tool_calls: [toolCall('lookup', '[]')] }, 'tool_calls'),
    completion({ tool_calls: [toolCall(), toolCall()] }, 'tool_calls'),
    completion({ content: 'partial' }, 'length'),
    completion({ content: '' }),
    completion({ content: 'no tool' }, 'tool_calls'),
  ]) await assert.rejects(groqCreate(params, { env, fetchImpl: mocked(data) }));
  await assert.rejects(groqCreate({ ...params, tool_choice: { type: 'tool', name: 'lookup' } }, { env, fetchImpl: mocked(completion()) }));
});

test('HTTP errors do not expose upstream response bodies; diagnostics contain no key', async () => {
  await assert.rejects(groqCreate(params, { env, fetchImpl: async () => ({ ok: false, status: 429, json: () => assert.fail('read error body') }) }), /HTTP 429/);
  assert.equal(JSON.stringify(groqDiag(env)).includes('test-secret'), false);
  assert.equal(groqDiag({}).configured, false);
  assert.equal(groqDiag({ GROQ_API_KEY: ' ', GROQ_MODEL: 'custom' }).model, 'custom');
});

test('structured task fallback retains validation and reports the actual backup model', async () => {
  const output = { accepted: true, model_id: 'sword', name: 'Sword', properties: { damage: 10 }, reasoning: 'Mapped to target.' };
  const input = { asset: { name: 'Sword' }, target_catalog: { items: [{ model_id: 'sword' }], stat_keys: ['damage'] } };
  let sent;
  const create = p => groqCreate(p, { env, fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => completion({ tool_calls: [toolCall('emit_conversion', JSON.stringify(output))] }, 'tool_calls') };
  } });
  const result = await runTask('convert_asset', input, { client: withGroqFallback(failing, { env, create }), model: 'claude-haiku-4-5' });
  assert.equal(result.model, 'llama-3.3-70b-versatile');
  assert.equal(sent.tool_choice.function.name, 'emit_conversion');
  assert.deepEqual(result.output, output);
  const invalid = withGroqFallback(failing, { env, create: async () => ({ content: [{ type: 'tool_use', input: {} }] }) });
  await assert.rejects(runTask('convert_asset', input, { client: invalid, model: 'claude' }), /validation/);
});

test('network failures and timeout aborts reach the existing final fallback', async () => {
  for (const error of [new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')]) {
    const client = withGroqFallback(failing, { env, create: p => groqCreate(p, {
      env, fetchImpl: async () => { throw error; },
    }) });
    await assert.rejects(client.messages.create(params), e => e === primaryFailure);
  }
});

test('failover state is isolated to one request', async () => {
  let attempts = 0;
  const primary = { messages: { create: async () => { if (++attempts === 1) throw primaryFailure; return answer; } } };
  const first = withGroqFallback(primary, { env, create: async () => answer });
  await first.messages.create(params);
  assert.equal(first.provider, 'groq');
  const second = withGroqFallback(primary, { env, create: () => assert.fail('new request should try Claude') });
  await second.messages.create(params);
  assert.equal(second.provider, 'anthropic');
});
