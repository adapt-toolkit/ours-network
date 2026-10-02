import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createNotificationsAdapter, daemonCredentialCheck } from '../assets/scripts/runtime/notifications-gateway.mjs';

const USER = 'u'.repeat(43), PRODUCER = 'p'.repeat(43), SERVER = 's'.repeat(43);

async function fixture() {
  const seen = [];
  const service = { server: createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: { ...req.headers } }); res.end('{}'); }), async close() {} };
  service.server.on('upgrade', (req, socket) => { seen.push({ upgrade: true, url: req.url, headers: { ...req.headers } }); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  const daemon = createServer((req, res) => { res.writeHead(req.url === '/identities' && req.headers['x-ours-api-token'] === SERVER ? 200 : 401); res.end(); });
  daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
  const adapter = createNotificationsAdapter({ service, userToken: USER, verifyServerCredential: daemonCredentialCheck(`http://127.0.0.1:${daemon.address().port}`) });
  adapter.server.listen(0, '127.0.0.1'); await once(adapter.server, 'listening');
  const base = `http://127.0.0.1:${adapter.server.address().port}`;
  const call = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  const upgrade = (headers) => new Promise((resolve, reject) => {
    const req = request(base + '/api/v1/presence', { headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  return { seen, call, upgrade, async close() { await adapter.close(); daemon.closeAllConnections(); daemon.close(); } };
}

test('acts as the owner only for a daemon-authenticated server credential, with browser context removed', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(await f.call('/api/v1/summary', { headers: { 'x-ours-api-token': SERVER, cookie: 'a=b', origin: 'https://app.ours-tunnel.com', 'sec-fetch-site': 'cross-site', authorization: 'Bearer browser' } }), 200);
  const [forwarded] = f.seen;
  assert.equal(forwarded.headers.authorization, `Bearer ${USER}`);
  for (const name of ['cookie', 'origin', 'sec-fetch-site', 'x-ours-api-token']) assert.equal(forwarded.headers[name], undefined, name);
});

test('refuses an invalid server credential without reaching the service', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(await f.call('/api/v1/summary', { headers: { 'x-ours-api-token': 'wrong' } }), 401);
  assert.equal(await f.call('/api/v1/summary', { headers: { 'x-ours-api-token': '' } }), 401);
  assert.deepEqual(f.seen, []);
});

test('injects nothing for a caller without a server credential', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(await f.call('/api/v1/summary'), 200);
  assert.equal(f.seen[0].headers.authorization, undefined);
  // A loopback producer keeps its own scoped credential for the service to check.
  assert.equal(await f.call('/api/v1/send', { method: 'POST', headers: { authorization: `Bearer ${PRODUCER}` } }), 200);
  assert.equal(f.seen[1].headers.authorization, `Bearer ${PRODUCER}`);
  // A producer selector is only honoured after server authentication.
  assert.equal(await f.call('/api/v1/send', { method: 'POST', headers: { 'x-ours-notifications-producer': PRODUCER } }), 401);
  assert.equal(f.seen.length, 2);
});

test('selects a producer credential only for an authenticated send', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(await f.call('/api/v1/send', { method: 'POST', headers: { 'x-ours-api-token': SERVER, 'x-ours-notifications-producer': PRODUCER } }), 200);
  assert.equal(f.seen[0].headers.authorization, `Bearer ${PRODUCER}`);
  assert.equal(f.seen[0].headers['x-ours-notifications-producer'], undefined);
  for (const [path, method] of [['/api/v1/summary', 'GET'], ['/api/v1/send', 'GET'], ['/api/v1/read', 'POST']])
    assert.equal(await f.call(path, { method, headers: { 'x-ours-api-token': SERVER, 'x-ours-notifications-producer': PRODUCER } }), 401, path);
  assert.equal(f.seen.length, 1);
});

test('authenticates presence upgrades the same way', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(await f.upgrade({ 'x-ours-api-token': 'wrong' }), 401);
  assert.equal(await f.upgrade({ 'x-ours-api-token': SERVER, origin: 'https://app.ours-tunnel.com' }), 101);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers.authorization, `Bearer ${USER}`);
  assert.equal(f.seen[0].headers.origin, undefined);
});

test('shutdown with an open presence connection closes the service and finishes promptly', async () => {
  const sockets = new Set();
  let serviceClosed = false;
  const inner = createServer();
  // Like the real service: upgraded presence sockets stay open until the service closes them.
  inner.on('upgrade', (_req, socket) => { sockets.add(socket); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  const service = { server: inner, async close() { serviceClosed = true; for (const socket of sockets) socket.destroy(); } };
  const adapter = createNotificationsAdapter({ service, userToken: USER, verifyServerCredential: async () => true });
  adapter.server.listen(0, '127.0.0.1'); await once(adapter.server, 'listening');
  const client = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${adapter.server.address().port}/api/v1/presence`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'x-ours-api-token': SERVER } });
    req.on('upgrade', (_res, socket) => resolve(socket)); req.on('error', reject); req.end();
  });
  const closed = adapter.close().then(() => 'closed');
  const outcome = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))]);
  client.destroy();
  assert.equal(outcome, 'closed');
  assert.equal(serviceClosed, true);
});

test('shutdown destroys an upgraded connection the service did not close', async () => {
  const inner = createServer();
  inner.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
  const adapter = createNotificationsAdapter({ service: { server: inner, async close() {} }, userToken: USER, verifyServerCredential: async () => true });
  adapter.server.listen(0, '127.0.0.1'); await once(adapter.server, 'listening');
  const client = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${adapter.server.address().port}/api/v1/presence`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'x-ours-api-token': SERVER } });
    req.on('upgrade', (_res, socket) => resolve(socket)); req.on('error', reject); req.end();
  });
  const ended = once(client, 'close');
  const outcome = await Promise.race([adapter.close().then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))]);
  assert.equal(outcome, 'closed');
  await ended;
});
