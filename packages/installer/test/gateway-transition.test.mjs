import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableGateway } from '../lib/gateway-transition.mjs';
import { realEffects } from '../lib/effects.mjs';
import { parseNetworkArgs } from '../lib/target.mjs';
import { gatewayCompose, gatewayNginx } from '../lib/gateway.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'gateway-transition-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'installation'); mkdirSync(root, { mode: 0o700 });
  const record = realEffects({ home, env: {} }).newInstallation(root, 'docker');
  delete record.gateway; record.services = record.services.filter(name => name !== 'gateway');
  mkdirSync(record.workDir, { mode: 0o700 });
  mkdirSync(join(home, '.ours-client'), { mode: 0o700 });
  const profilePath = join(home, '.ours-client', 'profile.json');
  const recordPath = join(root, 'installation.json');
  const credentialPath = join(home, '.ours-client', 'credential');
  writeFileSync(credentialPath, 'retained-issued-fixture', { mode: 0o600 });
  const profile = { endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath, installer: { integrations: ['fleet'] } };
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  writeFileSync(join(record.workDir, 'docker-compose.yaml'), 'retained custom compose', { mode: 0o600 });
  const events = [];
  const effects = { home, readManagedClientProfile: () => JSON.parse(readFileSync(profilePath)),
    async qualifyGatewayRuntime() { events.push('qualify'); },
    async qualifyInstalledGatewayClient() { events.push('qualify-client'); },
    async prepareGateway(candidate) { events.push('prepare'); writeFileSync(join(record.workDir, 'nginx.conf'), gatewayNginx(candidate), { mode: 0o600 }); },
    async verifyGateway() { events.push('verify'); },
    async removeGatewayContainer() { events.push('remove'); },
    async serverLifecycle(selected, operation, services = selected.services) {
      events.push([operation, !!selected.gateway, services]);
      if (operation === 'status') return ['daemon', 'cowork'];
    },
  };
  return { home, root, record, profile, profilePath, recordPath, credentialPath, effects, events };
}

test('explicit gateway migration preserves credentials, custom compose and prior stopped services; rerun is read-only', async t => {
  const f = fixture(t);
  const args = parseNetworkArgs(['server', 'gateway-enable', '--state-dir', f.root, '--server-url', 'https://example.test/base/']);
  const candidate = await enableGateway(f.record, args, f.effects);
  assert.equal(candidate.gateway.serverUrl, 'https://example.test/base');
  const profile = JSON.parse(readFileSync(f.profilePath));
  assert.equal(profile.endpoint, 'https://example.test/base/daemon');
  assert.equal(profile.credentialPath, f.credentialPath);
  assert.deepEqual(profile.installer, f.profile.installer);
  assert.equal(readFileSync(f.credentialPath, 'utf8'), 'retained-issued-fixture');
  assert.equal(readFileSync(join(f.record.workDir, 'docker-compose.yaml'), 'utf8'), 'retained custom compose');
  assert(f.events.some(e => Array.isArray(e) && e[0] === 'stop' && e[1] && JSON.stringify(e[2]) === '["telegram","messenger"]'));
  f.events.length = 0;
  await enableGateway(candidate, args, f.effects);
  assert.deepEqual(f.events, ['verify']);
  assert.equal(existsSync(join(f.root, 'gateway-transition.json')), false);
});

for (const failure of ['qualifyGatewayRuntime', 'qualifyInstalledGatewayClient', 'prepareGateway', 'verifyGateway']) test(`migration failure at ${failure} retains exact prior config and credential`, async t => {
  const f = fixture(t);
  const originalRecord = readFileSync(f.recordPath), originalProfile = readFileSync(f.profilePath);
  f.effects[failure] = async () => { throw new Error('injected failure'); };
  await assert.rejects(enableGateway(f.record, {}, f.effects));
  assert.deepEqual(readFileSync(f.recordPath), originalRecord);
  assert.deepEqual(readFileSync(f.profilePath), originalProfile);
  assert.equal(readFileSync(f.credentialPath, 'utf8'), 'retained-issued-fixture');
  assert.equal(existsSync(join(f.record.workDir, 'nginx.conf')), false);
  assert.equal(existsSync(join(f.root, 'gateway-transition.json')), false);
  if (failure.startsWith('qualify')) assert(!f.events.some(e => Array.isArray(e) && e[0] === 'stop'));
  else assert.deepEqual(f.events.at(-1), ['start', false, ['daemon', 'cowork']]);
});

test('generated nested gateway keeps one loopback publication and configures real backend base/origin/listener', () => {
  const record = { project: 'ours-fixture', port: 3050, instanceId: '11111111-2222-3333-4444-555555555555', gateway: { version: 1, serverUrl: 'https://example.test/base' } };
  const compose = gatewayCompose(record), nginx = gatewayNginx(record);
  assert.match(compose, /OURS_TG_CONTROL_HOST: "0.0.0.0"/);
  assert.match(compose, /OURS_MESSENGER_BASE_PATH: "\/base\/messenger\/"/);
  assert.match(compose, /OURS_MESSENGER_PUBLIC_ORIGIN: "https:\/\/example.test"/);
  assert.equal((compose.match(/host_ip:/g) ?? []).length, 1);
  assert.match(compose, /host_ip: "127.0.0.1"/);
  assert.match(nginx, /location = \/base\/cowork\/rpc \{ return 403; \}/);
  assert.match(nginx, /rewrite \^\/base\/messenger\//);
  assert.throws(() => gatewayNginx({ ...record, gateway: { version: 1, serverUrl: 'https://example.test/bad%27path' } }));
});

test('failed legacy restart resumes rollback without requiring deleted candidate compose', async t => {
  const f = fixture(t);
  const lifecycle = f.effects.serverLifecycle;
  let failRestart = true;
  f.effects.prepareGateway = async () => { writeFileSync(join(f.record.workDir,'docker-compose.gateway.yaml'),'fixture',{mode:0o600}); };
  f.effects.verifyGateway = async () => { throw new Error('readiness failure'); };
  f.effects.serverLifecycle = async (record, operation, services) => {
    if (record.gateway && !existsSync(join(record.workDir,'docker-compose.gateway.yaml'))) throw new Error('candidate Compose absent');
    if (!record.gateway && operation === 'start' && failRestart) throw new Error('legacy restart failure');
    return lifecycle(record, operation, services);
  };
  await assert.rejects(enableGateway(f.record, {}, f.effects), /rollback failed/);
  const journal=join(f.root,'gateway-transition.json');
  assert.equal(JSON.parse(readFileSync(journal)).phase,'rollback-restarting');
  assert.equal(existsSync(join(f.record.workDir,'docker-compose.gateway.yaml')),false);
  failRestart=false;
  await assert.rejects(enableGateway(f.record, {}, f.effects), /Interrupted gateway migration rolled back/);
  assert.equal(existsSync(journal),false);
  assert.deepEqual(JSON.parse(readFileSync(f.recordPath)),f.record);
  assert.deepEqual(JSON.parse(readFileSync(f.profilePath)),f.profile);
});
