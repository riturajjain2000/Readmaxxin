import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseStructuredResponse, completionText, readCompletion, generate } from '../lib/ai.js';

const encoder = new TextEncoder();
const request = { action: 'explain', selectedText: 'inductive bias', containingParagraph: 'The model encodes an inductive bias.' };

function chunkedResponse(text, contentType, chunkSize = 3) {
  const bytes = encoder.encode(text);
  let position = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(position, position + chunkSize));
      position += chunkSize;
    }
  }), { headers: { 'Content-Type': contentType } });
}

test('prompts contain only the selection and supplied paragraph, with an explicit injection boundary', () => {
  const messages = buildMessages({ ...request, entireDocument: 'PRIVATE WHOLE DOCUMENT', previousParagraph: 'PRIVATE PREVIOUS PARAGRAPH', history: ['PRIVATE HISTORY'] });
  const payload = JSON.parse(messages[1].content);
  assert.deepEqual(payload, request);
  assert.equal(messages.some((message) => /PRIVATE/.test(message.content)), false);
  assert.match(messages[0].content, /untrusted source data/);
  assert.match(messages[0].content, /contextualMeaning/);
});

test('follow-ups include the current explanation while dropping unrelated object properties', () => {
  const messages = buildMessages({ ...request, action: 'custom', question: 'Why does this help?', explanationContext: { technicalDefinition: 'An assumption on a hypothesis space.', body: 'It favors certain hypotheses.', wholeDocument: 'DO NOT SEND', prerequisites: ['hypothesis', 'generalization', 'learning', 'extra'] } });
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.question, 'Why does this help?');
  assert.equal(payload.explanationContext.body, 'It favors certain hypotheses.');
  assert.deepEqual(payload.explanationContext.prerequisites, ['hypothesis', 'generalization', 'learning']);
  assert.equal('wholeDocument' in payload.explanationContext, false);
  assert.match(messages[0].content, /question directly/);
  assert.equal('explanationContext' in JSON.parse(buildMessages({ ...request, explanationContext: 'OLD LOOKUP' })[1].content), false);
});

test('action prompts distinguish examples and simplification from the default definition', () => {
  assert.match(buildMessages({ ...request, action: 'example' })[0].content, /one concrete/);
  assert.match(buildMessages({ ...request, action: 'simplify' })[0].content, /simpler, direct language/);
  assert.throws(() => buildMessages({ selectedText: '   ' }), /Select some/);
});

test('structured parsing accepts provider fences and body answers and limits prerequisites', () => {
  assert.deepEqual(parseStructuredResponse('```json\n{"body":"A concrete example.","prerequisites":["a","b","c","d"]}\n```'), { technicalDefinition: null, contextualMeaning: null, prerequisites: ['a', 'b', 'c'], body: 'A concrete example.' });
  assert.equal(parseStructuredResponse('provider prose {"technicalDefinition":"A definition."} trailing').technicalDefinition, 'A definition.');
  assert.equal(parseStructuredResponse('["not a response"]'), null);
  assert.equal(parseStructuredResponse('{"unexpected":true}'), null);
});

test('completionText handles compatible, content-part, and Ollama response shapes', () => {
  assert.equal(completionText({ choices: [{ delta: { content: 'word' } }] }), 'word');
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }] }), 'onetwo');
  assert.equal(completionText({ message: { content: 'local answer' } }), 'local answer');
});

test('SSE decoding preserves split UTF-8 characters and event boundaries', async () => {
  const tokens = ['A ', 'technical 🧠 ', 'definition.'];
  const sse = tokens.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const progress = [];
  const result = await readCompletion(chunkedResponse(sse, 'text/event-stream', 1), { onProgress: (text) => progress.push(text) });
  assert.equal(result, tokens.join(''));
  assert.ok(progress.includes('A '));
  assert.equal(progress.at(-1), result);
});

test('Ollama NDJSON chunks accumulate without swallowing the final un-delimited packet', async () => {
  const ndjson = JSON.stringify({ message: { content: 'Local ' }, done: false }) + '\n' + JSON.stringify({ message: { content: 'answer.' }, done: true });
  assert.equal(await readCompletion(chunkedResponse(ndjson, 'application/x-ndjson', 2)), 'Local answer.');
});

test('JSON responses work when a provider ignores streaming', async () => {
  const response = new Response(JSON.stringify({ choices: [{ message: { content: '{"technicalDefinition":"Answer."}' } }] }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal(await readCompletion(response), '{"technicalDefinition":"Answer."}');
});

test('empty responses and stream error packets fail visibly', async () => {
  await assert.rejects(readCompletion(new Response('{"choices":[]}', { headers: { 'Content-Type': 'application/json' } })), /empty explanation/);
  await assert.rejects(readCompletion(chunkedResponse('data: {"error":{"message":"Model is not loaded"}}\n\n', 'text/event-stream')), /Model is not loaded/);
  await assert.rejects(readCompletion(chunkedResponse('{"error":"Load a model first"}\n', 'application/x-ndjson')), /Load a model first/);
  await assert.rejects(readCompletion(new Response('{}', { status: 401 })), /API key/);
});

test('generate uses the local proxy and snapshots provider configuration', async () => {
  const calls = [];
  const output = await generate(request, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'local-model', apiKey: 'session-secret', fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response('{"choices":[{"message":{"content":"result"}}]}', { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(output, 'result');
  assert.equal(calls[0].url, '/api/explain');
  assert.equal(calls[0].body.apiKey, 'session-secret');
  assert.equal(calls[0].body.protocol, 'compatible');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(JSON.stringify(calls[0].body.messages).includes('session-secret'), false);
});

test('unsupported JSON-format fallback retries using the same signal and messages', async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await generate(request, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test', signal: controller.signal, fetchImpl: async (url, options) => {
    calls.push(options);
    return calls.length === 1
      ? new Response('{"error":"response_format is not supported"}', { status: 400 })
      : new Response('{"choices":[{"message":{"content":"fallback answer"}}]}');
  } });
  assert.equal(result, 'fallback answer');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[1].signal, controller.signal);
  const first = JSON.parse(calls[0].body);
  const second = JSON.parse(calls[1].body);
  assert.deepEqual(first.messages, second.messages);
  assert.equal('response_format' in second, false);
});

test('a request aborted while inspecting a format error never launches a stale retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = generate(request, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test', signal: controller.signal, fetchImpl: async () => {
    calls++;
    return { status: 400, clone: () => ({ text: async () => { controller.abort(); return 'response_format unsupported'; } }) };
  } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('direct Ollama requests use format json and the caller signal', async () => {
  const controller = new AbortController();
  let sent;
  const result = await generate(request, { endpoint: 'http://localhost:11434/api/chat', model: 'local', protocol: 'ollama', useProxy: false, signal: controller.signal, fetchImpl: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return chunkedResponse('{"message":{"content":"Ollama answer"},"done":true}\n', 'application/x-ndjson');
  } });
  assert.equal(result, 'Ollama answer');
  assert.equal(sent.url, 'http://localhost:11434/api/chat');
  assert.equal(sent.body.format, 'json');
  assert.equal('response_format' in sent.body, false);
  assert.equal(sent.options.signal, controller.signal);
});

test('aborting a stalled response releases its stream instead of leaving a reader pending', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const pending = readCompletion(response, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
