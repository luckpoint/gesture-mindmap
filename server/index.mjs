import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CodexClient } from './codex-client.mjs';
import { InstructionService, ServiceError } from './instruction-service.mjs';

const staticRoot = fileURLToPath(new URL('../ui-prototype/', import.meta.url));
const types = { '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function body(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0, oversized = false; const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { if (!oversized) { oversized = true; chunks.length = 0; reject(new ServiceError('送信データは1MiBまでです', 413)); } return; }
      if (!oversized) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (oversized) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ServiceError('JSONの形式が正しくありません')); }
    });
  });
}
export function createRelay(client, service, { instructions = false } = {}) {
  instructions = instructions === true;
  service = instructions ? (service || new InstructionService(client)) : null;
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    try {
      // Validate against the listening socket, never a forwarded or caller-selected host.
      const port = req.socket.localPort;
      const host = req.headers.host?.toLowerCase();
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (port === 80) ['127.0.0.1', 'localhost', '[::1]'].forEach(h => hosts.add(h));
      if (!hosts.has(host)) throw new ServiceError('許可されていないホストです', 403);
      const origin = `http://${host}`;
      if ((req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        throw new ServiceError('同じサイトから接続してください', 403);
      }
      const cookieName = `mindmap_relay_${port}`;
      const url = new URL(req.url, 'http://localhost');
      if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/features.js') {
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store',
          ...(instructions ? { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/` } : {}) });
        res.end(req.method === 'HEAD' ? undefined : `globalThis.MindmapFeatures = Object.freeze({ instructions: ${instructions} });`); return;
      }
      if (!instructions && (url.pathname === '/api/codex' || url.pathname.startsWith('/api/codex/') || url.pathname === '/api/instructions' || url.pathname.startsWith('/api/instructions/'))) {
        json(res, 404, { message: 'APIが見つかりません' }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const supplied = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
        if (Buffer.byteLength(supplied) !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new ServiceError('アプリを再読み込みしてください', 401);
        if (req.method === 'POST' && (url.pathname === '/api/instructions' || url.pathname.endsWith('/answer')) &&
            req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ServiceError('application/jsonで送信してください', 415);
      }
      if (req.method === 'GET' && url.pathname === '/api/codex/status') { json(res, 200, await client.status()); return; }
      if (req.method === 'POST' && url.pathname === '/api/instructions') {
        const run = service.submit(await body(req)); json(res, 202, { requestId: run.input.requestId }); return;
      }
      const match = url.pathname.match(/^\/api\/instructions\/([^/]+)\/(events|cancel|answer)$/);
      if (match) {
        const run = service.get(match[1], url.searchParams.get('clientSessionId'));
        if (req.method === 'POST' && match[2] === 'answer') { service.answer(run, await body(req)); json(res, 202, { requestId: run.input.requestId }); return; }
        if (req.method === 'POST' && match[2] === 'cancel') { service.cancel(run); json(res, 200, { requestId: run.input.requestId }); return; }
        if (req.method === 'GET' && match[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
          res.flushHeaders();
          const unsubscribe = service.subscribe(run, event => res.write(`data: ${JSON.stringify(event)}\n\n`));
          const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
          res.on('close', () => { clearInterval(keepalive); unsubscribe(); }); return;
        }
      }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { message: 'APIが見つかりません' }); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      let path;
      try { path = await realpath(resolve(staticRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : extname(url.pathname) ? url.pathname : url.pathname + '.html'))); }
      catch { res.writeHead(404); res.end('Not found'); return; }
      if (!path.startsWith(resolve(staticRoot) + sep)) { res.writeHead(404); res.end(); return; }
      const data = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { message: error.status ? error.message : '中継サーバーで処理できませんでした' }); else res.end(); }
  });
  return { server, service };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instructions = process.env.ENABLE_CODEX_INSTRUCTIONS === 'true';
  const client = instructions ? new CodexClient() : null;
  const { server, service } = createRelay(client, undefined, { instructions });
  // Keep ordinary editing available even if the CLI/login is unavailable.
  if (instructions) client.start().catch(async () => { console.error('Codexを起動できません。CLI 0.163.0 とログイン状態・管理設定を確認し、中継を再起動してください。'); await client.close(); });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`Mindmap: http://127.0.0.1:${port}`));
  const close = async () => { service?.close(); server.closeAllConnections(); server.close(); await client?.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
