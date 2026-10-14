// Cross-repository release qualification. Uses only disposable local state and a
// local test broker; set the four built checkout paths listed below explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayNginx } from '../lib/gateway.mjs';

test('real services and Fleet work through nginx and an authenticated browser entry', { skip: process.env.OURS_TEST_GATEWAY_SERVICES !== '1', timeout: 180000 }, async t => {
  const roots = Object.fromEntries(['COWORK', 'FLEET', 'MESSENGER', 'TELEGRAM'].map(name => {
    assert(process.env[`OURS_TEST_${name}_ROOT`], `OURS_TEST_${name}_ROOT required`);
    return [name, process.env[`OURS_TEST_${name}_ROOT`]];
  }));
  const load = path => import(pathToFileURL(path).href);
  const { command, startProcess, stopProcess, unusedPort, waitFor, waitForPort } = await load(join(roots.COWORK, 'tests/fixtures/v1-runtime.mjs'));
  const { attachOursClient } = await load(join(roots.COWORK, 'node_modules/@ours.network/sdk/dist/client.js'));
  const { createCoworkAdapter } = await load(join(roots.FLEET, 'dist/rooms-tasks/cowork-adapter.js'));
  const state = mkdtempSync(join(tmpdir(), 'ours-real-gateway-'));
  const processes = [], clients = [];
  const container = `ours-real-gateway-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  let nginxStarted = false;
  t.after(async () => {
    if (nginxStarted) docker(['rm', '-f', container]);
    for (const client of clients.reverse()) { await client.releaseLease().catch(() => {}); await client.close().catch(() => {}); }
    for (const child of processes.reverse()) await stopProcess(child);
    rmSync(state, { recursive: true, force: true });
  });
  const [brokerPort, daemonPort, coworkPort, messengerPort, telegramPort, gatewayPort, entryPort] = await Promise.all(Array.from({ length: 7 }, () => unusedPort()));
  const endpoint = `http://127.0.0.1:${daemonPort}`, origin = `http://127.0.0.1:${entryPort}`, base = origin + '/base';
  const instance = randomUUID(), daemonState = join(state, 'daemon'), credentialPath = join(daemonState, 'daemon-token');
  mkdirSync(daemonState, { mode: 0o700 });
  const configPath = join(state, 'daemon.json');
  writeFileSync(configPath, JSON.stringify({ brokerUrl: `ws://127.0.0.1:${brokerPort}`, port: daemonPort, stateDir: daemonState, apiVisibility: 'owner', apiTokenDeliveryFiles: [] }), { mode: 0o600 });
  const clean = { ...process.env, HOME: state };
  for (const key of Object.keys(clean)) if (key.startsWith('OURS_')) delete clean[key];
  const launch = (args, env, cwd) => { const child = startProcess(args, { ...clean, ...env }, cwd); processes.push(child); return child; };
  launch([join(roots.COWORK, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], {}, roots.COWORK);
  await waitForPort(brokerPort);
  const daemon = launch([join(roots.COWORK, 'node_modules/@ours.network/daemon/dist/cli.js'), 'daemon', 'serve'], { OURS_CONFIG: configPath, OURS_DAEMON_ID: instance }, roots.COWORK);
  await waitFor(async () => {
    assert.equal(daemon.child.exitCode, null, daemon.stderr);
    return existsSync(credentialPath) && (await fetch(endpoint + '/selection')).ok;
  }, 'isolated daemon', 60000);
  const owner = await attachOursClient({ endpoint, expectedInstanceId: instance, credentialPath, sessionMode: 'external', leaseToken: randomUUID(), env: {} }); clients.push(owner);
  await owner.createRootIdentity({ name: 'GatewayFixtureRoot', bio: 'Isolated gateway test', exposeLocal: false });
  const messengerOwner = await attachOursClient({ endpoint, expectedInstanceId: instance, credentialPath, sessionMode: 'external', leaseToken: randomUUID(), env: {} });
  await messengerOwner.createIdentity({ name: 'GatewayFixtureMessenger', bio: 'Isolated browser test', exposeLocal: false });
  await messengerOwner.releaseLease();
  await messengerOwner.close();
  const common = { OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: instance, OURS_DAEMON_CREDENTIAL_PATH: credentialPath };
  const coworkConfig = join(state, 'cowork.json');
  writeFileSync(coworkConfig, JSON.stringify({ version: 1, stateDir: join(state, 'cowork'), rest: { enabled: true, host: '127.0.0.1', port: coworkPort } }), { mode: 0o600 });
  const cowork = launch([join(roots.COWORK, 'dist/cli.js'), 'serve'], { ...common, OURS_COWORK_CONFIG: coworkConfig, OURS_COWORK_HTTP_MANAGEMENT: '1', OURS_COWORK_PUBLIC_ORIGIN: origin }, roots.COWORK);
  const messenger = launch([join(roots.MESSENGER, 'dist/cli.js'), 'serve'], { ...common, OURS_MESSENGER_IDENTITY: 'GatewayFixtureMessenger', OURS_MESSENGER_HOST: '127.0.0.1', OURS_MESSENGER_PORT: String(messengerPort), OURS_MESSENGER_PUBLIC_ORIGIN: origin, OURS_MESSENGER_BASE_PATH: '/base/messenger/', OURS_MESSENGER_STATE_DIR: join(state, 'messenger') }, roots.MESSENGER);
  const telegram = launch([join(roots.TELEGRAM, 'dist/cli.js'), 'serve'], { OURS_TG_CONFIG: join(state, 'telegram.json'), OURS_TG_STATE_DIR: join(state, 'telegram'), OURS_TG_CONTROL_PORT: String(telegramPort), OURS_TG_CONTROL_HOST: '127.0.0.1', OURS_TG_DAEMON_URL: endpoint, OURS_TG_DAEMON_ID: instance, OURS_TG_DAEMON_CREDENTIAL_PATH: credentialPath }, roots.TELEGRAM);
  console.log('Isolated daemon and service processes started');
  for (const [child, port, path] of [[cowork, coworkPort, '/client-config'], [messenger, messengerPort, '/api/healthz'], [telegram, telegramPort, '/health']]) await waitFor(async () => {
    assert.equal(child.child.exitCode, null, child.stdout + child.stderr);
    return (await fetch(`http://127.0.0.1:${port}${path}`)).ok;
  }, `real backend ${port}`, 45000);

  console.log('All real backends ready');
  let nginx = gatewayNginx({ instanceId: instance, port: gatewayPort, coworkPort, gateway: { version: 1, serverUrl: base } });
  nginx = nginx.replace('listen 8080;', `listen 127.0.0.1:${gatewayPort};`);
  for (const [name, from, to] of [['daemon', 3050, daemonPort], ['cowork', coworkPort, coworkPort], ['messenger', 8420, messengerPort], ['telegram', 3051, telegramPort]]) nginx = nginx.replaceAll(`http://${name}:${from}`, `http://127.0.0.1:${to}`);
  const proxy = `proxy_pass http://127.0.0.1:${gatewayPort}; proxy_set_header Host $http_host; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; proxy_http_version 1.1;`;
  nginx = nginx.replace(/\n}\n$/, `\n server {
    listen 127.0.0.1:${entryPort};
    auth_basic "ours operator"; auth_basic_user_file /etc/nginx/gateway-passwd;
    location = /base/.well-known/ours { auth_basic off; ${proxy} }
    location /base/daemon/ { auth_basic off; ${proxy} }
    location = /base/cowork/management/rpc { auth_basic off; ${proxy} }
    location /base/tg-connector/ { auth_basic off; ${proxy} }
    location / { ${proxy} }
  }\n}\n`);
  writeFileSync(join(state, 'nginx.conf'), nginx, { mode: 0o644 });
  const password = 'fixture-password';
  const hash = execFileSync('openssl', ['passwd', '-apr1', password], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'htpasswd'), 'fixture:' + hash + '\n', { mode: 0o644 });
  const nginxImage = readFileSync(new URL('../assets/Dockerfile.gateway', import.meta.url), 'utf8').split('\n')[0].slice(5);
  docker(['run', '-d', '--name', container, '--network', 'host', '--read-only', '--tmpfs', '/tmp', '-v', `${state}:/fixture:ro`, '-v', `${join(state, 'htpasswd')}:/etc/nginx/gateway-passwd:ro`, '--entrypoint', 'nginx', nginxImage, '-c', '/fixture/nginx.conf', '-g', 'daemon off;']); nginxStarted = true;
  await waitFor(async () => (await fetch(base + '/.well-known/ours')).ok, 'gateway discovery');
  const profilePath = join(state, 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ serverUrl: base, endpoint: base + '/daemon', expectedInstanceId: instance, credentialPath }), { mode: 0o600 });
  const adapter = createCoworkAdapter({ env: { OURS_CONFIG: profilePath, HOME: state } });
  assert.deepEqual(await adapter.listRooms(), []);
  const room = await adapter.createRoom({ room_name: 'Gateway test', goal: 'Integration', briefing: 'Disposable local fixture' });
  assert.equal((await adapter.getRoom(room.room_id)).room_id, room.room_id);
  const token = readFileSync(credentialPath, 'utf8').trim();
  assert.equal((await fetch(base + '/cowork/management/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/tg-connector/health')).status, 401);
  assert.equal((await fetch(base + '/tg-connector/health', { headers: { 'x-ours-api-token': token } })).status, 200);
  const browserHeaders = { authorization: 'Basic ' + Buffer.from('fixture:' + password).toString('base64'), origin };
  assert.equal((await fetch(base + '/messenger/api/healthz')).status, 401);
  assert.equal((await fetch(base + '/messenger/api/healthz', { headers: browserHeaders })).status, 200);
  const html = await fetch(base + '/messenger/', { headers: browserHeaders }).then(r => r.text());
  assert.match(html, /content="\/base\/messenger\/"/);
  for (const asset of [...html.matchAll(/(?:src|href)="(\/base\/messenger\/[^" ]+)"/g)].map(match => match[1])) assert.equal((await fetch(origin + asset, { headers: browserHeaders })).status, 200);
  assert.equal((await fetch(base + '/messenger/sw.js', { headers: browserHeaders })).status, 200);
  const consoleHtml = await fetch(base + '/cowork/', { headers: browserHeaders }).then(r => r.text());
  assert.match(consoleHtml, /\.\/assets\/app.js/);
  assert.equal((await fetch(base + '/cowork/assets/app.js', { headers: browserHeaders })).status, 200);
  assert.equal((await fetch(base + '/cowork/browser/rpc', { method: 'POST', headers: { ...browserHeaders, 'x-ours-api-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, id: 'browser', method: 'room.list', params: {} }) })).status, 200);
  assert.equal((await fetch(base + '/cowork/rpc', { method: 'POST', headers: { ...browserHeaders, host: `localhost:${coworkPort}` }, body: '{}' })).status, 403);
  const { WebSocket } = await load(join(roots.MESSENGER, 'node_modules/ws/wrapper.mjs'));
  const wsUrl = base.replace('http:', 'ws:') + '/messenger/api/presence';
  const denied = new WebSocket(wsUrl, { origin });
  await new Promise((resolve, reject) => {
    denied.once('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 401); response.resume(); denied.terminate(); resolve(); });
    denied.once('open', () => { denied.close(); reject(new Error('Unauthenticated Messenger WebSocket accepted')); });
    denied.on('error', () => {});
  });
  const allowed = new WebSocket(wsUrl, { origin, headers: { authorization: browserHeaders.authorization } });
  await new Promise((resolve, reject) => { allowed.once('open', resolve); allowed.once('error', reject); });
  allowed.close();
  const { chromium } = await load(join(roots.COWORK, 'node_modules/playwright-core/index.mjs'));
  const browser = await chromium.launch({ executablePath: process.env.OURS_TEST_BROWSER ?? '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ httpCredentials: { username: 'fixture', password } });
    const page = await context.newPage();
    const failedAssets = [];
    page.on('response', response => { if (response.url().includes('/assets/') && response.status() >= 400) failedAssets.push(response.url()); });
    await page.goto(base + '/cowork/');
    await page.getByLabel('Server credential', { exact: true }).fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Server credential', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.reload();
    assert.equal(await page.getByLabel('Server credential', { exact: true }).inputValue(), '');
    await page.goto(base + '/messenger/');
    await page.waitForFunction(() => document.getElementById('root')?.childElementCount > 0);
    assert.deepEqual(failedAssets, []);
    const registrations = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      return (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope);
    });
    assert(registrations.every(scope => scope === base + '/messenger/'));
    await context.close();
  } finally { await browser.close(); }
  await adapter.closeRoom(room.room_id);
  await adapter.deleteRoom(room.room_id);
  assert.deepEqual(await adapter.listRooms(), []);
  console.log('Real daemon, Cowork, Messenger, Telegram and Fleet passed through nested nginx paths and authenticated browser entry');
});
