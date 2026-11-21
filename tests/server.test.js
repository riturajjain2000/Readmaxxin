import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAppServer, validateEndpoint } from '../server.mjs';

const modelRequest = {
  endpoint: 'http://localhost:1234/v1/chat/completions',
  protocol: 'compatible', model: 'local-model', apiKey: 'temporary-test-key',
  messages: [{ role: 'system', content: 'Explain reading.' }, { role: 'user', content: '{"selectedText":"bias"}' }],
  stream: true, response_format: { type: 'json_object' }
};

async function withServer(fetchImpl, run) {
  const server = createAppServer({ fetchImpl });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try { await run({ server, port, base: `http://127.0.0.1:${port}` }); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendRaw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

function post(port, path, body, headers = {}) {
  return sendRaw(port, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('endpoint validation rejects credentials and non-HTTP protocols', () => {
  assert.equal(validateEndpoint('http://localhost:11434/api/chat').hostname, 'localhost');
  for (const endpoint of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com/v1', 'https://example.com/#secret', 'not a URL']) assert.throws(() => validateEndpoint(endpoint));
});

test('proxy forwards only provider fields and uses API credentials only in outgoing Authorization', async () => {
  let outgoing;
  await withServer(async (endpoint, options) => {
    outgoing = { endpoint: String(endpoint), options, body: JSON.parse(options.body) };
    return new Response('{"choices":[{"message":{"content":"A definition."}}]}', { headers: { 'Content-Type': 'application/json' } });
  }, async ({ port, base }) => {
    const response = await post(port, '/api/explain', { ...modelRequest, document: 'NEVER FORWARD THE WHOLE DOCUMENT' }, { Origin: base });
    assert.equal(response.status, 200);
    assert.equal(outgoing.endpoint, modelRequest.endpoint);
    assert.equal(outgoing.options.headers.Authorization, `Bearer ${modelRequest.apiKey}`);
    assert.equal(outgoing.options.redirect, 'error');
    assert.deepEqual(outgoing.body, { model: modelRequest.model, messages: modelRequest.messages, stream: true, response_format: { type: 'json_object' } });
    assert.equal(response.text.includes(modelRequest.apiKey), false);
    assert.equal(response.headers.authorization, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('Ollama proxy forwards format and strips compatible response_format', async () => {
  let sent;
  await withServer(async (_, options) => {
    sent = JSON.parse(options.body);
    return new Response('{"message":{"content":"Local answer"}}', { headers: { 'Content-Type': 'application/json' } });
  }, async ({ port }) => {
    const response = await post(port, '/api/explain', { ...modelRequest, endpoint: 'http://localhost:11434/api/chat', protocol: 'ollama', format: 'json' });
    assert.equal(response.status, 200);
    assert.equal(sent.format, 'json');
    assert.equal('response_format' in sent, false);
    assert.equal('apiKey' in sent, false);
  });
});

test('model discovery adapts compatible and Ollama paths and normalizes model names', async () => {
  const calls = [];
  await withServer(async (endpoint, options) => {
    calls.push({ endpoint: String(endpoint), options });
    return new Response(calls.length === 1 ? '{"data":[{"id":"model-a"},{"id":"model-b"}]}' : '{"models":[{"name":"local-a"},{"name":"local-b"}]}', { headers: { 'Content-Type': 'application/json' } });
  }, async ({ port }) => {
    const compatible = await post(port, '/api/models', modelRequest);
    assert.deepEqual(JSON.parse(compatible.text), { models: ['model-a', 'model-b'] });
    assert.equal(calls[0].endpoint, 'http://localhost:1234/v1/models');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${modelRequest.apiKey}`);
    const ollama = await post(port, '/api/models', { endpoint: 'http://localhost:11434/api/chat', protocol: 'ollama' });
    assert.deepEqual(JSON.parse(ollama.text), { models: ['local-a', 'local-b'] });
    assert.equal(calls[1].endpoint, 'http://localhost:11434/api/tags');
  });
});

test('host and cross-origin protection reject requests before contacting a provider', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response('{}'); }, async ({ port }) => {
    const host = await sendRaw(port, '/api/health', { headers: { Host: 'attacker.example' } });
    assert.equal(host.status, 403);
    const origin = await post(port, '/api/explain', modelRequest, { Origin: 'https://attacker.example' });
    assert.equal(origin.status, 403);
    const opaqueOrigin = await post(port, '/api/explain', modelRequest, { Origin: 'null' });
    assert.equal(opaqueOrigin.status, 403);
    assert.equal(calls, 0);
  });
});

test('bad endpoints, malformed JSON, content types, and model requests fail without upstream calls', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response('{}'); }, async ({ port }) => {
    for (const endpoint of ['not a URL', 'file:///tmp/private', 'http://user:password@localhost:1234/v1']) {
      const response = await post(port, '/api/explain', { ...modelRequest, endpoint });
      assert.equal(response.status, 400);
      assert.equal(response.text.includes('password'), false);
    }
    const malformed = await sendRaw(port, '/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400);
    const wrongType = await sendRaw(port, '/api/explain', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.status, 415);
    const noModel = await post(port, '/api/explain', { ...modelRequest, model: '' });
    assert.equal(noModel.status, 400);
    assert.equal(calls, 0);
  });
});

test('static routes reject private project files and encoded traversal paths', async () => {
  await withServer(async () => { throw new Error('Unexpected provider request'); }, async ({ port }) => {
    const index = await sendRaw(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    for (const path of ['/package.json', '/server.mjs', '/unknown-file.txt', '/%2e%2e/package.json', '/vendor/..%2Fpackage.json', '/vendor/..%2Fserver.mjs', '/lib/..%2Fapp.js', '/vendor/%2e%2e%2F.env']) {
      const response = await sendRaw(port, path);
      assert.ok([403, 404].includes(response.status), `${path} returned ${response.status}`);
    }
  });
});

test('upstream non-success responses preserve their status and format error body', async () => {
  await withServer(async () => new Response('{"error":{"message":"response_format unsupported"}}', { status: 400, headers: { 'Content-Type': 'application/json' } }), async ({ port }) => {
    const response = await post(port, '/api/explain', modelRequest);
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.text), { error: { message: 'response_format unsupported' } });
    assert.match(response.headers['content-type'], /application\/json/);
  });
});

test('proxy sends streaming chunks to the reader before the upstream response finishes', async () => {
  let upstream;
  let firstChunk;
  const firstSeen = new Promise((resolve) => { firstChunk = resolve; });
  await withServer(async () => new Response(new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } }), async ({ port }) => {
    const completed = new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/explain', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => { chunks.push(chunk); firstChunk(); });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(JSON.stringify(modelRequest));
    });
    await Promise.race([firstSeen, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('The proxy buffered the model stream.')), 1500); timeout.unref(); })]);
    upstream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    upstream.close();
    const output = await completed;
    assert.match(output, /first/);
    assert.match(output, /\[DONE\]/);
  });
});

test('disconnecting a streaming reader cancels the upstream request signal', async () => {
  let markAborted;
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  await withServer(async (_, { signal }) => {
    signal.addEventListener('abort', markAborted, { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, async ({ port }) => {
    await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/explain', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
        response.once('data', () => { response.destroy(); resolve(); });
        response.on('error', () => {});
      });
      request.on('error', reject);
      request.end(JSON.stringify(modelRequest));
    });
    await Promise.race([aborted, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('The proxy did not cancel its upstream request.')), 1500); timeout.unref(); })]);
  });
});
