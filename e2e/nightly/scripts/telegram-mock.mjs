import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';

mkdirSync('/certs', { recursive: true });
if (!existsSync('/certs/mock.crt') || !existsSync('/certs/mock.key')) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', '/certs/mock.key', '-out', '/certs/mock.crt',
    '-subj', '/CN=api.telegram.org', '-addext', 'subjectAltName=DNS:api.telegram.org',
  ], { stdio: 'ignore' });
}
const requests = [];
const updates = [];
let dropNextSend = false;
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
createHttpsServer({
  cert: readFileSync('/certs/mock.crt'), key: readFileSync('/certs/mock.key'),
}, async (req, res) => {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  requests.push({ method: req.method, path: req.url, body: Buffer.concat(body).toString('utf8') });
  const method = req.url?.split('/').pop() ?? '';
  if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'E2E Mock', username: 'ours_e2e_bot' } });
  if (method === 'getUpdates') {
    await new Promise(resolve => setTimeout(resolve, 500));
    const offset = Number(JSON.parse(Buffer.concat(body).toString('utf8')).offset ?? 0);
    return json(res, 200, { ok: true, result: updates.filter(update => update.update_id >= offset) });
  }
  if (method === 'sendMessage') {
    if (dropNextSend) {
      dropNextSend = false;
      req.socket.destroy(); // Telegram accepted the POST; the response was lost.
      return;
    }
    return json(res, 200, { ok: true, result: { message_id: requests.length, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, text: 'mock' } });
  }
  return json(res, 404, { ok: false, error_code: 404, description: `Unconfigured Telegram mock method: ${method}` });
}).listen(443, '0.0.0.0');
createHttpServer((req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.url === '/requests') return json(res, 200, { requests });
  if (req.url === '/reset' && req.method === 'POST') { requests.length = 0; updates.length = 0; dropNextSend = false; return json(res, 200, { ok: true }); }
  if (req.url === '/drop-next-send' && req.method === 'POST') { dropNextSend = true; return json(res, 200, { ok: true }); }
  if (req.url === '/enqueue' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      updates.push(update);
      json(res, 200, { ok: true });
    });
    return;
  }
  return json(res, 404, { error: 'not_found' });
}).listen(8080, '0.0.0.0');
