import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayReadinessScript, describeGatewayReadiness, GATEWAY_READINESS_WAIT_MS } from '../lib/gateway.mjs';
import { realEffects } from '../lib/effects.mjs';

// The probe is the exact script the installer runs inside the daemon
// container; these tests run it with node against a scripted gateway.
const INSTANCE = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'issued-readiness-token-fixture';
const healthy = {
  '/daemon/selection': () => [200, { schema: 1, instanceId: INSTANCE }],
  '/cowork/management/rpc': req => req.headers['x-ours-api-token'] === TOKEN
    ? [200, { version: 1, id: 'installer-readiness', result: [] }] : [401, { version: 1, id: null, error: { code: 'unauthorized', message: 'no' } }],
  '/daemon/identities': req => req.headers['x-ours-api-token'] === TOKEN ? [200, { identities: [] }] : [401, { error: 'unauthorized' }],
};

async function gateway(t, routes = {}) {
  const calls = {};
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/base/, '');
    calls[path] = (calls[path] ?? 0) + 1;
    req.resume();
    req.on('end', () => {
      const handler = routes[path] ?? healthy[path];
      const answer = handler ? handler(req, calls[path]) : [404, { error: 'not found' }];
      if (answer === 'hang') return;
      if (answer === 'reset-body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"identities":'); setTimeout(() => res.socket.destroy(), 50); return; }
      if (answer === 'stall-body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"identities":'); return; }
      const [status, body, type = 'application/json'] = answer;
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}/base`, calls, server };
}

function tokenFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'daemon-token');
  writeFileSync(path, TOKEN + '\n', { mode: 0o600 });
  return path;
}

function probe(script) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr, elapsed: Date.now() - started }));
  });
}
const run = (t, base, options = {}) => probe(gatewayReadinessScript({
  base, instanceId: INSTANCE, tokenPath: tokenFile(t), deadlineMs: 2_000, retryMs: 50, ...options }));

test('a healthy gateway passes on the first attempt', async t => {
  const g = await gateway(t);
  const result = await run(t, g.base);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(g.calls['/daemon/identities'], 1);
});

// The reported update failure: '(authenticated-daemon, CHECK_FAILED)' after a
// single 5s request while restored services were still starting.
test('a daemon still starting behind the gateway is waited for, then passes', async t => {
  const g = await gateway(t, { '/daemon/identities': (req, n) => n <= 3 ? [503, '<html>503</html>', 'text/html'] : healthy['/daemon/identities'](req) });
  const result = await run(t, g.base);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(g.calls['/daemon/identities'], 4);
});

test('persistent unavailability fails within one total deadline and names stage and status', async t => {
  const g = await gateway(t, { '/daemon/identities': () => [503, '<html>503</html>', 'text/html'] });
  const result = await run(t, g.base, { deadlineMs: 600 });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^gateway-readiness:authenticated-daemon:HTTP_503:\d+:transient$/);
  assert(result.elapsed < 600 + 1_500, `took ${result.elapsed}ms`);
  assert.match(describeGatewayReadiness(result.stdout),
    new RegExp(`^authenticated-daemon, HTTP 503; still not ready after \\d+ attempts over ${GATEWAY_READINESS_WAIT_MS / 1000}s$`));
});

test('a hanging request is capped by the remaining deadline', async t => {
  const g = await gateway(t, { '/daemon/identities': () => 'hang' });
  const result = await run(t, g.base, { deadlineMs: 800 });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^gateway-readiness:authenticated-daemon:TIMEOUT:\d+:transient$/);
  assert(result.elapsed < 800 + 1_500, `took ${result.elapsed}ms`);
});

test('a body that stalls after the headers is a bounded timeout, not an invalid answer', async t => {
  const g = await gateway(t, { '/daemon/identities': () => 'stall-body' });
  const result = await run(t, g.base, { deadlineMs: 800 });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^gateway-readiness:authenticated-daemon:TIMEOUT:\d+:transient$/);
  assert(result.elapsed < 800 + 1_500, `took ${result.elapsed}ms`);
});

test('a connection dropped while reading the body is transient and recovers', async t => {
  const g = await gateway(t, { '/daemon/identities': (req, n) => n <= 2 ? 'reset-body' : healthy['/daemon/identities'](req) });
  const result = await run(t, g.base);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(g.calls['/daemon/identities'], 3);
});

// The deadline may cut the final attempt short, so its kind is the socket code
// or TIMEOUT; either way it is transient and never INVALID.
test('a persistently dropped body fails transiently with the socket code', async t => {
  const g = await gateway(t, { '/daemon/identities': () => 'reset-body' });
  const result = await run(t, g.base, { deadlineMs: 600 });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^gateway-readiness:authenticated-daemon:(UND_ERR_SOCKET|TIMEOUT):\d+:transient$/);
  assert.match(describeGatewayReadiness(result.stdout), /^authenticated-daemon, (UND_ERR_SOCKET|TIMEOUT); still not ready/);
  assert(g.calls['/daemon/identities'] >= 2, 'a dropped body must be retried');
});

test('a gateway that is not listening yet is waited for', async t => {
  const g = await gateway(t);
  const { port } = g.server.address();
  await new Promise(r => { g.server.closeAllConnections(); g.server.close(r); });
  const late = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url.replace(/^\/base/, '');
      const [status, body] = healthy[path](req);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    });
  });
  const timer = setTimeout(() => late.listen(port, '127.0.0.1'), 300);
  t.after(() => { clearTimeout(timer); late.closeAllConnections(); late.close(); });
  const result = await run(t, g.base);
  assert.equal(result.code, 0, result.stdout);
});

for (const [name, routes, stage, kind] of [
  ['rejected credential', { '/daemon/identities': () => [401, { error: 'unauthorized' }] }, 'authenticated-daemon', 'HTTP_401'],
  ['forbidden credential', { '/daemon/identities': () => [403, { error: 'forbidden' }] }, 'authenticated-daemon', 'HTTP_403'],
  ['another daemon instance', { '/daemon/selection': () => [200, { schema: 1, instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] }, 'selection', 'INVALID'],
  ['malformed 200', { '/daemon/identities': () => [200, '<html>ok</html>', 'text/html'] }, 'authenticated-daemon', 'INVALID'],
  ['identities of the wrong shape', { '/daemon/identities': () => [200, { identities: 'none' }] }, 'authenticated-daemon', 'INVALID'],
  ['management that accepts no credential', { '/cowork/management/rpc': () => [200, { version: 1, id: null, result: [] }] }, 'unauthenticated-management', 'HTTP_200'],
  ['an RPC error under a 503', { '/cowork/management/rpc': req => req.headers['x-ours-api-token']
    ? [503, { version: 1, id: 'installer-readiness', error: { code: 'unavailable', message: 'warming' } }] : [401, {}] }, 'authenticated-management', 'RPC_ERROR'],
]) test(`${name} fails at once without waiting`, async t => {
  const g = await gateway(t, routes);
  const result = await run(t, g.base, { deadlineMs: 5_000 });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, `gateway-readiness:${stage}:${kind}:1`);
  assert(result.elapsed < 2_000, `took ${result.elapsed}ms`);
  assert(describeGatewayReadiness(result.stdout).startsWith(`${stage}, `));
});

test('an HTML 502 at Cowork management is transient and recovers', async t => {
  const g = await gateway(t, { '/cowork/management/rpc': (req, n) => req.headers['x-ours-api-token'] && n < 5
    ? [502, '<html>502 Bad Gateway</html>', 'text/html'] : healthy['/cowork/management/rpc'](req) });
  const result = await run(t, g.base);
  assert.equal(result.code, 0, result.stdout);
});

test('output never contains the token or a response body', async t => {
  const g = await gateway(t, { '/daemon/identities': () => [503, `token=${TOKEN} secret-body-marker`, 'text/plain'] });
  const result = await run(t, g.base, { deadlineMs: 300 });
  assert.equal(result.code, 1);
  assert(!result.stdout.includes(TOKEN) && !result.stdout.includes('secret-body-marker'));
  assert(!result.stderr.includes(TOKEN) && !result.stderr.includes('secret-body-marker'));
});

test('an unreadable credential is terminal', async t => {
  const g = await gateway(t);
  const result = await run(t, g.base, { tokenPath: join(tmpdir(), 'absent-readiness-token') });
  assert.equal(result.stdout, 'gateway-readiness:credential:CHECK_FAILED:1');
});

test('verifyGateway runs the probe once in the daemon container and reports its diagnosis', async t => {
  const home = mkdtempSync(join(tmpdir(), 'readiness-effects-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'installation'); mkdirSync(root, { mode: 0o700 });
  const effects = realEffects({ home, env: {} });
  const record = effects.newInstallation(root, 'docker');
  record.gateway = { version: 1, serverUrl: `http://127.0.0.1:${record.port}` };
  const calls = [];
  effects.run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 1, stdout: 'gateway-readiness:authenticated-daemon:HTTP_503:58:transient' };
  };
  await assert.rejects(effects.verifyGateway(record),
    /Gateway readiness failed \(authenticated-daemon, HTTP 503; still not ready after 58 attempts over 60s\)\. Keep installation state intact/);
  // Retrying lives inside the read-only probe: one exec, no lifecycle or build command.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-6, -2), ['exec', '-T', 'daemon', 'node']);
  assert(!calls.some(call => call.some(arg => ['up', 'start', 'stop', 'restart', 'build', 'rm'].includes(arg))));
  effects.run = async () => ({ code: 1, stdout: 'unexpected' });
  await assert.rejects(effects.verifyGateway(record), /^Error: Gateway readiness failed\. Keep installation state intact/);
});
