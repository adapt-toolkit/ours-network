import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayDiscovery, validateGatewayDiscovery, gatewayCompose, gatewayNginx, GATEWAY_SERVICES } from '../lib/gateway.mjs';
import { selectSourcePackages, SERVER_PACKAGES, NOTIFICATIONS_PACKAGE } from '../lib/plan.mjs';
import { realEffects } from '../lib/effects.mjs';

const base = { instanceId: '11111111-2222-3333-4444-555555555555', project: 'ours-test', port: 3050, coworkPort: 3052, mode: 'docker', gateway: { version: 1 } };
const without = { ...base, services: ['daemon', 'telegram', 'cowork', 'messenger', 'gateway'] };
const selected = { packages: { [NOTIFICATIONS_PACKAGE]: { type: 'npm', version: '0.3.1-nightly.1' } } };

test('the gateway route is authenticated and carries no notification secret', () => {
  const nginx = gatewayNginx({ ...without, gateway: { version: 1, serverUrl: 'https://ours.example/base' } });
  const route = nginx.match(/location \/base\/notifications\/ \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(route, 'notifications route');
  assert.match(route, /auth_request \/_server_auth;/);
  assert.match(route, /set \$notifications http:\/\/messenger:49677;/);
  assert.match(route, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.doesNotMatch(route, /Authorization|Bearer/i);
  assert.match(nginx, /location = \/base\/notifications \{ return 308 \/base\/notifications\/; \}/);
  // Required discovery is unchanged, so existing clients keep accepting this server.
  assert.deepEqual(gatewayDiscovery(without).services, GATEWAY_SERVICES);
  assert.doesNotThrow(() => validateGatewayDiscovery('http://127.0.0.1:3050', gatewayDiscovery(without), '/private/token'));
});

test('notifications live in the Messenger container: no new service, host port or secret in Compose', () => {
  const compose = gatewayCompose(without);
  assert.doesNotMatch(compose, /\n  notifications:/);
  const messenger = compose.match(/\n  messenger:\n[\s\S]*?(?=\n  [a-z]+:\n)/)?.[0];
  assert.match(messenger, /ports: !reset \[\]/);
  assert.match(messenger, /OURS_NOTIFICATIONS_CONFIG: \/var\/lib\/ours-notifications\/config.json/);
  assert.match(messenger, /target: \/var\/lib\/ours-notifications, volume: \{nocopy: true, subpath: state\/notifications\}/);
  assert.doesNotMatch(compose, /OURS_NOTIFICATIONS_PRODUCER_TOKEN|OURS_NOTIFICATIONS_ORIGIN/);
  assert.match(compose, /\n  prepare:\n    environment:\n      OURS_NOTIFICATIONS: "1"/);
  assert.match(compose, /target: \/credentials\/fleet-notifications, read_only: true/);
});

test('an update prepares stored state for the activated runtime before restoring services', async t => {
  const { serverBuildTransition } = await import('../lib/build-transition.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ours-notifications-update-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const record = realEffects({ home, env: {} }).newInstallation(join(home, 'docker'), 'docker');
  const candidate = { ...record, root: join(record.root, '.build-abcdef'), project: 'ours-build' + '0'.repeat(32) };
  Object.assign(candidate, { workDir: join(candidate.root, 'runtime'), sourcesPath: join(candidate.root, 'sources.json'), configPath: join(candidate.root, 'storage/state/daemon/config.json') });
  const events = [];
  const effects = {
    out() {},
    prepareServerBuild: async () => candidate,
    checkServerBuild: async () => {},
    discardServerBuild: async () => {},
    retireServerBuildRuntime: async () => {},
    updateServerBuildState: async () => {},
    publishServerBuild: async () => { events.push('publish'); },
    validateServerBuildState: async () => {},
    prepareServerVolumes: async () => { events.push('prepare'); },
    verifyGateway: async () => {},
    serverLifecycle: async (_selection, operation, services) => operation === 'status' ? ['daemon', 'messenger'] : events.push(['start', services]),
    writeJson: () => {},
  };
  await serverBuildTransition(record, { operation: 'update' }, effects);
  assert.deepEqual(events, ['publish', 'prepare', ['start', ['daemon', 'messenger']]]);
});

test('server source selection adds notifications when the policy names it and keeps older policies valid', () => {
  const older = { packages: Object.fromEntries(SERVER_PACKAGES.map(name => [name, { type: 'npm', version: '1.0.0' }])) };
  assert.deepEqual(Object.keys(selectSourcePackages(older, 'server')), SERVER_PACKAGES);
  const current = { packages: { ...older.packages, ...selected.packages } };
  assert.deepEqual(Object.keys(selectSourcePackages(current, 'server')), [...SERVER_PACKAGES, NOTIFICATIONS_PACKAGE]);
});

test('client import publishes the bound producer credential beside the profile credential, or refuses a mismatched one', async t => {
  const { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'ours-notifications-client-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const issued = join(home, 'issued'); mkdirSync(issued, { mode: 0o700 });
  writeFileSync(join(issued, 'credential'), 'c'.repeat(43), { mode: 0o600 });
  const profile = { serverUrl: 'http://127.0.0.1:3050', endpoint: 'http://127.0.0.1:3050/daemon', expectedInstanceId: base.instanceId, credentialPath: join(issued, 'credential') };
  const producer = (fields) => { const path = join(issued, 'notifications-producer.json'); writeFileSync(path, JSON.stringify({ schema: 1, serverUrl: profile.serverUrl, expectedInstanceId: profile.instanceId ?? base.instanceId, token: 'p'.repeat(43), ...fields }), { mode: 0o600 }); return path; };
  const effects = realEffects({ home, env: {} });
  const input = { profile, sources: { packages: {} }, integrations: ['fleet'] };
  assert.throws(() => effects.importClientProfile({ ...input, notificationsProducerPath: producer({ expectedInstanceId: '99999999-2222-3333-4444-555555555555' }) }), /does not match the selected server/);
  assert.equal(existsSync(join(home, '.ours-client', 'profile.json')), false);
  const path = producer({});
  assert.equal(effects.importClientProfile({ ...input, notificationsProducerPath: path }).notificationsProducerChanged, true);
  assert.equal(effects.importClientProfile({ ...input, notificationsProducerPath: path }).notificationsProducerChanged, false);
  const published = join(home, '.ours-client', 'notifications-producer.json');
  assert.equal(readFileSync(published, 'utf8'), readFileSync(path, 'utf8'));
  assert.equal(statSync(published).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(home, '.ours-client', 'profile.json'), 'utf8')).credentialPath, join(home, '.ours-client', 'credential'));
});
