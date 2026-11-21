import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

export function validateEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use an HTTP or HTTPS endpoint without credentials in the URL.');
  return url;
}

function sendJSON(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('The AI request is too large. Select a shorter passage.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createAppServer({ fetchImpl = fetch } = {}) {
  return createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return sendJSON(res, 403, { error: 'Readmaxxin accepts local connections only.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const pathname = new URL(req.url, `http://${host}`).pathname;
    try {
      if (pathname === '/api/health' && req.method === 'GET') return sendJSON(res, 200, { ok: true });
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST' || !['/api/explain', '/api/models'].includes(pathname)) return sendJSON(res, 404, { error: 'Unknown action.' });
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJSON(res, 403, { error: 'This request must come from Readmaxxin.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return sendJSON(res, 415, { error: 'Expected JSON.' });
        const input = await readJSON(req);
        const endpoint = validateEndpoint(input.endpoint);
        const key = input.apiKey || process.env.READMAXXIN_API_KEY;
        const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          if (pathname === '/api/models') {
            endpoint.pathname = input.protocol === 'ollama' ? '/api/tags' : endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models');
            const response = await fetchImpl(endpoint, { headers, signal: controller.signal, redirect: 'error' });
            if (!response.ok) return sendJSON(res, response.status, { error: `The model server returned ${response.status}.` });
            const data = await response.json();
            const models = input.protocol === 'ollama' ? (data.models || []).map((item) => item.name) : (data.data || []).map((item) => item.id);
            return sendJSON(res, 200, { models });
          }
          if (typeof input.model !== 'string' || !input.model.trim() || !Array.isArray(input.messages) || input.messages.some((message) => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) return sendJSON(res, 400, { error: 'A model and valid explanation request are required.' });
          const body = { model: input.model, messages: input.messages, stream: input.stream !== false };
          if (input.protocol === 'ollama') { if (input.format) body.format = input.format; }
          else { if (input.response_format) body.response_format = input.response_format; }
          const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
          res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          if (response.body) await pipeline(Readable.fromWeb(response.body), res);
          else res.end();
        } finally { clearTimeout(timeout); }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return sendJSON(res, 405, { error: 'Method not allowed.' });
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      if (relative.split('/').some((segment) => segment === '.' || segment === '..')) return sendJSON(res, 403, { error: 'Invalid path.' });
      const vendor = {
        'vendor/pdf.mjs': 'node_modules/pdfjs-dist/build/pdf.mjs',
        'vendor/pdf.worker.mjs': 'node_modules/pdfjs-dist/build/pdf.worker.mjs',
        'vendor/mammoth.browser.js': 'node_modules/mammoth/mammoth.browser.min.js'
      };
      let source = vendor[relative];
      if (!source && /^vendor\/katex\/(?:katex\.(?:mjs|css)|contrib\/auto-render\.mjs|fonts\/[\w-]+\.(?:woff2?|ttf))$/.test(relative)) source = relative.replace('vendor/katex/', 'node_modules/katex/dist/');
      if (!source && !/^(?:index\.html|app\.js|styles\.css|lib\/[\w/-]+\.js)$/.test(relative)) return sendJSON(res, 404, { error: 'File not found.' });
      const file = resolve(root, source || relative);
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return sendJSON(res, 403, { error: 'Invalid path.' });
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const message = error.name === 'AbortError' ? 'The model took too long to respond. Try again or choose a smaller model.' : error.code === 'ENOENT' ? 'File not found.' : error instanceof TypeError && /fetch/i.test(error.message) ? 'Could not reach the model server. Check that it is running and the endpoint is correct.' : error.message;
      const status = error.code === 'ENOENT' ? 404 : error.name === 'AbortError' ? 504 : error instanceof TypeError && /fetch/i.test(error.message) ? 502 : 400;
      sendJSON(res, status, { error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, '127.0.0.1', () => console.log(`Readmaxxin: http://127.0.0.1:${port}`));
}
