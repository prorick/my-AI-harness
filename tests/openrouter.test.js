import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, buildMessages, fetchModels, describeError, OpenRouterError } from '../src/js/openrouter.js';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content) => sse({ choices: [{ delta: { content } }] });

// A streaming Response whose body arrives in pieces of `size` bytes — the way
// a network delivers it, with no respect for line or character boundaries.
function streamingResponse(text, size) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// The reply text, the way the page assembles it: text events, in order.
async function collect(events) {
  let text = '';
  for await (const event of events) if (event.type === 'text') text += event.text;
  return text;
}

test('a reply arrives intact however the network cuts it up', async () => {
  const wire =
    ': OPENROUTER PROCESSING\n\n' +
    delta('Voilà — ') +
    delta('日本語 and 🙂 ') +
    ': OPENROUTER PROCESSING\n\n' +
    delta('survive.') +
    'data: [DONE]\n\n';

  // 1 byte at a time splits every multi-byte character and every line; 7 and
  // 4096 cover "ragged" and "all at once".
  for (const size of [1, 7, 4096]) {
    const text = await collect(
      streamChat({ apiKey: 'sk-or-test', model: 'openrouter/auto', messages: [], fetchImpl: async () => streamingResponse(wire, size) }),
    );
    assert.equal(text, 'Voilà — 日本語 and 🙂 survive.', `chunk size ${size}`);
  }
});

test('the request goes to OpenRouter with the key as a bearer token and streaming on', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return streamingResponse('data: [DONE]\n\n', 64);
  };
  await collect(streamChat({ apiKey: 'sk-or-test', model: 'some/model', messages: [{ role: 'user', content: 'hi' }], fetchImpl }));

  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-or-test');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'some/model', messages: [{ role: 'user', content: 'hi' }], stream: true });
});

test('a provider failure in the middle of a reply keeps the text so far and reports the failure', async () => {
  // OpenRouter reports mid-stream failures as a chunk with an `error` field on
  // a 200 response — there is no HTTP status left to signal with.
  const wire = delta('Half an ans') + sse({ error: { code: 502, message: 'Provider disconnected' }, choices: [] });
  const stream = streamChat({ apiKey: 'k', model: 'm', messages: [], fetchImpl: async () => streamingResponse(wire, 16) });

  let text = '';
  await assert.rejects(
    (async () => {
      for await (const event of stream) text += event.text;
    })(),
    (err) => err instanceof OpenRouterError && err.message === 'Provider disconnected',
  );
  assert.equal(text, 'Half an ans');
});

async function events(iterable) {
  const all = [];
  for await (const event of iterable) all.push(event);
  return all;
}
// Consecutive events of one kind joined, so a test reads as "thinking, then answer".
function joined(all) {
  const out = [];
  for (const e of all) {
    const last = out[out.length - 1];
    if (last && last.type === e.type && 'text' in e) last.text += e.text;
    else out.push({ ...e });
  }
  return out;
}

test('thinking arrives before the answer, once, whichever way the provider sends it', async () => {
  // OpenRouter sends reasoning as `reasoning_details` items, and commonly
  // repeats the same text as a plain `reasoning` string in the same chunk.
  // Reading both would show every thought twice.
  const wire =
    sse({ choices: [{ delta: { reasoning: 'Five plus ', reasoning_details: [{ type: 'reasoning.text', text: 'Five plus ', format: 'anthropic-claude-v1', index: 0 }] } }] }) +
    sse({ choices: [{ delta: { reasoning: 'five is ten.', reasoning_details: [{ type: 'reasoning.text', text: 'five is ten.', index: 0 }] } }] }) +
    delta('5 + 5 = 10.') +
    'data: [DONE]\n\n';
  const all = await events(streamChat({ apiKey: 'k', model: 'm', messages: [], fetchImpl: async () => streamingResponse(wire, 9) }));
  assert.deepEqual(joined(all), [
    { type: 'reasoning', text: 'Five plus five is ten.' },
    { type: 'text', text: '5 + 5 = 10.' },
  ]);
});

test('provider-written summaries and plain reasoning strings are both readable; encrypted reasoning is not shown', async () => {
  const wire =
    // OpenAI-style: a summary, under `summary` rather than `text`.
    sse({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: '**Adding numbers**\n\n' }] } }] }) +
    // Providers that send only the plain string.
    sse({ choices: [{ delta: { reasoning: 'Simple arithmetic.' } }] }) +
    // Encrypted reasoning carries nothing a person can read.
    sse({ choices: [{ delta: { reasoning: '[REDACTED]', reasoning_details: [{ type: 'reasoning.encrypted', data: 'gAAAAABo…' }] } }] }) +
    delta('10') +
    'data: [DONE]\n\n';
  const all = await events(streamChat({ apiKey: 'k', model: 'm', messages: [], fetchImpl: async () => streamingResponse(wire, 4096) }));
  assert.deepEqual(joined(all), [
    { type: 'reasoning', text: '**Adding numbers**\n\nSimple arithmetic.' },
    { type: 'text', text: '10' },
  ]);
});

test('thinking is requested only when asked for', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return streamingResponse('data: [DONE]\n\n', 64);
  };
  await events(streamChat({ apiKey: 'k', model: 'm', messages: [], reasoning: true, fetchImpl }));
  await events(streamChat({ apiKey: 'k', model: 'm', messages: [], reasoning: false, fetchImpl }));
  assert.deepEqual(bodies[0].reasoning, { enabled: true });
  assert.ok(!('reasoning' in bodies[1]), 'switched off, the model is left to its own default');
});

test('with a router model, the reply says which model actually answered', async () => {
  // Asking for `openrouter/auto` gets a different model per request; chunks name it.
  const chunk = (content) => sse({ model: 'openai/gpt-x-mini', choices: [{ delta: { content } }] });
  const wire = chunk('Hi') + chunk(' there') + 'data: [DONE]\n\n';
  const all = await events(streamChat({ apiKey: 'k', model: 'openrouter/auto', messages: [], fetchImpl: async () => streamingResponse(wire, 4096) }));
  assert.deepEqual(joined(all), [
    { type: 'model', id: 'openai/gpt-x-mini' },
    { type: 'text', text: 'Hi there' },
  ]);

  // Asked for by name, there is nothing to report.
  const same = await events(streamChat({ apiKey: 'k', model: 'openai/gpt-x-mini', messages: [], fetchImpl: async () => streamingResponse(wire, 4096) }));
  assert.ok(!same.some((e) => e.type === 'model'));
});

test('a rejected key is reported in words that say what to fix', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), { status: 401 });

  let caught;
  try {
    await collect(streamChat({ apiKey: 'wrong', model: 'm', messages: [], fetchImpl }));
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.status, 401);
  assert.match(describeError(caught), /API key/);
  assert.match(describeError(caught), /Settings/);
});

test('being offline is reported as a connection problem, not as a code error', () => {
  // fetch() rejects with a TypeError when the network is unreachable.
  assert.match(describeError(new TypeError('Failed to fetch')), /connection/);
});

test('the conversation is sent without local-only fields (model, error, thinking) and without empty failed replies', () => {
  const stored = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: '', model: 'a/b', error: 'Rate limited.' }, // failed before its first token
    { role: 'user', content: 'First question again' },
    { role: 'assistant', content: 'An answer', model: 'a/b', reasoning: 'Thought about it.', thinkingMs: 1200 },
  ];
  assert.deepEqual(buildMessages(stored, '  Be brief.  '), [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'First question' },
    { role: 'user', content: 'First question again' },
    { role: 'assistant', content: 'An answer' },
  ]);
  assert.equal(buildMessages(stored, '   ')[0].role, 'user', 'a blank system prompt sends no system message');
});

test('the model picker lists text models by name and leaves out speech and image-only models', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'z/writer', name: 'Zed Writer', architecture: { output_modalities: ['text'] } },
          { id: 'a/voice', name: 'A Voice', architecture: { output_modalities: ['audio'] } },
          { id: 'b/no-arch' },
          { id: 'm/multi', name: 'Multi', architecture: { output_modalities: ['image', 'text'] } },
        ],
      }),
      { status: 200 },
    );
  assert.deepEqual(await fetchModels({ fetchImpl }), [
    { id: 'b/no-arch', name: 'b/no-arch' },
    { id: 'm/multi', name: 'Multi' },
    { id: 'z/writer', name: 'Zed Writer' },
  ]);
});
