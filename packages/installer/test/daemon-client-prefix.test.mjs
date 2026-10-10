// The plugin-only daemon container's client prefix, against a real upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createPrefixServer, daemonPath, discovery, CAPABILITY } from '../assets/scripts/runtime/daemon-client-prefix.mjs';

const instanceId = '12345678-1234-1234-1234-123456789abc';

async function harness(handler) {
  const seen = [];
  const upstream = createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res); });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ upgrade: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const prefix = createPrefixServer({ upstreamPort: upstream.address().port, instanceId });
  prefix.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => prefix.listen(0, '127.0.0.1', resolve));
  const port = prefix.address().port;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const close = async () => { for (const socket of sockets) socket.destroy(); prefix.close(); upstream.close(); };
  return { port, seen, send, close };
}

test('only origin-form paths under /daemon/ reach the daemon, without the prefix', () => {
  assert.equal(daemonPath('/daemon/selection'), '/selection');
  assert.equal(daemonPath('/daemon/api/v1/x?y=1'), '/api/v1/x?y=1');
  for (const target of ['/daemon', '/daemonx/selection', '/cowork/rpc', '/', 'http://evil/daemon/selection', '/daemon/../identities',
    '/daemon/%2e%2e/identities', '/daemon/a/%2E/b', '/daemon/a%2fb', '/daemon/%zz', '/daemon/a b'])
    assert.equal(daemonPath(target), null, target);
});

test('discovery is truthful: only the daemon, and not the full gateway capability', () => {
  const value = discovery(instanceId);
  assert.deepEqual(value, { schema: 1, instanceId, services: { daemon: '/daemon' }, capabilities: [CAPABILITY] });
  assert.ok(!value.capabilities.includes('ours.gateway-v1'));
  assert.ok(!value.capabilities.includes('cowork.http-management-v1'));
});

test('requests, credentials and bodies pass through unchanged; other paths are refused', async () => {
  const h = await harness((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' }); res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() })); });
  });
  try {
    const sent = await h.send('/daemon/api/v1/send', { method: 'POST', headers: { 'x-ours-api-token': 'secret-token', 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(sent.status, 201);
    assert.equal(sent.headers['x-upstream'], 'yes');
    assert.deepEqual(JSON.parse(sent.body), { path: '/api/v1/send', body: '{"a":1}' });
    assert.equal(h.seen[0].headers['x-ours-api-token'], 'secret-token');
    // Unauthenticated requests are forwarded untouched, so the daemon itself denies them.
    await h.send('/daemon/identities');
    assert.equal(h.seen[1].headers['x-ours-api-token'], undefined);
    for (const path of ['/cowork/management/rpc', '/messenger/', '/', '/daemon/../identities']) {
      assert.equal((await h.send(path)).status, 404, path);
    }
    assert.equal(h.seen.length, 2, 'refused paths never reach the daemon');
    assert.equal((await h.send('/daemon')).status, 308);
    const well = await h.send('/.well-known/ours');
    assert.deepEqual(JSON.parse(well.body).services, { daemon: '/daemon' });
  } finally { await h.close(); }
});

test('absolute-form and CONNECT requests never reach the daemon', async () => {
  const h = await harness((req, res) => res.end('reached'));
  try {
    const raw = async text => {
      const socket = connect(h.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(text);
      const chunks = []; socket.on('data', c => chunks.push(c));
      await once(socket, 'close');
      return Buffer.concat(chunks).toString();
    };
    assert.match(await raw('GET http://127.0.0.1/daemon/selection HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 404/);
    assert.match(await raw('CONNECT 127.0.0.1:3050 HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 405/);
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

test('streamed responses flow incrementally and a client disconnect cancels the upstream request', async () => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const h = await harness((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    req.on('close', () => upstreamClosed(true));
  });
  try {
    const first = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: h.port, path: '/daemon/watch' }, res => {
        res.once('data', chunk => { resolve(chunk.toString()); req.destroy(); });
      });
      req.on('error', () => {}); req.end();
    });
    assert.equal(first, 'data: first\n\n');
    assert.equal(await closed, true, 'long poll ended at the daemon when the client left');
  } finally { await h.close(); }
});

test('upgrade requests under the prefix are tunnelled; others are refused', async () => {
  const h = await harness((req, res) => res.end());
  try {
    const socket = connect(h.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /daemon/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
    const [head] = await once(socket, 'data');
    assert.match(head.toString(), /^HTTP\/1\.1 101/);
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    assert.equal(echo.toString(), 'ping');
    socket.destroy();
    assert.equal(h.seen.find(row => row.upgrade).upgrade, '/stream');
    const refused = connect(h.port, '127.0.0.1');
    await once(refused, 'connect');
    refused.write('GET /cowork/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
    const [denied] = await once(refused, 'data');
    assert.match(denied.toString(), /^HTTP\/1\.1 404/);
    refused.destroy();
  } finally { await h.close(); }
});

test('an unavailable daemon is reported as 502 without hanging', async () => {
  const h = await harness((req, res) => res.end());
  const prefix = createPrefixServer({ upstreamPort: 1, instanceId });
  await new Promise(resolve => prefix.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: prefix.address().port, path: '/daemon/selection' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 502);
  } finally { prefix.close(); await h.close(); }
});
